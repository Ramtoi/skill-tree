import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { invalidateRegistry } from "@/lib/invalidate";
import { withQueryFocus } from "@/lib/queryFocus";
import { useFocusAfterCommit } from "@/hooks/useFocusAfterCommit";
import { PermissionRow } from "./PermissionRow";
import { ResizableSplit } from "./ResizableSplit";
import { harnessLabel } from "./harness/harnessRegistry";
import {
	TIER_META,
	TIER_ORDER,
	classifyTier,
	type PermissionTier,
} from "@/lib/permissionTiers";
import {
	ruleMatchesFilter,
	type HarnessFilter,
} from "@/lib/permissionHarnessFilter";
import { useRegistry } from "@/hooks/useRegistry";
import { companionsIndex } from "@/lib/companions";
import { useShipWith } from "@/hooks/useShipWith";
import { eligibleShipTargets } from "@/lib/shipWith";
import { usePermissionsDraft } from "@/hooks/usePermissionsDraft";
import {
	getAdoptionRequired,
	getDivergence,
	permissionsKey,
	usePermissionCapabilities,
	usePermissionRisksSchema,
	usePermissions,
	usePermissionsDoctor,
} from "@/hooks/usePermissions";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import {
	detectRisks,
	findingsByPattern,
	worstSeverity,
} from "@/lib/permissionsRisks";
import { BUILTIN_PRESETS } from "@/lib/permissionPresets";
import { settingsDiffer } from "@/lib/permissionSettingSupport";
import {
	bashPrefixTokens,
	type DoctorFinding,
	type NormalizedPermissions,
	type Rule,
	type RuleKind,
	type Scope,
	type PermissionsShowProject,
} from "@/types/permissions";
import {
	KINDS,
	cssEscape,
	copyPermissionsToml,
	TierSection,
	PermissionsRiskBanner,
	TierToggle,
	PermissionsToolbar,
	type PermissionFilter,
} from "./permissions/PermissionsPanels";
import { PermissionsSidePanel } from "./permissions/PermissionsSidePanel";
import {
	PermissionsOverlays,
	type PermissionsOverlay,
} from "./permissions/PermissionsOverlays";
import { PermissionsDivergenceBanner } from "./permissions/PermissionsDivergenceBanner";

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
	saveDisabled: boolean;
	saveTooltip?: string;
	/** Per-kind counts for the header subline's colored-dot summary. A total
	 *  is derived by summing — there is deliberately no separate ruleCount to
	 *  drift out of step with these. */
	kindCounts: Record<RuleKind, number>;
	hookCount: number;
	riskCount: number;
	/** Project scope: number of rules/hooks inherited from global. */
	inheritedCount: number;
	save: () => void;
	discard: () => void;
	openDoctor: () => void;
	copyToml: () => void;
	openDisable: () => void;
}

