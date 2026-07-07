import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import { invoke } from "@/lib/ipc";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./Button";
import { Tag } from "./Tag";
import { Icon } from "./Icon";
import { PermissionRow } from "./PermissionRow";
import { CapabilityPlaceholder } from "./CapabilityPlaceholder";
import { AdoptionDialog } from "./AdoptionDialog";
import { ImportMergeDialog } from "./ImportMergeDialog";
import { DisableDialog } from "./DisableDialog";
import { PermissionsDoctorPanel } from "./PermissionsDoctorPanel";
import { ConfirmDialog } from "./Modal";
import { PresetsSheet } from "./PresetsSheet";
import { ResizableSplit } from "./ResizableSplit";
import { HarnessAffinityChips, type ChipState } from "./HarnessAffinityChips";
import { HarnessGlyph, HarnessIconGroup } from "./harness/HarnessGlyph";
import { harnessLabel } from "./harness/harnessRegistry";
import {
	TIER_META,
	TIER_ORDER,
	classifyTier,
	type PermissionTier,
} from "@/lib/permissionTiers";
import {
	filtersEqual,
	ruleMatchesFilter,
	type HarnessFilter,
} from "@/lib/permissionHarnessFilter";
import { useRegistry } from "@/hooks/useRegistry";
import {
	getAdoptionRequired,
	permissionsKey,
	usePermissionCapabilities,
	usePermissionRisksSchema,
	usePermissions,
	usePermissionsDoctor,
} from "@/hooks/usePermissions";
import {
	detectRisks,
	findingsByPattern,
	worstSeverity,
} from "@/lib/permissionsRisks";
import { evaluateDecisionForHarness } from "@/lib/permissionDecision";
import { BUILTIN_PRESETS } from "@/lib/permissionPresets";
import {
	bashPrefixTokens,
	codexDecision,
	scopeLabel,
	stripResolverFields,
	type Hook,
	type NormalizedPermissions,
	type PermissionFeature,
	type RiskFinding,
	type Rule,
	type RuleKind,
	type Scope,
	type ValidateResult,
} from "@/types/permissions";

export interface PermissionScopeOption {
	key: string;
	label: string;
	scope: Scope;
	active: boolean;
	hint?: string;
}

/**
 * Header-relevant editor state + actions, handed to the entry point so it can
 * build its own `<ScreenHeader>`. The editor body owns the state; the chrome is
 * a pure projection of it. See `GlobalPermissions` / `ProjectPermissionsTab`.
 */
export interface PermissionsChrome {
	scope: Scope;
	/** True while the initial fetch is in flight — hosts keep their header
	 *  mounted and render placeholder counts instead of unmounting the chrome. */
	loading: boolean;
	dirty: boolean;
	saving: boolean;
	savedJustNow: boolean;
	pendingSync: boolean;
	saveDisabled: boolean;
	saveTooltip?: string;
	/** allow + deny + ask */
	ruleCount: number;
	hookCount: number;
	riskCount: number;
	/** Project scope: number of rules/hooks inherited from global. */
	inheritedCount: number;
	save: () => void;
	discard: () => void;
	openDoctor: () => void;
	copyToml: () => void;
	openDisable: () => void;
	/** Host-owned scope switcher (global screen renders these as SCOPE chips). */
	scopeOptions?: PermissionScopeOption[];
	onSelectScope?: (scope: Scope) => void;
}

export interface PermissionsEditorProps {
	scope: Scope;
	/** Number of registered projects — drives the `All projects (N)` label in DisableDialog. */
	projectCount: number;
	/** Optional banner block (e.g. per-project "Imported N rules" inline banner). */
	banner?: ReactNode;
	/** Host-owned scope switcher. Passed through to `chrome` for the entry-point header. */
	scopeOptions?: PermissionScopeOption[];
	onSelectScope?: (scope: Scope) => void;
	/**
	 * Renders the screen chrome (`<ScreenHeader>`) above the editor body. The
	 * editor itself renders only the rules grid + side panel + doctor.
	 */
	renderChrome?: (chrome: PermissionsChrome) => ReactNode;
}

const KINDS: RuleKind[] = ["allow", "deny", "ask"];
type PermissionFilter = "all" | RuleKind | "hooks";

const KIND_META: Record<
	RuleKind | "hooks",
	{
		label: string;
		accent: string;
		icon: "check" | "x" | "eye" | "bolt";
		help: string;
	}
> = {
	allow: {
		label: "ALLOW",
		accent: "var(--green)",
		icon: "check",
		help: "Auto-approved, never prompts",
	},
	deny: {
		label: "DENY",
		accent: "var(--red)",
		icon: "x",
		help: "Always blocked, no override",
	},
	ask: {
		label: "ASK",
		accent: "var(--amber)",
		icon: "eye",
		help: "Prompts the user before running",
	},
	hooks: {
		label: "HOOKS",
		accent: "var(--violet)",
		icon: "bolt",
		help: "Shell commands fired on tool events",
	},
};

function payloadsEqual(
	a: NormalizedPermissions,
	b: NormalizedPermissions,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function harnessLabelMap(installed: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of installed) out[id] = harnessLabel(id);
	return out;
}

