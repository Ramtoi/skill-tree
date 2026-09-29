import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import {
	stripResolverFields,
	type NormalizedPermissions,
	type Rule,
	type RuleKind,
	type Scope,
	type ValidateResult,
} from "@/types/permissions";
import { applyMcpPermissionChanges, mcpTarget, type McpPermissionChange } from "@/lib/mcpPermissionRules";

function payloadsEqual(
	a: NormalizedPermissions,
	b: NormalizedPermissions,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** `hub permissions set` result. `sync_rc` is the auto-sync exit status:
 *  null when nothing changed, 0 applied, 1 stream write errors, 2 doctor
 *  danger findings. Older backends omit the field entirely. */
interface PermsSetResult {
	changed: boolean;
	normalized: NormalizedPermissions;
	sync_rc?: number | null;
}

/** Worse of two sync outcomes: 2 (danger) > 1 (write errors) > 0 > null. */
function worseSyncRc(
	a: number | null | undefined,
	b: number | null | undefined,
): number | null {
	if (a == null && b == null) return null;
	return Math.max(a ?? 0, b ?? 0);
}

/**
 * The block posted to `permissions_set`, with `hooks` dropped entirely. Hooks
 * are authored on the Hooks surface (`/hooks`) now — the permissions engine
 * ignores an incoming `hooks` key — so this editor never sends one.
 */
function permsSetPayload(
	p: NormalizedPermissions,
): Omit<NormalizedPermissions, "hooks"> {
	const { hooks: _hooks, ...rest } = stripResolverFields(p);
	void _hooks;
	return rest;
}

export interface PermissionsDraft {
	draft: NormalizedPermissions | null;
	baseline: NormalizedPermissions | null;
	validation: Record<string, ValidateResult>;
	saving: boolean;
	applyingMcp: boolean;
	savedJustNow: boolean;
	saveError: string | null;
	/** Exit status of the auto-sync run by the last save: null = no save (or
	 *  nothing changed), 0 = applied, 1 = stream write errors, 2 = doctor
	 *  danger findings. The registry write succeeded in all non-null cases. */
	lastSyncRc: number | null;
	duplicateCollapsed: number;
	dirty: boolean;
	setDraft: (p: NormalizedPermissions) => void;
	applyMcpChanges: (changes: McpPermissionChange[]) => Promise<NormalizedPermissions | null>;
	doSaveDraft: (next: NormalizedPermissions) => Promise<boolean>;
	updateRule: (kind: RuleKind, index: number, next: Rule) => void;
	deleteRule: (kind: RuleKind, index: number) => void;
	addRule: (kind: RuleKind, opts?: { keepFilter?: boolean }) => void;
	promoteRule: (kind: RuleKind, index: number) => void;
	changeRuleKind: (fromKind: RuleKind, index: number, toKind: RuleKind) => void;
	demoteRuleToGlobal: (kind: RuleKind, index: number) => Promise<void>;
	doSave: () => Promise<void>;
	doDiscard: () => void;
	/** Count of allow/deny/ask/hooks rows changed since `baseline`, 0 if either is unset. */
	stagedEditCount: () => number;
}

/**
 * Owns the permissions editor's draft/baseline/validation state and every
 * mutator that edits `draft` in place. Mutators are plain functions (not
 * `useCallback`) so they always close over the current render's `draft` —
 * matching the pre-extraction component exactly; memoising them would close
 * over a stale draft.
 */
export function usePermissionsDraft(args: {
	scope: Scope;
	personalActive: boolean;
	permsData: unknown;
	invalidatePerms: (scopes?: Scope[]) => void;
	onFilterKind: (k: RuleKind) => void;
	onFilterAll: () => void;
	onFocusTarget: (key: string) => void;
}): PermissionsDraft {
	const {
		scope,
		personalActive,
		permsData,
		invalidatePerms,
		onFilterKind,
		onFilterAll,
		onFocusTarget,
	} = args;

	const [draft, setDraft] = useState<NormalizedPermissions | null>(null);
	const [baseline, setBaseline] = useState<NormalizedPermissions | null>(null);
	const [validation, setValidation] = useState<Record<string, ValidateResult>>(
		{},
	);
	const [savedJustNow, setSavedJustNow] = useState(false);
	const [saving, setSaving] = useState(false);
	const [applyingMcp, setApplyingMcp] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [lastSyncRc, setLastSyncRc] = useState<number | null>(null);
	const [duplicateCollapsed, setDuplicateCollapsed] = useState(0);
	const draftRef = useRef<NormalizedPermissions | null>(null);
	const applyingMcpRef = useRef(false);
	const savingRef = useRef(false);
	const scopeIdentity = `${scope.kind}:${scope.kind === "project" ? scope.name : ""}:${personalActive}`;
	const scopeRef = useRef(scopeIdentity);
	scopeRef.current = scopeIdentity;
	useEffect(() => { draftRef.current = draft; }, [draft]);

	useEffect(() => {
		if (!savedJustNow) return;
		const timer = window.setTimeout(() => setSavedJustNow(false), 2200);
		return () => window.clearTimeout(timer);
	}, [savedJustNow]);

	useEffect(() => {
		if (!permsData) return;
		const loaded = stripResolverFields(permsData as NormalizedPermissions);
		const data = permsData as NormalizedPermissions;
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
	}, [permsData]);

	const dirty = useMemo(
		() =>
			!!draft &&
			!!baseline &&
			!payloadsEqual(stripResolverFields(draft), stripResolverFields(baseline)),
		[draft, baseline],
	);

	const validateTimers = useRef<Record<string, number>>({});
	const unmounted = useRef(false);
	useEffect(() => {
		unmounted.current = false;
		const timers = validateTimers.current;
		return () => {
			unmounted.current = true;
			for (const timer of Object.values(timers)) window.clearTimeout(timer);
		};
	}, []);

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
		if (!opts?.keepFilter) onFilterKind(kind);
		onFocusTarget(`${kind}:${nextIndex}`);
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
		onFilterKind(kind);
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
		onFilterAll();
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
			const globalResult = await invoke<PermsSetResult>("permissions_set", {
				scope: globalScope,
				payload: permsSetPayload(nextGlobal),
			});
			// 2. Drop the rule from the project draft and persist the project block.
			const nextProject: NormalizedPermissions = {
				...draft,
				[kind]: draft[kind].filter((_, i) => i !== index),
			};
			const result = await invoke<PermsSetResult>("permissions_set", {
				scope,
				payload: permsSetPayload(nextProject),
				personal: personalActive,
			});
			const next = result.normalized;
			setDraft(next);
			setBaseline(next);
			setSavedJustNow(true);
			// Both writes auto-synced; surface the worse of the two outcomes.
			setLastSyncRc(worseSyncRc(globalResult.sync_rc, result.sync_rc));
			invalidatePerms([globalScope, scope]);
		} catch (e) {
			setSaveError(String(e));
		} finally {
			setSaving(false);
		}
	}
	function doDiscard() {
		if (!baseline) return;
		setDraft(baseline);
		setValidation({});
	}
	async function applyMcpChanges(changes: McpPermissionChange[]): Promise<NormalizedPermissions | null> {
		if (!draft || saving || savingRef.current || applyingMcpRef.current || changes.length === 0) return null;
		applyingMcpRef.current = true;
		const startedScope = scopeIdentity;
		setApplyingMcp(true);
		setSaveError(null);
		const patterns = new Map<string, { pattern: string; kind: RuleKind }>();
		const affectedPatterns = new Set<string>();
		try {
			for (const change of changes) {
				const pattern = mcpTarget(change.server, change.tool);
				affectedPatterns.add(pattern);
				if (change.decision !== "default") patterns.set(pattern, { pattern, kind: change.decision });
			}
			for (const { pattern, kind } of patterns.values()) {
				const result = await invoke<ValidateResult>("permissions_validate", { kind, pattern });
				if (unmounted.current || scopeRef.current !== startedScope) return null;
				if (!result.ok) {
					setSaveError(result.error ?? `Invalid MCP permission: ${pattern}`);
					setValidation((cur) => ({ ...cur, [`mcp:${pattern}`]: result }));
					return null;
				}
			}
			if (unmounted.current || scopeRef.current !== startedScope) return null;
			const current = draftRef.current ?? draft;
			const next = applyMcpPermissionChanges(current, changes, scope.kind);
			draftRef.current = next;
			setDraft(next);
			setValidation((cur) => {
				const cleaned = { ...cur };
				for (const pattern of affectedPatterns) delete cleaned[`mcp:${pattern}`];
				return cleaned;
			});
			return next;
		} catch (error) {
			setSaveError(String(error));
			return null;
		} finally {
			applyingMcpRef.current = false;
			setApplyingMcp(false);
		}
	}
	function stagedEditCount(): number {
		if (!baseline || !draft) return 0;
		return (
			Math.abs(draft.allow.length - baseline.allow.length) +
			Math.abs(draft.deny.length - baseline.deny.length) +
			Math.abs(draft.ask.length - baseline.ask.length) +
			Math.abs((draft.hooks ?? []).length - (baseline.hooks ?? []).length)
		);
	}

	async function doSave() {
		if (draft) await doSaveDraft(draft);
	}
	async function doSaveDraft(next: NormalizedPermissions): Promise<boolean> {
		if (saving || savingRef.current || applyingMcpRef.current) return false;
		savingRef.current = true;
		setSaving(true);
		setSaveError(null);
		try {
			const result = await invoke<PermsSetResult>("permissions_set", {
				scope,
				payload: permsSetPayload(next),
				personal: personalActive,
			});
			const saved = result.normalized;
			setDraft(saved);
			setBaseline(saved);
			setSavedJustNow(true);
			setLastSyncRc(result.sync_rc ?? null);
			invalidatePerms();
			return true;
		} catch (e) {
			setSaveError(String(e));
			return false;
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	}

	return {
		draft,
		baseline,
		validation,
		saving,
		applyingMcp,
		savedJustNow,
		saveError,
		lastSyncRc,
		duplicateCollapsed,
		dirty,
		setDraft,
		applyMcpChanges,
		doSaveDraft,
		updateRule,
		deleteRule,
		addRule,
		promoteRule,
		changeRuleKind,
		demoteRuleToGlobal,
		doSave,
		doDiscard,
		stagedEditCount,
	};
}