export interface PermissionsEditorProps {
	scope: Scope;
	/** Number of registered projects — drives the `All projects (N)` label in DisableDialog. */
	projectCount: number;
	/** Optional banner block (e.g. per-project "Imported N rules" inline banner). */
	banner?: ReactNode;
	/**
	 * Renders the screen chrome (`<ScreenHeader>`) above the editor body. The
	 * editor itself renders only the rules grid + side panel + doctor.
	 */
	renderChrome?: (chrome: PermissionsChrome) => ReactNode;
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
	renderChrome,
}: PermissionsEditorProps) {
	const queryClient = useQueryClient();

	// Project-only "Shared ⇄ Personal" tier toggle. Personal = the uncommitted
	// `permissions_local` block (Claude → .claude/settings.local.json). Reset to
	// Shared whenever the active scope changes (global has no personal tier).
	const [personal, setPersonal] = useState(false);
	const scopeName = scope.kind === "project" ? scope.name : null;
	useEffect(() => {
		setPersonal(false);
	}, [scope.kind, scopeName]);
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
	// A11/D4: the provenance index over the mirror + ledger — cheap to rebuild
	// per render (companions.ts's own contract), used only to look up
	// `via(project, "permission", {pattern, kind})` for each visible rule row.
	const companions = useMemo(
		() => companionsIndex(registry.data),
		[registry.data],
	);
	// Wave 4c unit 4 (plans/3.md §2.3/§5) — the reverse direction's row action.
	const shipWith = useShipWith();
	// One discriminated-union slot for the seven mutually exclusive overlays
	// (trust confirm, discard confirm, disable/doctor/presets/import sheets).
	const [overlay, setOverlay] = useState<PermissionsOverlay>({ kind: "none" });
	useEffect(() => {
		// A sheet owns an overlay-local draft. Switching Shared/Personal or
		// changing projects must cancel it before the parent draft changes tier.
		setOverlay((current) => (current.kind === "mcp" ? { kind: "none" } : current));
	}, [scope.kind, scopeName, personalActive]);
	const mcpServers = useMemo(
		() => Object.entries(registry.data?.skills ?? {}).filter(([, skill]) => skill.type === "mcp-server").map(([name]) => name),
		[registry.data],
	);
	const [filter, setFilter] = useState<PermissionFilter>("all");
	const [harnessFilter, setHarnessFilter] = useState<HarnessFilter>("all");
	const [search, setSearch] = useState("");
	const [focusTarget, setFocusTarget] = useState<string | null>(null);
	const requestFocus = useFocusAfterCommit();
	const sectionRef = useRef<HTMLDivElement | null>(null);
	const doctorQuery = usePermissionsDoctor(overlay.kind === "doctor");
	const [searchParams, setSearchParams] = useSearchParams();
	const location = useLocation();

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
			void invalidateRegistry(queryClient);
		},
		[queryClient, scope, personalActive],
	);

	const {
		draft,
		applyMcpChanges,
		validation,
		saving,
		savedJustNow,
		saveError,
		lastSyncRc,
		duplicateCollapsed,
		dirty,
		setDraft,
		updateRule,
		deleteRule,
		addRule,
		promoteRule,
		changeRuleKind,
		demoteRuleToGlobal,
		doSave,
		doDiscard,
		stagedEditCount,
	} = usePermissionsDraft({
		scope,
		personalActive,
		permsData: permsQuery.data,
		invalidatePerms,
		onFilterKind: setFilter,
		onFilterAll: () => setFilter("all"),
		onFocusTarget: setFocusTarget,
	});

	const installed = useMemo(
		() => Object.keys(capsQuery.data ?? {}).sort(),
		[capsQuery.data],
	);
	// The harness tab strip only renders with >=2 installed harnesses — below
	// that there is no UI left to clear a stuck filter (e.g. a harness that
	// was installed, then removed). Snap back to "all" so the rule list and
	// the side panel can never be silently filtered with no way out.
	useEffect(() => {
		if (installed.length < 2 && harnessFilter !== "all") setHarnessFilter("all");
	}, [installed.length, harnessFilter]);
	const harnessLabels = useMemo(() => harnessLabelMap(installed), [installed]);
	const capabilities = capsQuery.data ?? {};
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
	// Registry-vs-native divergence (staleness + unmanaged count). Personal
	// tier has no divergence payload — the shared query carries it.
	const divergence = personalActive ? null : getDivergence(permsQuery.data);
	const runSync = useRunSync();
	const syncing = useSyncing();
	const validationErrors = Object.entries(validation).filter(([, v]) => !v.ok);
	const saveDisabled =
		!dirty || saving || validationErrors.length > 0 || adoptionBlocking;
	function discardChanges() {
		const changedCount = stagedEditCount();
		if (changedCount >= 5) {
			// Gate a large discard behind the app's ConfirmDialog primitive.
			setOverlay({ kind: "discard", count: changedCount });
			return;
		}
		doDiscard();
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
			setOverlay({ kind: "trust" });
			return;
		}
		void doSave();
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
		const key = focusTarget;
		requestFocus(() => sectionRef.current?.querySelector<HTMLInputElement>(`[data-focus-key="${key}"] input`));
		setFocusTarget(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- requestFocus is a stable-behavior closure recreated every render; including it re-fires this effect every render with no benefit.
	}, [focusTarget, draft]);

	// D8/A21 query-param selection contract: a companion rule row links here
	// with `?focus=<kind>:<pattern>` (`<pattern>` is the CLI's own
	// `encodeURIComponent`, already decoded once by `URLSearchParams.get`) —
	// resolved to the rule's own `${kind}:${index}` and handed to the SAME
	// `focusTarget` machinery a save-time jump already uses. Waits for
	// `draft` to resolve before deciding anything (a cold cache must not
	// silently drop the link, same as `SubagentManager`'s `?agent=`).
	// Unresolvable (bad kind, or no matching pattern) is dropped silently.
	useEffect(() => {
		const raw = searchParams.get("focus");
		if (!raw) return;
		if (!draft) return;
		const sep = raw.indexOf(":");
		const kind = sep >= 0 ? (raw.slice(0, sep) as RuleKind) : null;
		const pattern = sep >= 0 ? raw.slice(sep + 1) : null;
		if (kind && pattern && KINDS.includes(kind)) {
			const index = draft[kind].findIndex((r) => r.pattern === pattern);
			if (index >= 0) setFocusTarget(`${kind}:${index}`);
		}
		const next = new URLSearchParams(searchParams);
		next.delete("focus");
		setSearchParams(next, withQueryFocus(raw, location.state));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, draft]);

	// Keep the host's ScreenHeader mounted until the editor is fully ready.
	// This covers the fetch itself AND the one frame between data arrival and
	// the draft-building effect — returning null there unmounts the whole
	// screen and reads as a flash on every tab entry. [C4]
	const pendingChrome: PermissionsChrome = {
		scope,
		loading: true,
		dirty: false,
		saving: false,
		savedJustNow: false,
		saveDisabled: true,
		kindCounts: { allow: 0, deny: 0, ask: 0 },
		hookCount: 0,
		riskCount: 0,
		inheritedCount: 0,
		save: () => {},
		discard: () => {},
		openDoctor: () => {},
		copyToml: () => {},
		openDisable: () => {},
	};

	// A failed read is exactly when the scope switcher and the way out matter
	// most, so the error branch keeps the same chrome as the pending one.
	if (permsQuery.isError)
		return (
			<div className="permissions-section perm-surface" ref={sectionRef}>
				{renderChrome?.(pendingChrome)}
				<div className="perm-loading" role="alert">
					Failed to load permissions: {String(permsQuery.error)}
				</div>
			</div>
		);
	if (permsQuery.isLoading || capsQuery.isLoading || !draft) {
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
		hooks: (draft.hooks ?? []).length,
	};
	const q = search.trim().toLowerCase();
	const matchRule = (rule: Rule) => {
		if (q) {
			const text = `${rule.pattern} ${rule.origin ?? "project"}`.toLowerCase();
			if (!text.includes(q)) return false;
		}
		return ruleMatchesFilter(rule, harnessFilter, installed, capabilities);
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

	const renderRuleRow = ({ rule, kind, index }: TieredRule) => {
		// A companion-ledger hit only ever exists in a PROJECT scope (D4: the
		// ledger lives at `projects.<n>.companions`) — never fetched for global.
		const viaSkill =
			scope.kind === "project"
				? (companions.via(scope.name, "permission", {
						pattern: rule.pattern,
						kind,
					})?.skill ?? null)
				: null;
		// Wave 4c unit 4 (plans/3.md §2.3/§5, R7) — the empty-pattern case is
		// PermissionRow's own gate; this only decides whether ANY skill could
		// ever take the item (`eligibleShipTargets`). The seed is a fresh
		// object literal built here, reading `rule.pattern`/`kind` from THIS
		// closure — so once a click stores it, a later edit to `rule` (a new
		// object on the next render) can never move what was already staged.
		const shipTarget = { kind: "permission" as const, pattern: rule.pattern, ruleKind: kind };
		const canShipWith = eligibleShipTargets(registry.data, shipTarget).eligible.length > 0;
		return (
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
				viaSkill={viaSkill}
				onShipWith={
					canShipWith
						? () =>
								shipWith.open(
									{ kind: "permission", pattern: rule.pattern, ruleKind: kind },
									viaSkill,
								)
						: undefined
				}
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
	};

	const totalVisibleRows = visibleTiered.length;

	const saveTooltip = adoptionBlocking
		? "Resolve adoption first"
		: validationErrors.length > 0
			? `Invalid rules: ${validationErrors.map(([k]) => k).join(", ")}`
			: undefined;

	const globalDraft = (globalPermsForInheritance.data ??
		null) as NormalizedPermissions | null;

	// Rule 11 (side-panel language): a closed section must never be the only
	// place a staged edit lives. This is the narrow "did a SETTING change"
	// check — distinct from the whole-draft `dirty` flag, which also covers
	// rules/hooks — against the last-loaded server payload for this scope+tier,
	// so the side panel's Shared/Settings section can force itself open.
	const settingsDirty = permsQuery.data
		? settingsDiffer(draft, permsQuery.data)
		: false;

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
				(draft.hooks ?? []).filter((h) => h.origin === "global").length
			: 0;

	const chrome: PermissionsChrome = {
		scope,
		loading: false,
		dirty,
		saving,
		savedJustNow,
		saveDisabled,
		saveTooltip,
		kindCounts: { allow: stats.allow, deny: stats.deny, ask: stats.ask },
		hookCount: stats.hooks,
		riskCount: risks.length,
		inheritedCount,
		save: () => void save(),
		discard: discardChanges,
		openDoctor: () => setOverlay({ kind: "doctor" }),
		copyToml: () => void copyPermissionsToml(scope, draft),
		openDisable: () => setOverlay({ kind: "disable" }),
	};

	return (
		<div className="permissions-section perm-surface" ref={sectionRef}>
			{renderChrome?.(chrome)}

			{saveError && (
				<div className="perm-alert" role="alert">
					{saveError}
				</div>
			)}
			{/* Post-save sync outcome. The registry write succeeded in both cases —
			    these report what the auto-sync found, not a failed save. */}
			{lastSyncRc === 2 && (
				<div className="perm-alert" data-severity="warning" role="status">
					Applied — the doctor flagged danger findings.{" "}
					<button
						type="button"
						className="perm-alert-action"
						onClick={() => setOverlay({ kind: "doctor" })}
					>
						Open doctor
					</button>
				</div>
			)}
			{lastSyncRc === 1 && (
				<div className="perm-alert" role="alert">
					Saved to the registry, but some native files failed to write — run
					Sync from the status bar for details.
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
						<PermissionsDivergenceBanner
							divergence={divergence}
							syncing={syncing}
							onSync={() => {
								void runSync().then(() => invalidatePerms());
							}}
							onReview={() => setOverlay({ kind: "import" })}
						/>
						{risks.length > 0 && (
							<PermissionsRiskBanner
								risks={risks}
								severity={sectionSeverity}
								onOpenDoctor={() => setOverlay({ kind: "doctor" })}
							/>
						)}
						<PermissionsToolbar
							search={search}
							filter={filter}
							riskCount={risks.length}
							riskSeverity={sectionSeverity}
							onSearch={setSearch}
							onFilter={setFilter}
							onAddRule={addRule}
							onDoctor={() => setOverlay({ kind: "doctor" })}
							onOpenPresets={() => setOverlay({ kind: "presets" })}
							onOpenImport={() => setOverlay({ kind: "import" })}
							onOpenMcp={mcpServers.length ? () => setOverlay({ kind: "mcp", server: mcpServers[0] }) : undefined}
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
									</>
								)}
							</div>
						</main>
						}
						right={
						<PermissionsSidePanel
							scope={scope}
							draft={draft}
							onChange={setDraft}
							installed={installed}
							capabilities={capabilities}
							labels={harnessLabels}
							globalDraft={globalDraft}
							harnessFilter={harnessFilter}
							onHarnessFilter={setHarnessFilter}
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
								(draft.hooks ?? []).filter((h) => h.origin === "global").length
							}
							hookCount={stats.hooks}
							settingsDirty={settingsDirty}
							worktreeSuggestion={scope.kind === "project"
								? (permsQuery.data as PermissionsShowProject | undefined)?.worktree_access_suggestion
								: undefined}
							worktreeStatus={scope.kind === "project"
								? (permsQuery.data as PermissionsShowProject | undefined)?.worktree_access_status
								: undefined}
							personalActive={personalActive}
						/>
						}
						/>
				</>
			)}

			<PermissionsOverlays
				overlay={overlay}
				onClose={() => setOverlay({ kind: "none" })}
				scope={scope}
				projectCount={projectCount}
				harnessLabels={harnessLabels}
				draft={draft}
				personalActive={personalActive}
				saving={saving}
				adoptionBlocking={adoptionBlocking}
				adoptionRequired={adoptionRequired}
				doctor={{
					findings: doctorQuery.data?.findings ?? [],
					loading: doctorQuery.isLoading,
					error: doctorQuery.isError ? String(doctorQuery.error) : null,
				}}
				onInvalidate={invalidatePerms}
				onJumpToFinding={(f: DoctorFinding) => {
					setOverlay({ kind: "none" });
					window.setTimeout(() => {
						const el = sectionRef.current?.querySelector(
							`.permission-row [aria-label="Pattern"][value="${cssEscape(f.detail)}"]`,
						) as HTMLInputElement | null;
						el?.scrollIntoView({ behavior: "smooth", block: "center" });
						// eslint-disable-next-line no-restricted-syntax -- the target permission row is already-mounted (this only closes an overlay above it), the 60ms delay just lets that overlay's own close settle before scrolling/focusing.
						el?.focus();
					}, 60);
				}}
				onApplyPresetRules={(rules: Rule[]) => {
					if (!draft) return;
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
				onConfirmDiscard={() => {
					setOverlay({ kind: "none" });
					doDiscard();
				}}
				onConfirmTrust={() => {
					setOverlay({ kind: "none" });
					void doSave();
				}}
				mcpServers={mcpServers}
				onApplyMcpChanges={async (changes) => {
					const next = await applyMcpChanges(changes);
					if (!next) return false;
					setSearch("");
					setFilter("all");
					setHarnessFilter("all");
					return true;
				}}
			/>
		</div>
	);
}