export function PermissionsEditor({
	scope,
	projectCount,
	banner,
	scopeOptions,
	onSelectScope,
	renderChrome,
}: PermissionsEditorProps) {
	const queryClient = useQueryClient();

	// Project-only "Shared ⇄ Personal" tier toggle. Personal = the uncommitted
	// `permissions_local` block (Claude → .claude/settings.local.json). Reset to
	// Shared whenever the active scope changes (global has no personal tier).
	const [personal, setPersonal] = useState(false);
	useEffect(() => {
		setPersonal(false);
	}, [scope.kind, scope.kind === "project" ? scope.name : null]);
	const personalActive = scope.kind === "project" && personal;

	const permsQuery = usePermissions(scope, true, personalActive);
	const capsQuery = usePermissionCapabilities();
	const risksSchemaQuery = usePermissionRisksSchema();
	// For project scope, also load global permissions so BehaviorCard can render
	// inheritance notes for unset draft fields.
	const globalPermsForInheritance = usePermissions(
		{ kind: "global" },
		scope.kind === "project",
	);
	const registry = useRegistry();
	const [draft, setDraft] = useState<NormalizedPermissions | null>(null);
	const [baseline, setBaseline] = useState<NormalizedPermissions | null>(null);
	const [validation, setValidation] = useState<Record<string, ValidateResult>>(
		{},
	);
	const [savedJustNow, setSavedJustNow] = useState(false);
	const [saving, setSaving] = useState(false);
	// D4/F18: Codex-trust save-time confirm. Set when a project save is intercepted
	// because it would auto-grant Codex `trust_level="trusted"`.
	const [trustConfirmOpen, setTrustConfirmOpen] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [pendingSync, setPendingSync] = useState(false);
	const [duplicateCollapsed, setDuplicateCollapsed] = useState(0);
	const [showDisable, setShowDisable] = useState(false);
	const [showDoctor, setShowDoctor] = useState(false);
	const [showPresets, setShowPresets] = useState(false);
	const [showImport, setShowImport] = useState(false);
	const [filter, setFilter] = useState<PermissionFilter>("all");
	const [harnessFilter, setHarnessFilter] = useState<HarnessFilter>("all");
	const [search, setSearch] = useState("");
	const [focusTarget, setFocusTarget] = useState<string | null>(null);
	const sectionRef = useRef<HTMLDivElement | null>(null);
	const doctorQuery = usePermissionsDoctor(showDoctor);

	// Every permissions mutation lives in the registry, so refresh both the
	// per-scope permissions query AND the registry query. Pass explicit scopes
	// for a cross-scope op (e.g. "disable all projects") so each one refreshes.
	const invalidatePerms = useCallback(
		(scopes?: Scope[]) => {
			const targets = scopes && scopes.length > 0 ? scopes : [scope];
			for (const s of targets) {
				// For the active project scope, invalidate the tier (Shared/Personal)
				// currently in view; other scopes use their default (shared) key.
				const isActive =
					s.kind === scope.kind &&
					(s.kind === "global" ||
						(scope.kind === "project" && s.name === scope.name));
				void queryClient.invalidateQueries({
					queryKey: permissionsKey(s, isActive && personalActive),
				});
			}
			void queryClient.invalidateQueries({ queryKey: ["registry"] });
		},
		[queryClient, scope, personalActive],
	);

	useEffect(() => {
		if (!permsQuery.data) return;
		const loaded = stripResolverFields(
			permsQuery.data as NormalizedPermissions,
		);
		const data = permsQuery.data as NormalizedPermissions;
		setDuplicateCollapsed(data.duplicate_collapsed ?? 0);
		const attachOrigin = <T extends { origin?: "global" | "project" }>(
			stripped: T[],
			withOrigin: T[],
		): T[] => stripped.map((s, i) => ({ ...s, origin: withOrigin[i]?.origin }));
		const displayDraft: NormalizedPermissions = {
			...loaded,
			allow: attachOrigin(loaded.allow, data.allow),
			deny: attachOrigin(loaded.deny, data.deny),
			ask: attachOrigin(loaded.ask, data.ask),
			hooks: attachOrigin(loaded.hooks, data.hooks),
		};
		setDraft(displayDraft);
		setBaseline(displayDraft);
		setSaveError(null);
	}, [permsQuery.data]);

	const installed = useMemo(
		() => Object.keys(capsQuery.data ?? {}).sort(),
		[capsQuery.data],
	);
	const harnessLabels = useMemo(() => harnessLabelMap(installed), [installed]);
	const capabilities = capsQuery.data ?? {};
	const dirty = useMemo(
		() =>
			!!draft &&
			!!baseline &&
			!payloadsEqual(stripResolverFields(draft), stripResolverFields(baseline)),
		[draft, baseline],
	);
	const risks = useMemo(
		() =>
			!draft || !risksSchemaQuery.data
				? []
				: detectRisks(draft, risksSchemaQuery.data),
		[draft, risksSchemaQuery.data],
	);
	const risksIndex = useMemo(() => findingsByPattern(risks), [risks]);
	const sectionSeverity = worstSeverity(risks);
	// Type-to-filter pool for each rule's pattern field: every pattern already in
	// the draft plus the built-in preset catalog, de-duped. The row's autocomplete
	// hook drops the exact-match candidate (the row's own pattern) itself.
	const patternSuggestions = useMemo(() => {
		const pool = new Set<string>();
		for (const preset of BUILTIN_PRESETS)
			for (const r of preset.rules) pool.add(r.pattern);
		if (draft)
			for (const kind of ["allow", "deny", "ask"] as const)
				for (const r of draft[kind]) if (r.pattern) pool.add(r.pattern);
		return [...pool];
	}, [draft]);
	// Client-side shadowing (project scope): a project-owned `allow` whose pattern
	// also appears in an INHERITED global `deny` is dead — deny wins, so the allow
	// never takes effect. We compute it from the draft (which carries inherited
	// globals tagged origin:"global" alongside project rows). Patterns matched
	// against the global-deny set; project denies on the same pattern would also
	// shadow, but those are already a CONTRADICTORY_RULE risk, so scope this to
	// the cross-scope case the doctor's `shadowed_by_deny` field models.
	const shadowedAllowPatterns = useMemo(() => {
		if (scope.kind !== "project") return new Set<string>();
		const globalDeny = new Set(
			draft?.deny
				.filter((r) => r.origin === "global")
				.map((r) => r.pattern) ?? [],
		);
		const out = new Set<string>();
		for (const r of draft?.allow ?? []) {
			if (globalDeny.has(r.pattern)) out.add(r.pattern);
		}
		return out;
	}, [draft, scope.kind]);
	const adoptionRequired = getAdoptionRequired(permsQuery.data);
	const adoptionBlocking = scope.kind === "global" && adoptionRequired !== null;
	const validationErrors = Object.entries(validation).filter(([, v]) => !v.ok);
	const saveDisabled =
		!dirty || saving || validationErrors.length > 0 || adoptionBlocking;
	const validateTimers = useRef<Record<string, number>>({});
	const unmounted = useRef(false);
	useEffect(
		() => () => {
			unmounted.current = true;
			for (const t of Object.values(validateTimers.current))
				window.clearTimeout(t);
		},
		[],
	);

	const scheduleValidation = useCallback(
		(key: string, kind: RuleKind, pattern: string) => {
			if (validateTimers.current[key])
				window.clearTimeout(validateTimers.current[key]);
			validateTimers.current[key] = window.setTimeout(async () => {
				try {
					const v = await invoke<ValidateResult>("permissions_validate", {
						kind,
						pattern,
					});
					if (unmounted.current) return;
					setValidation((cur) => ({ ...cur, [key]: v }));
				} catch (e) {
					if (unmounted.current) return;
					setValidation((cur) => ({
						...cur,
						[key]: { ok: false, error: String(e) },
					}));
				}
			}, 200);
		},
		[],
	);

	function updateRule(kind: RuleKind, index: number, next: Rule) {
		if (!draft) return;
		const list = [...draft[kind]];
		list[index] = next;
		setDraft({ ...draft, [kind]: list });
		if (next.pattern)
			scheduleValidation(`${kind}:${index}`, kind, next.pattern);
	}
	function deleteRule(kind: RuleKind, index: number) {
		if (!draft) return;
		setDraft({ ...draft, [kind]: draft[kind].filter((_, i) => i !== index) });
		setValidation((cur) => {
			const next = { ...cur };
			delete next[`${kind}:${index}`];
			return next;
		});
	}
	function addRule(kind: RuleKind, opts?: { keepFilter?: boolean }) {
		if (!draft) return;
		const nextIndex = draft[kind].length;
		setDraft({
			...draft,
			[kind]: [...draft[kind], { pattern: "", kind } as Rule],
		});
		// The kind filter is narrowed when the add originates from a kind-scoped
		// affordance (the toolbar split menu / stat hero). A per-TIER section Add
		// must NOT clobber the current view: tiers are a risk grouping orthogonal
		// to kind, and forcing `filter=allow` would hide every deny/ask rule.
		if (!opts?.keepFilter) setFilter(kind);
		setFocusTarget(`${kind}:${nextIndex}`);
	}
	function promoteRule(kind: RuleKind, index: number) {
		if (!draft) return;
		const inherited = draft[kind][index];
		if (!inherited) return;
		const copy: Rule = {
			pattern: inherited.pattern,
			kind: inherited.kind,
			harnesses:
				inherited.harnesses === undefined
					? null
					: inherited.harnesses
						? [...inherited.harnesses]
						: null,
			origin: "project",
		};
		setDraft({ ...draft, [kind]: [...draft[kind], copy] });
		setFilter(kind);
	}
	/**
	 * Move a rule between kind lists (allow ↔ ask ↔ deny) in place — preserving
	 * pattern, harness affinity and origin. The rule's `kind` field is rewritten
	 * so the draft stays internally consistent (it lives in `draft[toKind]`).
	 */
	function changeRuleKind(fromKind: RuleKind, index: number, toKind: RuleKind) {
		if (!draft || fromKind === toKind) return;
		const moving = draft[fromKind][index];
		if (!moving) return;
		const moved: Rule = { ...moving, kind: toKind };
		const nextFrom = draft[fromKind].filter((_, i) => i !== index);
		const nextTo = [...draft[toKind], moved];
		setDraft({ ...draft, [fromKind]: nextFrom, [toKind]: nextTo });
		setValidation((cur) => {
			const next = { ...cur };
			delete next[`${fromKind}:${index}`];
			return next;
		});
		setFilter("all");
		if (moved.pattern)
			scheduleValidation(`${toKind}:${nextTo.length - 1}`, toKind, moved.pattern);
	}
	/**
	 * Move a project-owned rule UP to the global scope. This is a genuine
	 * cross-scope move that the staged single-scope save model cannot express in
	 * one transaction, so it writes immediately: append to global via
	 * `permissions_set({kind:"global"})`, then drop the row from the project draft
	 * and save the project block. The two writes are sequential (NOT atomic — see
	 * report); on a global-write failure the project draft is left untouched.
	 */
	async function demoteRuleToGlobal(kind: RuleKind, index: number) {
		if (!draft || scope.kind !== "project" || saving) return;
		const moving = draft[kind][index];
		if (!moving || moving.origin === "global") return;
		setSaving(true);
		setSaveError(null);
		try {
			// 1. Read current global block, append the moved rule (dedupe on
			//    pattern+kind), and write global.
			const globalScope: Scope = { kind: "global" };
			const current = stripResolverFields(
				(await invoke<NormalizedPermissions>("permissions_show", {
					scope: globalScope,
				})) as NormalizedPermissions,
			);
			const ruleForGlobal: Rule = {
				pattern: moving.pattern,
				kind,
				...(moving.harnesses ? { harnesses: [...moving.harnesses] } : {}),
			};
			const alreadyThere = current[kind].some(
				(r) => r.pattern === ruleForGlobal.pattern,
			);
			const nextGlobal: NormalizedPermissions = alreadyThere
				? current
				: { ...current, [kind]: [...current[kind], ruleForGlobal] };
			await invoke("permissions_set", {
				scope: globalScope,
				payload: nextGlobal,
			});
			// 2. Drop the rule from the project draft and persist the project block.
			const nextProject: NormalizedPermissions = {
				...draft,
				[kind]: draft[kind].filter((_, i) => i !== index),
			};
			const result = await invoke<{
				changed: boolean;
				normalized: NormalizedPermissions;
			}>("permissions_set", {
				scope,
				payload: stripResolverFields(nextProject),
				personal: personalActive,
			});
			const next = result.normalized;
			setDraft(next);
			setBaseline(next);
			setSavedJustNow(true);
			window.setTimeout(() => setSavedJustNow(false), 2200);
			setPendingSync(true);
			invalidatePerms([globalScope, scope]);
		} catch (e) {
			setSaveError(String(e));
		} finally {
			setSaving(false);
		}
	}
	function updateHook(index: number, next: Hook) {
		if (!draft) return;
		const list = [...draft.hooks];
		list[index] = next;
		setDraft({ ...draft, hooks: list });
	}
	function promoteHook(index: number) {
		if (!draft) return;
		const inherited = draft.hooks[index];
		if (!inherited) return;
		const copy: Hook = {
			event: inherited.event,
			matcher: inherited.matcher,
			command: inherited.command,
			harnesses:
				inherited.harnesses === undefined
					? null
					: inherited.harnesses
						? [...inherited.harnesses]
						: null,
			origin: "project",
		};
		setDraft({ ...draft, hooks: [...draft.hooks, copy] });
		setFilter("hooks");
	}
	function deleteHook(index: number) {
		if (!draft) return;
		setDraft({ ...draft, hooks: draft.hooks.filter((_, i) => i !== index) });
	}
	function addHook() {
		if (!draft) return;
		const nextIndex = draft.hooks.length;
		setDraft({
			...draft,
			hooks: [
				...draft.hooks,
				{ event: "PreToolUse", matcher: "", command: "" },
			],
		});
		setFilter("hooks");
		setFocusTarget(`hook:${nextIndex}`);
	}
	function discardChanges() {
		if (!baseline || !draft) return;
		const changedCount =
			Math.abs(draft.allow.length - baseline.allow.length) +
			Math.abs(draft.deny.length - baseline.deny.length) +
			Math.abs(draft.ask.length - baseline.ask.length) +
			Math.abs(draft.hooks.length - baseline.hooks.length);
		if (
			changedCount >= 5 &&
			!window.confirm(
				`Discard ${changedCount} staged changes? This cannot be undone.`,
			)
		)
			return;
		setDraft(baseline);
		setValidation({});
	}
	/**
	 * Codex-trust save-time confirm predicate (frozen contract, D4/F18):
	 *   fire ⇔ saving project scope
	 *          ∧ draft has ≥1 translatable `Bash(<cmd…>:*)` rule
	 *          ∧ codex ∈ installed harnesses
	 *          ∧ project trust not already granted (`project_trust !== true`).
	 * Writing such a rule auto-grants `trust_level="trusted"`, activating any
	 * committed `.codex/config.toml` + project-local hooks.
	 */
	function trustConfirmRequired(d: NormalizedPermissions | null): boolean {
		if (!d || scope.kind !== "project") return false;
		if (!installed.includes("codex")) return false;
		if (d.project_trust === true) return false;
		// Only the project's OWN rules are written to its native file (D1 scope-
		// targeted writes) — inherited global rules don't grant project trust. So
		// the trust auto-grant is driven purely by project-own translatable Bash rules.
		const hasTranslatableBash = [...d.allow, ...d.deny, ...d.ask].some(
			(r) => r.origin !== "global" && bashPrefixTokens(r.pattern) !== null,
		);
		return hasTranslatableBash;
	}

	// The user-facing entry point. Intercepts with a ConfirmDialog when the trust
	// predicate holds; otherwise saves directly.
	function save() {
		if (!draft || saving) return;
		if (trustConfirmRequired(draft)) {
			setTrustConfirmOpen(true);
			return;
		}
		void doSave();
	}

	async function doSave() {
		if (!draft) return;
		setSaving(true);
		setSaveError(null);
		try {
			const result = await invoke<{
				changed: boolean;
				normalized: NormalizedPermissions;
			}>("permissions_set", {
				scope,
				payload: stripResolverFields(draft),
				personal: personalActive,
			});
			const next = result.normalized;
			setDraft(next);
			setBaseline(next);
			setSavedJustNow(true);
			window.setTimeout(() => setSavedJustNow(false), 2200);
			if (result.changed) setPendingSync(true);
			invalidatePerms();
		} catch (e) {
			setSaveError(String(e));
		} finally {
			setSaving(false);
		}
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
			const target = e.target as Element | null;
			if (!target?.closest?.(".permissions-section")) return;
			e.preventDefault();
			if (!saveDisabled) void save();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [saveDisabled, draft]);

	useEffect(() => {
		if (!focusTarget) return;
		const id = window.setTimeout(() => {
			const el = sectionRef.current?.querySelector(
				`[data-focus-key="${focusTarget}"] input`,
			) as HTMLInputElement | null;
			el?.focus();
			setFocusTarget(null);
		}, 0);
		return () => window.clearTimeout(id);
	}, [focusTarget, draft]);

	if (permsQuery.isError)
		return (
			<div className="permissions-section perm-surface" ref={sectionRef}>
				Failed to load permissions: {String(permsQuery.error)}
			</div>
		);
	if (permsQuery.isLoading || capsQuery.isLoading || !draft) {
		// Keep the host's ScreenHeader mounted until the editor is fully ready.
		// This covers the fetch itself AND the one frame between data arrival
		// and the draft-building effect — returning null there unmounts the
		// whole screen and reads as a flash on every tab entry.
		const pendingChrome: PermissionsChrome = {
			scope,
			loading: true,
			dirty: false,
			saving: false,
			savedJustNow: false,
			pendingSync: false,
			saveDisabled: true,
			ruleCount: 0,
			hookCount: 0,
			riskCount: 0,
			inheritedCount: 0,
			save: () => {},
			discard: () => {},
			openDoctor: () => {},
			copyToml: () => {},
			openDisable: () => {},
			scopeOptions,
			onSelectScope,
		};
		return (
			<div className="permissions-section perm-surface" ref={sectionRef}>
				{renderChrome?.(pendingChrome)}
				<div className="perm-loading" role="status">
					Loading permissions…
				</div>
			</div>
		);
	}
	const stats: Record<RuleKind | "hooks", number> = {
		allow: draft.allow.length,
		deny: draft.deny.length,
		ask: draft.ask.length,
		hooks: draft.hooks.length,
	};
	const q = search.trim().toLowerCase();
	const matchRule = (rule: Rule) => {
		if (q) {
			const text = `${rule.pattern} ${rule.origin ?? "project"}`.toLowerCase();
			if (!text.includes(q)) return false;
		}
		return ruleMatchesFilter(rule, harnessFilter, installed, capabilities);
	};
	const matchHook = (hook: Hook) => {
		if (!q) return true;
		const text =
			`${hook.event} ${hook.matcher} ${hook.command} ${hook.origin ?? "project"}`.toLowerCase();
		return text.includes(q);
	};

	// Flatten every rule (across all kinds) tagged with its source kind + index +
	// risk tier, then re-group by tier. Kind is preserved on each row so the kind
	// switcher, color, and edit/delete keep working inside the tier layout.
	type TieredRule = {
		rule: Rule;
		kind: RuleKind;
		index: number;
		tier: PermissionTier;
	};
	const allTiered: TieredRule[] = [];
	for (const kind of KINDS) {
		draft[kind].forEach((rule, index) => {
			allTiered.push({ rule, kind, index, tier: classifyTier(rule.pattern) });
		});
	}
	const visibleTiered = allTiered.filter(
		({ rule, kind }) =>
			(filter === "all" || filter === kind) && matchRule(rule),
	);

	// One section per risk tier, in fixed order. A tier renders only when it has
	// rules in scope (total) or matches the active filters.
	const tierSections = TIER_ORDER.map((tier) => {
		const items = visibleTiered.filter((t) => t.tier === tier);
		const totalCount = allTiered.filter((t) => t.tier === tier).length;
		return { tier, items, totalCount };
	}).filter((s) => s.totalCount > 0 || s.items.length > 0);

	const renderRuleRow = ({ rule, kind, index }: TieredRule) => (
		<div key={`${kind}:${index}`} data-focus-key={`${kind}:${index}`}>
			<PermissionRow
				rule={rule}
				installedHarnesses={installed}
				harnessLabels={harnessLabels}
				capabilities={capabilities}
				scopeKind={scope.kind}
				validation={validation[`${kind}:${index}`]}
				risks={risksIndex[rule.pattern] ?? []}
				patternSuggestions={patternSuggestions}
				shadowedByGlobalDeny={
					kind === "allow" && shadowedAllowPatterns.has(rule.pattern)
				}
				readOnly={rule.origin === "global" && scope.kind === "project"}
				onChange={(next) => updateRule(kind, index, next)}
				onChangeKind={(toKind) => changeRuleKind(kind, index, toKind)}
				onDelete={() => deleteRule(kind, index)}
				onPromote={() => promoteRule(kind, index)}
				onDemote={() => void demoteRuleToGlobal(kind, index)}
			/>
		</div>
	);

	// Hooks become a labeled Claude·Pi specialty section (see SpecialtySection).
	const hookItems = draft.hooks
		.map((hook, index) => ({ hook, index }))
		.filter(({ hook }) => matchHook(hook));
	// Show the hooks specialty when the kind filter allows it AND we're not
	// narrowed to a harness that can't express hooks.
	const hooksFeatureVisible =
		(filter === "all" || filter === "hooks") &&
		(harnessFilter === "all" ||
			harnessFilter === "common" ||
			(capabilities[harnessFilter.harness] ?? []).includes("hooks"));

	const totalVisibleRows =
		visibleTiered.length + (hooksFeatureVisible ? hookItems.length : 0);

	const saveTooltip = adoptionBlocking
		? "Resolve adoption first"
		: validationErrors.length > 0
			? `Invalid rules: ${validationErrors.map(([k]) => k).join(", ")}`
			: undefined;

	const globalDraft = (globalPermsForInheritance.data ??
		null) as NormalizedPermissions | null;

	// Names only — the registry carries no per-project sync timestamp, so a
	// health dot here would be fabricated. Drop it rather than fake "never".
	const projectPills =
		scope.kind === "global"
			? Object.keys(registry.data?.projects ?? {})
					.slice(0, 8)
					.map((name) => ({ name }))
			: [];

	const inheritedCount =
		scope.kind === "project"
			? draft.allow.filter((r) => r.origin === "global").length +
				draft.deny.filter((r) => r.origin === "global").length +
				draft.ask.filter((r) => r.origin === "global").length +
				draft.hooks.filter((h) => h.origin === "global").length
			: 0;

	const chrome: PermissionsChrome = {
		scope,
		loading: false,
		dirty,
		saving,
		savedJustNow,
		pendingSync,
		saveDisabled,
		saveTooltip,
		ruleCount: stats.allow + stats.deny + stats.ask,
		hookCount: stats.hooks,
		riskCount: risks.length,
		inheritedCount,
		save: () => void save(),
		discard: discardChanges,
		openDoctor: () => setShowDoctor(true),
		copyToml: () => void copyPermissionsToml(scope, draft),
		openDisable: () => setShowDisable(true),
		scopeOptions,
		onSelectScope,
	};

	return (
		<div className="permissions-section perm-surface" ref={sectionRef}>
			{renderChrome?.(chrome)}

			{saveError && (
				<div className="perm-alert" role="alert">
					{saveError}
				</div>
			)}
			{banner}
			{duplicateCollapsed > 0 && (
				<div className="perm-alert" role="status">
					Collapsed {duplicateCollapsed} duplicate permission rule
					{duplicateCollapsed === 1 ? "" : "s"} for display. Save or sync to
					repair the registry.
				</div>
			)}

			{adoptionBlocking ? (
				<div className="perm-empty">
					Resolve adoption to start editing global permissions.
				</div>
			) : (
				<>
					<div className="perm-band">
						{scope.kind === "project" && (
							<TierToggle personal={personal} onChange={setPersonal} />
						)}
						<PermissionsStatHero
							stats={stats}
							filter={filter}
							onFilter={setFilter}
						/>
						{risks.length > 0 && (
							<PermissionsRiskBanner
								risks={risks}
								severity={sectionSeverity}
								onOpenDoctor={() => setShowDoctor(true)}
							/>
						)}
						<PermissionsToolbar
							search={search}
							filter={filter}
							riskCount={risks.length}
							riskSeverity={sectionSeverity}
							stats={stats}
							draft={draft}
							installed={installed}
							capabilities={capabilities}
							harnessLabels={harnessLabels}
							onSearch={setSearch}
							onFilter={setFilter}
							onAddRule={addRule}
							onAddHook={addHook}
							onDoctor={() => setShowDoctor(true)}
							onOpenPresets={() => setShowPresets(true)}
							onOpenImport={() => setShowImport(true)}
						/>
						<HarnessFilterTabs
							installed={installed}
							labels={harnessLabels}
							filter={harnessFilter}
							onFilter={setHarnessFilter}
						/>
					</div>
					<ResizableSplit
						className="perm-layout"
						fixedPane="right"
						storageKey="st:layout:permissions"
						defaultRightPx={320}
						minRightPx={280}
						maxRightPx={520}
						paneLabel="Tools"
						handleAriaLabel="Resize tools panel"
						left={
						<main className="perm-main">
							<div className="perm-list" aria-label="Permission rows">
								{totalVisibleRows === 0 ? (
									<div className="perm-empty">
										No permission rows match the current filters.
									</div>
								) : (
									<>
										{tierSections.map((s) => (
											<TierSection
												key={s.tier}
												tier={s.tier}
												totalCount={s.totalCount}
												onAdd={() => addRule("allow", { keepFilter: true })}
											>
												{s.items.length === 0 ? (
													<div className="perm-section-empty">
														No {TIER_META[s.tier].label.toLowerCase()} rules
														match the current filters.
													</div>
												) : (
													s.items.map(renderRuleRow)
												)}
											</TierSection>
										))}
										{hooksFeatureVisible && (stats.hooks > 0 || hookItems.length > 0) && (
											<SpecialtySection
												title="Hooks"
												caption="shell commands on tool events"
												harnessIds={installed.filter((id) =>
													(capabilities[id] ?? []).includes("hooks"),
												)}
												labels={harnessLabels}
												totalCount={stats.hooks}
												onAdd={addHook}
											>
												{hookItems.length === 0 ? (
													<div className="perm-section-empty">
														No hooks match the current filters.
													</div>
												) : (
													hookItems.map(({ hook, index }) => (
														<HookRow
															key={`hook:${index}`}
															focusKey={`hook:${index}`}
															hook={hook}
															scopeKind={scope.kind}
															installed={installed}
															labels={harnessLabels}
															capabilities={capabilities}
															onUpdate={(next) => updateHook(index, next)}
															onDelete={() => deleteHook(index)}
															onPromote={() => promoteHook(index)}
														/>
													))
												)}
											</SpecialtySection>
										)}
									</>
								)}
							</div>
						</main>
						}
						right={
						<aside className="perm-side">
							<ScopeContextCard
								scope={scope}
								projectCount={projectCount}
								projectPills={projectPills}
								inheritedAllow={
									draft.allow.filter((r) => r.origin === "global").length
								}
								inheritedDeny={
									draft.deny.filter((r) => r.origin === "global").length
								}
								inheritedAsk={
									draft.ask.filter((r) => r.origin === "global").length
								}
								inheritedHooks={
									draft.hooks.filter((h) => h.origin === "global").length
								}
							/>
							<BehaviorCard
								draft={draft}
								installed={installed}
								labels={harnessLabels}
								capabilities={capabilities}
								scope={scope}
								globalDraft={globalDraft}
								onChange={setDraft}
							/>
							{installed.includes("codex") && (
								<CodexRulesPreviewCard draft={draft} scope={scope} />
							)}
							<PatternHelpCard />
						</aside>
						}
						/>
				</>
			)}

			<AdoptionDialog
				open={adoptionBlocking}
				discovered={adoptionRequired}
				harnessLabels={harnessLabels}
				onResolved={() => invalidatePerms()}
			/>
			<ImportMergeDialog
				open={showImport}
				scope={scope}
				harnessLabels={harnessLabels}
				onClose={() => setShowImport(false)}
				onApplied={() => invalidatePerms()}
			/>
			<DisableDialog
				open={showDisable}
				fromScope={scope}
				projectCount={projectCount}
				onClose={() => setShowDisable(false)}
				onApplied={(result) => {
					const touched = (result.scopes_touched ?? []).map<Scope>((s) =>
						s.kind === "global"
							? { kind: "global" }
							: { kind: "project", name: s.name ?? "" },
					);
					invalidatePerms(touched);
				}}
			/>
			<PermissionsDoctorPanel
				open={showDoctor}
				findings={doctorQuery.data?.findings ?? []}
				loading={doctorQuery.isLoading}
				error={doctorQuery.isError ? String(doctorQuery.error) : null}
				onClose={() => setShowDoctor(false)}
				onJumpToFinding={(f) => {
					setShowDoctor(false);
					window.setTimeout(() => {
						const el = sectionRef.current?.querySelector(
							`.permission-row [aria-label="Pattern"][value="${cssEscape(f.detail)}"]`,
						) as HTMLInputElement | null;
						el?.scrollIntoView({ behavior: "smooth", block: "center" });
						el?.focus();
					}, 60);
				}}
			/>
			{draft && (
				<PresetsSheet
					open={showPresets}
					scope={scope}
					currentRules={draft.allow}
					onApplyRules={(rules) => {
						const existingKeys = new Set(
							draft.allow.map((r) => `${r.kind}::${r.pattern}`),
						);
						const additions: Rule[] = [];
						for (const r of rules) {
							const key = `${r.kind}::${r.pattern}`;
							if (existingKeys.has(key)) continue;
							existingKeys.add(key);
							additions.push(r);
						}
						if (additions.length === 0) return;
						setDraft({ ...draft, allow: [...draft.allow, ...additions] });
					}}
					onClose={() => setShowPresets(false)}
				/>
			)}
			<ConfirmDialog
				open={trustConfirmOpen}
				title="Grant Codex trust to this project?"
				confirmLabel="Save & grant trust"
				confirmIcon="save"
				busy={saving}
				onClose={() => setTrustConfirmOpen(false)}
				onConfirm={() => {
					setTrustConfirmOpen(false);
					void doSave();
				}}
				body={
					<p>
						Saving a Codex command rule auto-grants{" "}
						<code>trust_level="trusted"</code> to this project — which also
						activates any committed <code>.codex/config.toml</code> and
						project-local hooks. Only grant trust for a repository you trust.
					</p>
				}
			/>
		</div>
	);
}

function cssEscape(s: string): string {
	const w = window as unknown as { CSS?: { escape?: (s: string) => string } };
	return w.CSS?.escape ? w.CSS.escape(s) : s.replace(/"/g, '\\"');
}

/** Serialize the current draft to a permissions.toml string and copy it. */
async function copyPermissionsToml(
	scope: Scope,
	draft: NormalizedPermissions,
): Promise<void> {
	const q = (s: string) => JSON.stringify(s);
	const arr = (rules: Rule[]) => `[${rules.map((r) => q(r.pattern)).join(", ")}]`;
	const lines: string[] = [`# permissions — ${scopeLabel(scope)}`];
	lines.push(`allow = ${arr(draft.allow)}`);
	lines.push(`deny = ${arr(draft.deny)}`);
	lines.push(`ask = ${arr(draft.ask)}`);
	if (draft.sandbox_mode) lines.push(`sandbox_mode = ${q(draft.sandbox_mode)}`);
	if (draft.approval_policy)
		lines.push(`approval_policy = ${q(draft.approval_policy)}`);
	if (draft.project_trust !== null && draft.project_trust !== undefined)
		lines.push(`project_trust = ${draft.project_trust}`);
	if (draft.additional_dirs.length)
		lines.push(
			`additional_dirs = [${draft.additional_dirs.map(q).join(", ")}]`,
		);
	for (const h of draft.hooks) {
		lines.push(
			"",
			"[[hooks]]",
			`event = ${q(h.event)}`,
			`matcher = ${q(h.matcher)}`,
			`command = ${q(h.command)}`,
		);
	}
	try {
		await navigator.clipboard.writeText(lines.join("\n") + "\n");
	} catch {
		/* clipboard unavailable (e.g. test env) — no-op */
	}
}

/**
 * One risk-tier group (Read & inspect / Build & package / Network & destructive
 * / Other). Rules of any kind that classify into this tier live here; the tier
 * accent tints the section, while each row keeps its own kind color + switcher.
 */
function TierSection({
	tier,
	totalCount,
	onAdd,
	children,
}: {
	tier: PermissionTier;
	totalCount: number;
	onAdd: () => void;
	children: ReactNode;
}) {
	const meta = TIER_META[tier];
	return (
		<section
			className="perm-section perm-tier-section"
			data-tier={tier}
			style={{ "--accent": meta.accent } as CSSProperties}
		>
			<header className="perm-section-head">
				<span className="perm-section-bullet" />
				<span className="perm-section-label">{meta.label}</span>
				<span className="perm-tier-caption">{meta.caption}</span>
				<span className="perm-section-count">{totalCount}</span>
				<span className="perm-section-spacer" />
				<button
					type="button"
					className="perm-section-add"
					onClick={onAdd}
					aria-label={`Add rule to ${meta.label}`}
				>
					<Icon name="plus" size={10} />
					Add
				</button>
			</header>
			<div className="perm-section-rows">{children}</div>
		</section>
	);
}

/**
 * A harness-specialty section: a capability only some harnesses can express.
 * Headed by the supporting harnesses' monograms/logos + an "only on <harness>"
 * caption so portability is never implied for features that aren't portable.
 */
function SpecialtySection({
	title,
	caption,
	harnessIds,
	labels,
	totalCount,
	onAdd,
	children,
}: {
	title: string;
	caption: string;
	harnessIds: string[];
	labels?: Record<string, string>;
	totalCount?: number;
	onAdd?: () => void;
	children: ReactNode;
}) {
	const onlyOn =
		harnessIds.length > 0
			? `only on ${harnessIds
					.map((id) => labels?.[id] ?? harnessLabel(id))
					.join(" · ")}`
			: "no installed harness supports this";
	return (
		<section className="perm-section perm-specialty-section">
			<header className="perm-section-head perm-specialty-head">
				<span className="perm-specialty-glyphs">
					{harnessIds.map((id) => (
						<HarnessGlyph
							key={id}
							id={id}
							label={harnessLabel(id)}
							size={16}
						/>
					))}
				</span>
				<span className="perm-section-label">{title}</span>
				<span className="perm-specialty-only">{onlyOn}</span>
				{caption && <span className="perm-tier-caption">{caption}</span>}
				{totalCount !== undefined && (
					<span className="perm-section-count">{totalCount}</span>
				)}
				<span className="perm-section-spacer" />
				{onAdd && (
					<button
						type="button"
						className="perm-section-add"
						onClick={onAdd}
						aria-label={`Add ${title.toLowerCase()}`}
					>
						<Icon name="plus" size={10} />
						Add
					</button>
				)}
			</header>
			<div className="perm-section-rows">{children}</div>
		</section>
	);
}

/**
 * Segmented control above the rule list: `All · Common · <installed harness…>`.
 * Always shows All + Common; per-harness tabs only for installed harnesses.
 * Drives the same capability data the affinity chips read (no second matrix).
 */
function HarnessFilterTabs({
	installed,
	labels,
	filter,
	onFilter,
}: {
	installed: string[];
	labels?: Record<string, string>;
	filter: HarnessFilter;
	onFilter: (f: HarnessFilter) => void;
}) {
	const tabs: { key: string; label: ReactNode; value: HarnessFilter }[] = [
		{ key: "all", label: "All", value: "all" },
		{ key: "common", label: "Common", value: "common" },
		...installed.map((id) => ({
			key: `harness:${id}`,
			label: (
				<span className="perm-harness-tab-inner">
					<HarnessGlyph id={id} label={labels?.[id] ?? id} size={14} decorative />
					{labels?.[id] ?? harnessLabel(id)}
				</span>
			),
			value: { harness: id } as HarnessFilter,
		})),
	];
	return (
		<div
			className="perm-harness-tabs"
			role="group"
			aria-label="Filter rules by harness"
		>
			{tabs.map((t) => (
				<button
					key={t.key}
					type="button"
					className="perm-harness-tab"
					data-tab={t.key}
					aria-pressed={filtersEqual(filter, t.value)}
					title={
						t.key === "common"
							? "Rules expressible on every installed harness — the portable core"
							: undefined
					}
					onClick={() => onFilter(t.value)}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}

function PermissionsRiskBanner({
	risks,
	severity,
	onOpenDoctor,
}: {
	risks: RiskFinding[];
	severity: "danger" | "warning" | null;
	onOpenDoctor: () => void;
}) {
	const first = risks.slice(0, 2);
	const remaining = Math.max(risks.length - first.length, 0);
	return (
		<div className="perm-risk-banner" data-severity={severity ?? "warning"}>
			<Icon name="warning" size={14} />
			<div className="perm-risk-body">
				<strong>
					{risks.length} risk{risks.length === 1 ? "" : "s"} flagged
				</strong>
				<span className="perm-risk-sep"> — </span>
				{first.map((r, i) => (
					<span key={`${r.code}:${r.detail}:${i}`} className="perm-risk-item">
						<code>{r.detail || r.code}</code>
						<span className="perm-risk-code" data-severity={r.severity}>
							{r.code}
						</span>
						{i < first.length - 1 && <span className="perm-risk-sep"> · </span>}
					</span>
				))}
				{remaining > 0 && (
					<span className="perm-risk-more"> · +{remaining} more</span>
				)}
			</div>
			<button
				type="button"
				className="perm-risk-action"
				onClick={onOpenDoctor}
			>
				Open doctor →
			</button>
		</div>
	);
}

function PermissionsStatHero({
	stats,
	filter,
	onFilter,
}: {
	stats: Record<RuleKind | "hooks", number>;
	filter: PermissionFilter;
	onFilter: (f: PermissionFilter) => void;
}) {
	const order: Array<RuleKind | "hooks"> = ["allow", "deny", "ask", "hooks"];
	return (
		<div className="perm-summary">
			{order.map((k) => {
				const meta = KIND_META[k];
				const active = filter === k;
				return (
					<button
						type="button"
						key={k}
						className="perm-stat"
						data-kind={k}
						aria-pressed={active}
						onClick={() => onFilter(active ? "all" : k)}
						style={{ "--accent": meta.accent } as CSSProperties}
					>
						<span className="perm-stat-stripe" />
						<span className="perm-stat-head">
							<Icon name={meta.icon} size={12} />
							<span className="perm-stat-label">{meta.label}</span>
						</span>
						<span className="perm-stat-value">{stats[k]}</span>
						<span className="perm-stat-help">{meta.help}</span>
					</button>
				);
			})}
		</div>
	);
}

/**
 * Project-only "Shared ⇄ Personal" tier switcher. Shared = the committed
 * `permissions` block (`.claude/settings.json`); Personal = the uncommitted
 * `permissions_local` block (`.claude/settings.local.json`). When Personal is
 * active a caption makes the uncommitted nature explicit. Uses neutral
 * section-chrome tokens (no brand violet, no semantic accent).
 */
function TierToggle({
	personal,
	onChange,
}: {
	personal: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<div className="perm-tier-toggle">
			<div
				className="perm-tier-seg"
				role="group"
				aria-label="Permission tier"
			>
				<button
					type="button"
					className="perm-tier-seg-btn"
					data-active={!personal}
					aria-pressed={!personal}
					onClick={() => onChange(false)}
				>
					<Icon name="globe" size={12} />
					Shared
				</button>
				<button
					type="button"
					className="perm-tier-seg-btn"
					data-active={personal}
					aria-pressed={personal}
					onClick={() => onChange(true)}
				>
					<Icon name="pin" size={12} />
					Personal
				</button>
			</div>
			<span className="perm-tier-caption-text">
				{personal
					? "personal · not committed · .claude/settings.local.json"
					: "shared · committed · .claude/settings.json"}
			</span>
		</div>
	);
}

function PermissionsToolbar({
	search,
	filter,
	riskCount,
	riskSeverity,
	stats,
	draft,
	installed,
	capabilities,
	harnessLabels,
	onSearch,
	onFilter,
	onAddRule,
	onAddHook,
	onDoctor,
	onOpenPresets,
	onOpenImport,
}: {
	search: string;
	filter: PermissionFilter;
	riskCount: number;
	riskSeverity: "danger" | "warning" | null;
	stats: Record<RuleKind | "hooks", number>;
	draft: NormalizedPermissions;
	installed: string[];
	capabilities: Record<string, PermissionFeature[]>;
	harnessLabels: Record<string, string>;
	onSearch: (s: string) => void;
	onFilter: (f: PermissionFilter) => void;
	onAddRule: (k: RuleKind) => void;
	onAddHook: () => void;
	onDoctor: () => void;
	onOpenPresets: () => void;
	onOpenImport: () => void;
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent) {
			if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onEsc(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onEsc);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onEsc);
		};
	}, [open]);

	const chips: { key: PermissionFilter; label: string; count: number | null }[] =
		[
			{ key: "all", label: "ALL", count: null },
			{ key: "allow", label: "ALLOW", count: stats.allow },
			{ key: "deny", label: "DENY", count: stats.deny },
			{ key: "ask", label: "ASK", count: stats.ask },
			{ key: "hooks", label: "HOOKS", count: stats.hooks },
		];

	const addItems: Array<{
		key: "allow" | "deny" | "ask" | "hook";
		label: string;
		hint: string;
		accent: string;
	}> = [
		{
			key: "allow",
			label: "Allow rule",
			hint: "auto-approve a pattern",
			accent: KIND_META.allow.accent,
		},
		{
			key: "deny",
			label: "Deny rule",
			hint: "block a pattern",
			accent: KIND_META.deny.accent,
		},
		{
			key: "ask",
			label: "Ask rule",
			hint: "gate behind prompt",
			accent: KIND_META.ask.accent,
		},
		{
			key: "hook",
			label: "Hook",
			hint: "shell command on tool event",
			accent: KIND_META.hooks.accent,
		},
	];

	return (
		<div className="perm-toolbar">
			<div className="perm-search">
				<Icon name="search" size={12} />
				<input
					aria-label="Search permissions"
					value={search}
					onChange={(e) => onSearch(e.target.value)}
					placeholder="Search rules, hooks, patterns…"
				/>
				{search && (
					<button
						type="button"
						className="perm-icon-btn"
						aria-label="Clear search"
						onClick={() => onSearch("")}
					>
						<Icon name="x" size={11} />
					</button>
				)}
			</div>
			<div className="perm-filter-chips">
				{chips.map((c) => (
					<button
						key={c.key}
						type="button"
						aria-pressed={filter === c.key}
						onClick={() => onFilter(c.key)}
					>
						{c.label}
						{c.count !== null && <span className="count">{c.count}</span>}
					</button>
				))}
			</div>
			<CommandSimulator
				draft={draft}
				installed={installed}
				capabilities={capabilities}
				harnessLabels={harnessLabels}
			/>
			<span className="perm-toolbar-spacer" />
			<Button variant="ghost" icon="warning" onClick={onDoctor}>
				Doctor
				{riskCount > 0 && (
					<span
						className="perm-doctor-pip"
						data-severity={riskSeverity ?? "warning"}
					>
						{riskCount}
					</span>
				)}
			</Button>
			<Button variant="ghost" icon="spark" onClick={onOpenPresets}>
				Presets
			</Button>
			<Button variant="ghost" icon="duplicate" onClick={onOpenImport}>
				Import
			</Button>
			<div className="perm-add-menu" ref={menuRef}>
				<Button
					variant="primary"
					icon="plus"
					onClick={() => onAddRule("allow")}
				>
					Add allow
				</Button>
				<button
					type="button"
					aria-label="Choose permission type"
					onClick={() => setOpen((v) => !v)}
				>
					<Icon name="chevronDown" size={10} />
				</button>
				{open && (
					<div className="perm-add-popover">
						{addItems.map((item) => (
							<button
								key={item.key}
								type="button"
								className="perm-add-menu-item"
								onClick={() => {
									if (item.key === "hook") onAddHook();
									else onAddRule(item.key);
									setOpen(false);
								}}
							>
								<span
									className="perm-add-menu-dot"
									style={{ background: item.accent }}
								/>
								<div>
									<div className="lbl">
										{item.key === "hook" ? "Add hook" : `Add ${item.key}`}
									</div>
									<div className="hint">{item.hint}</div>
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * "Test a command" simulator (§03). The user types a concrete shell command;
 * we predict the verdict live PER installed harness via
 * `evaluateDecisionForHarness` against the CURRENT in-memory draft. Each harness
 * filters the draft to the rules it can actually express (capability + Bash-only
 * caveat + affinity) before scoring, so when a control applies on one harness
 * but not another the verdicts diverge — and that divergence is the whole point:
 * it's visible at a glance. Pills are colored by kind — allow=green, ask=amber,
 * deny=red. Empty input renders nothing. Models Bash rules only (backend parity).
 */
const SIM_PILL: Record<RuleKind, { label: string; accent: string }> = {
	allow: { label: "ALLOW", accent: "var(--green)" },
	ask: { label: "ASK", accent: "var(--amber)" },
	deny: { label: "DENY", accent: "var(--red)" },
};

function CommandSimulator({
	draft,
	installed,
	capabilities,
	harnessLabels,
}: {
	draft: NormalizedPermissions;
	installed: string[];
	capabilities: Record<string, PermissionFeature[]>;
	harnessLabels: Record<string, string>;
}) {
	const [command, setCommand] = useState("");
	const trimmed = command.trim();
	const verdicts = trimmed
		? installed.map((id) => ({
				id,
				kind: evaluateDecisionForHarness(draft, trimmed, id, capabilities),
			}))
		: [];
	return (
		<div className="perm-sim" data-testid="command-simulator">
			<div className="perm-sim-input">
				<Icon name="search" size={12} />
				<input
					aria-label="Test a command"
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					placeholder="Test a command…"
					spellCheck={false}
				/>
			</div>
			{verdicts.length > 0 && (
				<div className="perm-sim-harnesses" role="status">
					{verdicts.map(({ id, kind }) => {
						const meta = SIM_PILL[kind];
						const label = harnessLabels[id] ?? harnessLabel(id);
						return (
							<span
								key={id}
								className="perm-sim-harness"
								title={`${label} → ${meta.label}`}
							>
								<HarnessGlyph id={id} label={label} size={14} decorative />
								<span
									className="perm-sim-verdict"
									data-verdict={kind}
									data-harness={id}
									style={{ "--accent": meta.accent } as CSSProperties}
								>
									{meta.label}
								</span>
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
}

function HookRow({
	hook,
	scopeKind,
	installed,
	labels,
	capabilities,
	onUpdate,
	onDelete,
	onPromote,
	focusKey,
}: {
	hook: Hook;
	scopeKind: "global" | "project";
	installed: string[];
	labels: Record<string, string>;
	capabilities: Record<string, PermissionFeature[]>;
	onUpdate: (next: Hook) => void;
	onDelete: () => void;
	/** Copy this inherited (global) hook into the project. */
	onPromote?: () => void;
	focusKey: string;
}) {
	// A global-origin hook is only read-only when viewed FROM a project.
	const readOnly = hook.origin === "global" && scopeKind === "project";
	const showProvenance = scopeKind === "project";
	function toggleAffinity(harnessId: string, nextState: ChipState) {
		if (readOnly) return;
		const current =
			hook.harnesses ??
			installed.filter((id) => (capabilities[id] ?? []).includes("hooks"));
		const next =
			nextState === "applied"
				? current.includes(harnessId)
					? current
					: [...current, harnessId]
				: current.filter((id) => id !== harnessId);
		const capableSet = installed.filter((id) =>
			(capabilities[id] ?? []).includes("hooks"),
		);
		const isFullSet =
			next.length === capableSet.length &&
			next.every((id) => capableSet.includes(id));
		onUpdate({ ...hook, harnesses: isFullSet ? null : next.sort() });
	}
	return (
		<div
			className="perm-row perm-hook-row"
			data-kind="hooks"
			data-origin={hook.origin ?? "project"}
			data-focus-key={focusKey}
		>
			<span className="perm-row-kind">
				<Icon name="bolt" size={11} />
				HOOK
			</span>
			<input
				aria-label="Event"
				className="perm-hook-event"
				value={hook.event}
				disabled={readOnly}
				onChange={(e) => onUpdate({ ...hook, event: e.target.value })}
				placeholder="PreToolUse"
			/>
			<input
				aria-label="Matcher"
				className="perm-hook-matcher"
				value={hook.matcher}
				disabled={readOnly}
				onChange={(e) => onUpdate({ ...hook, matcher: e.target.value })}
				placeholder="Bash"
			/>
			<input
				aria-label="Command"
				className="perm-hook-command"
				value={hook.command}
				disabled={readOnly}
				onChange={(e) => onUpdate({ ...hook, command: e.target.value })}
				placeholder="echo hi"
				spellCheck={false}
			/>
			<HarnessAffinityChips
				installedHarnesses={installed}
				labels={labels}
				capabilities={capabilities}
				feature="hooks"
				affinity={hook.harnesses}
				onToggle={readOnly ? undefined : toggleAffinity}
				collapsedWhenAll={false}
			/>
			<div className="perm-row-prov">
				{showProvenance && (
					<Tag
						color={hook.origin === "global" ? "var(--violet)" : "var(--amber)"}
					>
						{hook.origin === "global" ? "via global" : "project"}
					</Tag>
				)}
			</div>
			<div className="perm-row-actions">
				{showProvenance && readOnly && onPromote && (
					<Button
						size="sm"
						variant="ghost"
						icon="duplicate"
						title="Copy this global hook down into the project. The global hook stays in effect for other projects; here, your project copy wins."
						onClick={() => onPromote()}
					>
						Copy to project
					</Button>
				)}
				{!readOnly && (
					<button
						type="button"
						className="perm-icon-btn"
						aria-label="Delete hook"
						onClick={onDelete}
					>
						<Icon name="trash" size={13} />
					</button>
				)}
			</div>
		</div>
	);
}

function BehaviorCard({
	draft,
	installed,
	labels,
	capabilities,
	scope,
	globalDraft,
	onChange,
}: {
	draft: NormalizedPermissions;
	installed: string[];
	labels: Record<string, string>;
	capabilities: Record<string, PermissionFeature[]>;
	scope: Scope;
	globalDraft: NormalizedPermissions | null;
	onChange: (next: NormalizedPermissions) => void;
}) {
	const featureUnsupported = (f: PermissionFeature) =>
		installed.length > 0 &&
		installed.every((id) => !(capabilities[id] ?? []).includes(f));
	const labelsFor = (f: PermissionFeature) =>
		installed
			.filter((id) => !(capabilities[id] ?? []).includes(f))
			.map((id) => labels[id] ?? id);
	const unsupportedIds = (f: PermissionFeature) =>
		installed.filter((id) => !(capabilities[id] ?? []).includes(f));
	const supportingIds = (f: PermissionFeature) =>
		installed.filter((id) => (capabilities[id] ?? []).includes(f));
	const inheritedNote = (
		draftVal: string | boolean | null | undefined,
		field: keyof NormalizedPermissions,
	) => {
		if (scope.kind !== "project") return null;
		if (draftVal !== null && draftVal !== undefined) return null;
		if (!globalDraft) return null;
		const globalVal = globalDraft[field] as
			| string
			| boolean
			| null
			| undefined;
		if (globalVal === null || globalVal === undefined) return null;
		return (
			<span className="perm-inherit-note">
				inherits <code>{String(globalVal)}</code>
			</span>
		);
	};
	return (
		<div className="perm-side-card">
			<div className="perm-side-head">
				<span className="perm-side-label">Behavior</span>
				<span className="perm-side-sub">harness-level settings</span>
			</div>
			<div className="perm-setting">
				<div className="perm-setting-key">
					<span className="k">sandbox_mode</span>
					{inheritedNote(draft.sandbox_mode, "sandbox_mode")}
				</div>
				{featureUnsupported("sandbox_mode") ? (
					<CapabilityPlaceholder
						unsupportedLabels={labelsFor("sandbox_mode")}
						unsupportedIds={unsupportedIds("sandbox_mode")}
						labels={labels}
						feature="sandbox mode"
					/>
				) : (
					<select
						className="perm-select"
						value={draft.sandbox_mode ?? ""}
						onChange={(e) =>
							onChange({ ...draft, sandbox_mode: e.target.value || null })
						}
					>
						<option value="">— inherit / unset —</option>
						<option value="read-only">read-only</option>
						<option value="workspace-write">workspace-write</option>
						<option value="danger-full-access">danger-full-access</option>
					</select>
				)}
				<SupportedByHint
					feature="sandbox_mode"
					ids={supportingIds("sandbox_mode")}
					labels={labels}
				/>
			</div>

			<div className="perm-setting">
				<div className="perm-setting-key">
					<span className="k">approval_policy</span>
					{inheritedNote(draft.approval_policy, "approval_policy")}
				</div>
				{featureUnsupported("approval_policy") ? (
					<CapabilityPlaceholder
						unsupportedLabels={labelsFor("approval_policy")}
						unsupportedIds={unsupportedIds("approval_policy")}
						labels={labels}
						feature="approval policy"
					/>
				) : (
					<select
						className="perm-select"
						value={draft.approval_policy ?? ""}
						onChange={(e) =>
							onChange({ ...draft, approval_policy: e.target.value || null })
						}
					>
						<option value="">— inherit / unset —</option>
						<option value="never">never</option>
						<option value="on-failure">on-failure</option>
						<option value="unless-trusted">unless-trusted</option>
						<option value="on-request">on-request</option>
					</select>
				)}
				<SupportedByHint
					feature="approval_policy"
					ids={supportingIds("approval_policy")}
					labels={labels}
					tail="when the agent asks before escalating"
				/>
			</div>

			<div className="perm-setting">
				<div className="perm-setting-key">
					<span className="k">project_trust</span>
					{inheritedNote(draft.project_trust, "project_trust")}
				</div>
				{featureUnsupported("project_trust") ? (
					<CapabilityPlaceholder
						unsupportedLabels={labelsFor("project_trust")}
						unsupportedIds={unsupportedIds("project_trust")}
						labels={labels}
						feature="project trust"
					/>
				) : (
					<div
						className="perm-trust-row"
						role="group"
						aria-label="project_trust"
					>
						{[
							{ v: null as boolean | null, label: "inherit" },
							{ v: true as boolean | null, label: "trusted" },
							{ v: false as boolean | null, label: "untrusted" },
						].map((opt) => (
							<button
								key={String(opt.v)}
								type="button"
								className="perm-trust-btn"
								aria-pressed={draft.project_trust === opt.v}
								onClick={() => onChange({ ...draft, project_trust: opt.v })}
							>
								{opt.label}
							</button>
						))}
					</div>
				)}
				<SupportedByHint
					feature="project_trust"
					ids={supportingIds("project_trust")}
					labels={labels}
					tail="project-specific trust override"
				/>
			</div>

			<div className="perm-setting">
				<div className="perm-setting-key">
					<span className="k">additional_dirs</span>
					<span className="perm-setting-meta">
						{draft.additional_dirs.length}
					</span>
				</div>
				{featureUnsupported("additional_directories") ? (
					<CapabilityPlaceholder
						unsupportedLabels={labelsFor("additional_directories")}
						unsupportedIds={unsupportedIds("additional_directories")}
						labels={labels}
						feature="additional directories"
					/>
				) : (
					<div className="perm-dirs">
						{draft.additional_dirs.map((d, i) => (
							<div className="perm-dir-row" key={i}>
								<Icon name="folder" size={11} />
								<input
									aria-label={`Additional directory ${i + 1}`}
									value={d}
									placeholder="/abs/path"
									onChange={(e) => {
										const next = [...draft.additional_dirs];
										next[i] = e.target.value;
										onChange({ ...draft, additional_dirs: next });
									}}
								/>
								<button
									type="button"
									className="perm-icon-btn"
									aria-label="Remove directory"
									onClick={() =>
										onChange({
											...draft,
											additional_dirs: draft.additional_dirs.filter(
												(_, j) => j !== i,
											),
										})
									}
								>
									<Icon name="x" size={11} />
								</button>
							</div>
						))}
						<button
							type="button"
							className="perm-dir-add"
							onClick={() =>
								onChange({
									...draft,
									additional_dirs: [...draft.additional_dirs, ""],
								})
							}
						>
							<Icon name="plus" size={11} />
							Add directory
						</button>
					</div>
				)}
				<SupportedByHint
					feature="additional_directories"
					ids={supportingIds("additional_directories")}
					labels={labels}
					tail="extra absolute paths available to the sandbox"
				/>
			</div>
		</div>
	);
}

function SupportedByHint({
	feature,
	ids,
	labels,
	tail,
}: {
	feature: PermissionFeature;
	ids: string[];
	labels?: Record<string, string>;
	tail?: string;
}) {
	if (ids.length === 0) return null;
	return (
		<div className="perm-setting-hint">
			Supported by{" "}
			<span className="perm-supported-harnesses">
				<HarnessIconGroup ids={ids} labels={labels} size={14} />
				<span>
					{ids.map((id, i) => (
						<span key={id}>
							<code>{id}</code>
							{i < ids.length - 1 && ", "}
						</span>
					))}
				</span>
			</span>
			{tail ? <> · {tail}.</> : "."}
			{/* feature kept in the DOM as a stable hook for accessibility/testing */}
			<span data-feature={feature} hidden />
		</div>
	);
}

function ScopeContextCard({
	scope,
	projectCount,
	projectPills,
	inheritedAllow,
	inheritedDeny,
	inheritedAsk,
	inheritedHooks,
}: {
	scope: Scope;
	projectCount: number;
	projectPills: Array<{ name: string }>;
	inheritedAllow: number;
	inheritedDeny: number;
	inheritedAsk: number;
	inheritedHooks: number;
}) {
	if (scope.kind === "global") {
		return (
			<div className="perm-side-card">
				<div className="perm-side-head">
					<span className="perm-side-label">Applied to</span>
					<span className="perm-side-sub">
						{projectCount} project{projectCount === 1 ? "" : "s"}
					</span>
				</div>
				{projectPills.length > 0 && (
					<div className="perm-applied-grid">
						{projectPills.map((p) => (
							<span className="perm-applied-pill" key={p.name}>
								{p.name}
							</span>
						))}
					</div>
				)}
				<div className="perm-side-hint">
					Global rules fall back into every project. Each project can copy any
					rule down into a local override.
				</div>
			</div>
		);
	}
	const tiles: Array<{ kind: RuleKind | "hooks"; n: number }> = [
		{ kind: "allow", n: inheritedAllow },
		{ kind: "deny", n: inheritedDeny },
		{ kind: "ask", n: inheritedAsk },
		{ kind: "hooks", n: inheritedHooks },
	];
	const total = tiles.reduce((s, t) => s + t.n, 0);
	return (
		<div className="perm-side-card">
			<div className="perm-side-head">
				<span className="perm-side-label">Inherits from</span>
				<span className="perm-side-sub">Global · {total} rules</span>
			</div>
			<div className="perm-inherit-grid">
				{tiles.map((t) => (
					<div
						className="perm-inherit-tile"
						key={t.kind}
						data-kind={t.kind}
						style={{ "--accent": KIND_META[t.kind].accent } as CSSProperties}
					>
						<span className="n">{t.n}</span>
						<span className="l">{t.kind}</span>
					</div>
				))}
			</div>
			<div className="perm-side-hint">
				Inherited rules are read-only here. Use{" "}
				<strong>Copy to project</strong> on any row to override locally — your
				copy wins, the global rule still applies elsewhere. Use{" "}
				<strong>Move to global</strong> on a project rule to push it up so it
				applies everywhere.
			</div>
		</div>
	);
}

/**
 * Codex command-rule preview (D7/§6.3). Renders the `prefix_rule(...)` lines hub
 * will generate into `skill-hub.rules` for every translatable Bash rule in the
 * draft, surfaces the `allow→allow / ask→prompt / deny→forbidden` mapping and the
 * Bash-only caveat, and (project scope) the auto-granted-trust warning.
 */
function CodexRulesPreviewCard({
	draft,
	scope,
}: {
	draft: NormalizedPermissions;
	scope: Scope;
}) {
	const rules: Rule[] = [...draft.allow, ...draft.deny, ...draft.ask];
	const lines: string[] = [];
	let skipped = 0;
	for (const r of rules) {
		// Inherited-global rules with codex excluded by affinity still preview;
		// affinity narrowing is out of scope for this static preview.
		const tokens = bashPrefixTokens(r.pattern);
		if (tokens === null) {
			skipped += 1;
			continue;
		}
		const pat = `[${tokens.map((t) => JSON.stringify(t)).join(", ")}]`;
		lines.push(
			`prefix_rule(pattern = ${pat}, decision = ${JSON.stringify(
				codexDecision(r.kind),
			)})`,
		);
	}
	return (
		<div className="perm-side-card" data-testid="codex-rules-preview">
			<div className="perm-side-head">
				<span className="perm-side-label">Codex rules</span>
				<span className="perm-side-sub">skill-hub.rules · Bash-only</span>
			</div>
			{lines.length > 0 ? (
				<pre className="perm-codex-preview">
					<code>{lines.join("\n")}</code>
				</pre>
			) : (
				<div className="perm-side-hint">
					No translatable Bash command rules. Codex command rules need a bounded
					prefix like <code>Bash(npm:*)</code>.
				</div>
			)}
			<div className="perm-side-hint">
				Maps <code>allow→allow</code>, <code>ask→prompt</code>,{" "}
				<code>deny→forbidden</code>. Non-Bash rules are skipped for Codex
				{skipped > 0 ? ` (${skipped} skipped)` : ""}.
			</div>
			{scope.kind === "project" && lines.length > 0 && (
				<div className="perm-side-hint" data-severity="warning">
					⚠ Writing project command rules auto-grants Codex trust to this
					project, activating any committed <code>.codex/config.toml</code> and
					project-local hooks.
				</div>
			)}
		</div>
	);
}

function PatternHelpCard() {
	const examples: Array<{ pat: string; hint: string }> = [
		{ pat: "Bash(npm:*)", hint: "any npm subcommand" },
		{ pat: "Bash(npm run *:*)", hint: "any npm run script" },
		{ pat: "Read(src/**)", hint: "every file under src" },
		{ pat: "Edit(**/*.tsx)", hint: "any TSX in the tree" },
		{ pat: "WebFetch(domain:example.com)", hint: "fetch by host" },
	];
	return (
		<div className="perm-side-card">
			<div className="perm-side-head">
				<span className="perm-side-label">Pattern syntax</span>
				<span className="perm-side-sub">glob × tool prefix</span>
			</div>
			<div className="perm-cheat">
				{examples.map((e) => (
					<div className="perm-cheat-row" key={e.pat}>
						<code>{e.pat}</code>
						<span>{e.hint}</span>
					</div>
				))}
			</div>
			<div className="perm-side-hint">
				Tool prefix sets the gate; the value is matched as a glob. Multiple
				rules compose: <em>deny wins, then ask, then allow</em>.
			</div>
		</div>
	);
}
