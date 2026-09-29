import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { LoadingButton, Spinner } from "@/components/loading";
import { PreviewRefLink } from "@/lib/renderMarkdown";
import { fromNav, projectBackTarget } from "@/lib/backTarget";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessDisplayLabel } from "@/components/harness/harnessRegistry";
import { HarnessManagePopover } from "@/components/harness/HarnessManagePopover";
import { ProjectContextPanel } from "./ProjectContextPanel";
import { ProjectActivityOverview } from "./ProjectActivityOverview";
import { ProjectHooksSheet } from "./ProjectHooksSheet";
import { useProjectLoadoutReturn } from "@/hooks/useProjectLoadoutReturn";
import { projectLoadout } from "@/lib/projectLoadout";
import "./projectLoadout.css";
import { ScreenHeader } from "@/components/ScreenHeader";
import { InlineName } from "@/components/InlineName";
import { FreshnessDot } from "@/components/FreshnessBadge";
import { ResizableSplit } from "@/components/ResizableSplit";
import { type BundleChipAddOption } from "@/components/BundleChip";
import type { ProjectSkillCandidate } from "@/components/ProjectLocalSkills";
import { ProjectLocalSkills } from "@/components/ProjectLocalSkills";
import { useToast } from "@/components/Toast";
import { shortenPath } from "@/lib/shortenPath";
import { SLUG_RE } from "@/lib/paletteVerbs";
import { equipWithGate } from "@/hooks/useCompanionGate";
import { declaredRows, type ReconcileProjectRecord } from "@/lib/companions";
import { trackProcess } from "@/lib/trackProcess";
import { invalidateRegistry } from "@/lib/invalidate";
import { errorDetail } from "@/lib/cliOutput";
import { projectRecord, relTime } from "@/lib/syncFreshness";
import type {
	Freshness,
	MissingRef,
	SyncAffinitySkip,
	SyncReportEnvelope,
} from "@/lib/syncFreshness";
import type { ListNav } from "@/hooks/useListNav";
import type { OverrideChoice } from "@/lib/invocation";
import type { Registry, Project, SkillScope } from "@/types";
import { ProjectOverviewBand } from "@/screens/project/ProjectOverviewBand";
import { MissingSkillsReview } from "@/screens/project/MissingSkillsReview";
import { ProjectGroupedLoadout } from "./ProjectGroupedLoadout";
import { useUsageProject, useUsageFootprint } from "@/hooks/useUsageAnalytics";
import { primaryHarness, useFootprintTokens } from "@/lib/footprintTokens";
import { AvailableSkillsPanel } from "@/screens/project/AvailableSkillsPanel";
import type { EquipStatus } from "@/screens/ProjectWorkspace";

// Concise per-state copy for the header subline (the full "registry changed —
// re-sync" phrasing lives in the StatusBar drawer).
const SYNC_LINE_LABEL: Record<Freshness, string> = {
	fresh: "in sync",
	stale: "registry changed",
	unknown: "run sync",
	error: "sync failed",
	quarantined: "no directory attached",
};

export function ProjectLoadoutView({
	projectName,
	proj,
	registry,
	navigator,
	envExists,
	envPath,
	syncEnvelope,
	freshness,
	equipped,
	globalBundles,
	availableBundles,
	affinitySkips,
	missingRefs,
	companionsReconcile,
	localCandidates,
	installedHarnessIds,
	bundleProvidedSet,
	dragOver,
	equipStatus,
	availQuery,
	expandedAvailable,
	scopeGroups,
	filteredUnequipped,
	availNav,
	availRowIndex,
	onSetDragOver,
	onSetAvailQuery,
	onToggleAvailableDetails,
	onCreateEnvFile,
	onRunSync,
	syncing,
	onRenameProject,
	onOpenEditPath,
	onOpenRepository,
	onOpenRemove,
	onEnableSkill,
	onDisableSkill,
	onApplyBundle,
	onRemoveBundle,
	removingBundles = [],
	onSetInvocationOverride,
	onAdoptCandidate,
	onDrop,
}: {
	projectName: string;
	proj: Project;
	registry: Registry;
	/** The project navigator (area cards), rendered right under the header. */
	navigator: ReactNode;
	envExists: boolean | undefined;
	envPath: string;
	syncEnvelope: SyncReportEnvelope | null | undefined;
	freshness: Freshness;
	equipped: string[];
	globalBundles: [string, Registry["bundles"][string]][];
	availableBundles: BundleChipAddOption[];
	affinitySkips: SyncAffinitySkip[];
	/** Evidence from the last sync report: equipped skills whose references
	 *  this project lacks. `[]` for a clean or never-synced project. */
	missingRefs: MissingRef[];
	/** A16: the last sync's I7 companions reconcile record for this project
	 *  (`projects.<p>.companions` on the sync report). `undefined` for a
	 *  never-synced project or one predating wave 2 — evidence, never a
	 *  client-side prediction (D11). */
	companionsReconcile: ReconcileProjectRecord | undefined;
	localCandidates: ProjectSkillCandidate[] | undefined;
	installedHarnessIds: string[];
	bundleProvidedSet: Set<string>;
	dragOver: "equipped" | "avail" | null;
	equipStatus: Record<string, EquipStatus>;
	availQuery: string;
	expandedAvailable: Set<string>;
	scopeGroups: { scope: SkillScope; label: string; names: string[] }[];
	filteredUnequipped: string[];
	availNav: ListNav;
	availRowIndex: Map<string, number>;
	onSetDragOver: (zone: "equipped" | "avail" | null) => void;
	onSetAvailQuery: (q: string) => void;
	onToggleAvailableDetails: (skillName: string) => void;
	onCreateEnvFile: () => void;
	onRunSync: () => void;
	/** A registry sync is in flight (from ANY surface — the chip, the palette,
	 *  here). The header button shows the shared busy state rather than looking
	 *  idle while `hub sync` writes. */
	syncing: boolean;
	/** Commit a new project name (the header's inline field). Rejects on a
	 *  failed rename so the field stays open with the draft. */
	onRenameProject: (next: string) => Promise<void>;
	onOpenEditPath: () => void;
	onOpenRepository: () => void;
	onOpenRemove: () => void;
	onEnableSkill: (skillName: string) => void;
	onDisableSkill: (skillName: string) => void;
	onApplyBundle: (bundleName: string) => void;
	onRemoveBundle: (bundleName: string) => void;
	removingBundles?: string[];
	onSetInvocationOverride: (
		skillName: string,
		choice: OverrideChoice,
		previous: "auto" | "user-only" | "model-only" | undefined,
	) => void;
	onAdoptCandidate: (cand: ProjectSkillCandidate) => Promise<void>;
	onDrop: (zone: "equipped" | "avail", skillName: string) => void;
}) {
	const navigate = useNavigate();
	const journey = useProjectLoadoutReturn(projectName);
	const restoredAvailableFocus = useRef<string | null>(null);
	const [harnessOpen, setHarnessOpen] = useState(false);
	const model = projectLoadout(proj, registry);
	const effectiveHarnesses = [
		...new Set([
			...(registry.harnesses_global ?? []),
			...(proj.harnesses ?? []),
		]),
	];
	function focusInventory() {
		document
			.querySelector<HTMLInputElement>('[data-testid="loadout-search"]')
			?.focus();
	}
	function showLibrary() {
		journey.update({ panel: "library" });
	}
	function readSkill(name: string) {
		journey.open(`/skill/${encodeURIComponent(name)}`, `available:${name}`, {
			availableQuery: availQuery,
			panel: "library",
		});
	}
	useEffect(() => {
		const focus = journey.state.focus;
		if (
			journey.state.panel !== "library" ||
			!focus?.startsWith("available:") ||
			restoredAvailableFocus.current === focus
		)
			return;
		const index = availRowIndex.get(focus.slice("available:".length));
		if (index !== undefined) availNav.setActiveIndex(index);
		restoredAvailableFocus.current = focus;
	}, [availNav, availRowIndex, journey.state.focus, journey.state.panel]);
	const usageQuery = useUsageProject(projectName, 30);
	const footprintQuery = useUsageFootprint(projectName);
	const usageTokens = useFootprintTokens(
		footprintQuery.data,
		primaryHarness(footprintQuery.data),
	);
	const toast = useToast();
	const [provisioning, setProvisioning] = useState(false);

	// A16/D11: `companionsReconcile.pending` names either a whole
	// companion-shipping skill with no ledger entry at all (a fresh equip) or
	// one of ITS declared companions (a hook/agent/rule added since the last
	// provision) — the reconcile record is a flat list, not skill-grouped
	// (`ships_with_reconcile.py`'s `plan_reconcile`). Resolve it back to the
	// equipped skill(s) it belongs to against the live registry (never guess a
	// bare name is a skill on its own), so `Provision` always names a real
	// skill for `equipWithGate`. `--with-companions` is idempotent (D11), so
	// re-running it for the owning skill fixes up every pending item at once.
	const companionsPending = companionsReconcile?.pending ?? [];
	const pendingSet = new Set(companionsPending);
	// R15/current-shape: I7's `pending` is a flat list, not skill-grouped, so
	// TWO skills can legitimately both match one shared companion name (e.g.
	// the same rule pattern declared twice). Resolving to every plausible
	// owner (never narrowing to "the first" match) is the honest reading of
	// an ambiguous flat list — a false "also pending" is a wasted no-op
	// `Provision` (idempotent, D11), while silently dropping a real owner
	// would leave real work unprovisioned. The coming hub retry groups
	// `pending` per skill (reports/5-u1-hub-w1.md Follow-ups); this resolves
	// against the CURRENT flat shape and will simplify once that lands.
	const pendingSkillNames =
		pendingSet.size === 0
			? []
			: equipped
					.filter((skillName) => {
						if (pendingSet.has(skillName)) return true;
						const sw = registry.skills[skillName]?.ships_with;
						return (
							!!sw && declaredRows(sw).some((row) => pendingSet.has(row.name))
						);
					})
					.sort((a, b) => a.localeCompare(b));
	const provisionLabel =
		pendingSkillNames.length === 1
			? `Provision ${pendingSkillNames[0]}`
			: `Provision all ${pendingSkillNames.length}`;
	// W9/A22: a skill reached only via a bundle (not in `proj.enabled`) stays
	// that way when its companions are provisioned — `--with-companions`
	// never appends it to `enabled`. Naming that up front so the click never
	// surprises the reader with a newly "direct" card in the grid.
	const bundleOnlyPending = pendingSkillNames.filter(
		(name) => bundleProvidedSet.has(name) && !proj.enabled.includes(name),
	);
	const bundleOnlyNote = bundleOnlyPending.length > 0
		? " Bundle skills stay applied via bundle."
		: "";
	// R14: never drop the evidence. A pending name that resolves to no
	// currently-equipped skill (unequipped since the last sync, a global-scope
	// companion, a stale row the ledger hasn't caught up to) still reports —
	// as a name-only line with no `Provision` (there is no real skill to call
	// `equipWithGate` with).
	const unresolvedPending =
		pendingSkillNames.length === 0 && companionsPending.length > 0;
	const rawPendingSorted = [...companionsPending].sort((a, b) =>
		a.localeCompare(b),
	);
	const rawPendingTruncated = rawPendingSorted.length > 3;
	const namedRawPending = rawPendingTruncated
		? `${rawPendingSorted.slice(0, 3).join(", ")}, +${rawPendingSorted.length - 3} more`
		: rawPendingSorted.join(", ");

	// A22/C1: every `Provision` affordance calls the gate with NO `force` — the
	// consequence dialog (which also carries the Codex trust row) IS the
	// consent. `force` stays reserved for `ProjectWorkspace`'s disable-undo
	// replay. One `equipWithGate` per pending skill (idempotent, D11), inside
	// one `trackProcess` so the StatusBar shows a single busy segment.
	async function handleProvision() {
		setProvisioning(true);
		try {
			await trackProcess(
				{
					title: `Provisioning ${pendingSkillNames.length} on ${projectName}…`,
					kind: "batch",
				},
				async () => {
					for (const skillName of pendingSkillNames) {
						await equipWithGate(skillName, projectName);
					}
				},
			);
			toast.success(
				`Provisioned ${pendingSkillNames.length} on ${projectName}`,
			);
		} catch (err) {
			// The gate refuses to open a second dialog rather than clobber the one
			// already open for a different equip — re-toast instead of a raw
			// error, never swallow it silently. Same check + wording as
			// `ShipsWithSection.tsx`'s own `handleProvision` (the section's
			// `Provision` rung), so the two `Provision` affordances read as one
			// feature.
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("already open")) {
				toast.info("Another equip is open — finish it first.");
			} else {
				toast.error("Couldn't provision companions", errorDetail(err).headline);
			}
		} finally {
			await invalidateRegistry();
			setProvisioning(false);
		}
	}

	return (
		<>
			<ScreenHeader
				leading={<span className="project-dot" />}
				nameMono={
					// The name edits where it is read: a rename is rare and cheap to
					// reverse, so it gets an inline field + undo, not a dialog.
					<InlineName
						value={projectName}
						label="Project name"
						onSave={onRenameProject}
						validate={(next) =>
							!SLUG_RE.test(next)
								? "Use lowercase letters, numbers and hyphens"
								: next in registry.projects
									? "A project with this name already exists"
									: null
						}
					/>
				}
				meta={
					<div className="loadout-header-meta">
						<Button variant="ghost" size="sm" onClick={focusInventory}>
							{model.skills.length} skills · {model.mcp.length} MCPs
							{model.unresolved.length
								? ` · ${model.unresolved.length} missing`
								: ""}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							aria-label="Manage project harnesses"
							onClick={() => setHarnessOpen(true)}
						>
							{effectiveHarnesses.map((id) => (
								<HarnessGlyph
									key={id}
									id={id}
									label={harnessDisplayLabel(id)}
									size={16}
								/>
							))}
							{!effectiveHarnesses.length && "Add harness"}
						</Button>
					</div>
				}
				crumbs={[
					// The path needs the native folder picker, so its click opens the
					// Edit path dialog; the crumb itself carries the hover affordance.
					<button
						type="button"
						className="crumb-path crumb-path-edit"
						key="path"
						aria-label={`Edit project path: ${proj.path}`}
						onClick={onOpenEditPath}
					>
						{/* The pencil takes the folder's own slot on hover, so the crumb
						    never changes width between rest and hover. */}
						<span className="crumb-glyph-swap" aria-hidden="true">
							<Icon name="folder" size={11} className="crumb-glyph-rest" />
							<Icon name="edit" size={11} className="crumb-edit-glyph" />
						</span>
						<span className="path has-tip">
							<span className="path-text">{shortenPath(proj.path)}</span>
							<span className="path-tip" role="tooltip">
								{proj.path}
							</span>
						</span>
					</button>,
					...(envExists === true
						? [
								<button
									key="env"
									className="crumb-env"
									title="Open .env in default app"
									onClick={() => void openPath(envPath)}
								>
									<Icon name="doc" size={10} />
									.env
								</button>,
							]
						: envExists === false
							? [
									<button
										key="env-add"
										className="crumb-env crumb-env-add"
										title="Create empty .env"
										onClick={() => void onCreateEnvFile()}
									>
										<Icon name="plus" size={10} />
										.env
									</button>,
								]
							: []),
				]}
				subline={
					// The sync verdict sits next to the Sync button and the last-sync
					// time: one process, one place. While a sync runs it reports the
					// work, not the last verdict (see useRunSync).
					<span className="project-sync-line">
						{syncing ? (
							<>
								<Spinner size={7} color="var(--fg-mid)" />
								<span role="status">syncing…</span>
							</>
						) : (
							<>
								<FreshnessDot state={freshness} size={7} />
								<span>{SYNC_LINE_LABEL[freshness]}</span>
							</>
						)}
						<span aria-hidden="true">·</span>
						<span>
							last sync {relTime(projectRecord(projectName, syncEnvelope)?.ts)}
						</span>
					</span>
				}
				primary={
					<div className="loadout-header-actions">
						<Button
							size="sm"
							variant="ghost"
							icon="hook"
							aria-label="Hooks"
							onClick={() => journey.update({ hooks: true })}
						>
							Hooks
						</Button>
						<LoadingButton
							variant="soft"
							icon="refresh"
							loading={syncing}
							loadingLabel="Syncing…"
							aria-label={syncing ? "Syncing…" : "Sync"}
							onClick={onRunSync}
						>
							Sync
						</LoadingButton>
						<Button
							size="sm"
							variant="primary"
							icon="plus"
							aria-label="Add skills"
							onClick={showLibrary}
						>
							Add skills
						</Button>
					</div>
				}
				overflow={[
					{ icon: "harness", label: "Manage harnesses", onClick: () => setHarnessOpen(true) },
					{
						icon: "edit",
						label: "Edit path",
						onClick: onOpenEditPath,
					},
					{
						icon: "source.git",
						label: "Repository…",
						onClick: onOpenRepository,
					},
					{
						icon: "folder",
						label: "Reveal in Finder",
						onClick: () => void revealItemInDir(proj.path),
					},
					{ divider: true },
					{
						icon: "trash",
						label: "Remove project",
						danger: true,
						onClick: onOpenRemove,
					},
				]}
			/>

			<div className="project-loadout-navigation">{navigator}</div>
			<ResizableSplit
				className={`workspace-grid project-loadout-overview ${journey.state.panel === "library" ? "loadout-library-open" : ""}`}
				fixedPane="right"
				collapsible={false}
				storageKey="st:layout:project-workspace"
				defaultRightPx={320}
				minRightPx={280}
				maxRightPx={520}
				paneLabel={
					journey.state.panel === "library" ? "Available" : "Project overview"
				}
				handleAriaLabel="Resize project side panel"
				left={
					<>
						<div className="workspace-main loadout-overview-main">
							<ProjectOverviewBand
								projectName={projectName}
								proj={proj}
								registry={registry}
								globalBundles={globalBundles}
								availableBundles={availableBundles}
								onApplyBundle={onApplyBundle}
								onRemoveBundle={onRemoveBundle}
								removingBundles={removingBundles}
								open={journey.open}
							/>
							<section className="ws-band ws-band-loadout">
								{/* F1/A6: sync refuses this project (no such local directory —
								    often a restored backup on a different machine, or a moved
								    checkout). The loadout, bundles, and settings stay exactly as
								    saved; only delivery is stale until a directory is attached.
								    Neutral, not amber (COMPONENTS.md §Accents) — quarantine is an
								    expected recovery state, not a risk severity. */}
								{freshness === "quarantined" && (
									<div className="project-unattached-banner" role="status">
										<Icon name="folder" size={14} />
										<span>
											<strong>No local directory attached.</strong> Sync makes
											no writes here until you attach one.
										</span>
										<button
											type="button"
											className="project-unattached-link"
											onClick={() => navigate(`/recovery?project=${encodeURIComponent(projectName)}`)}
										>
											Attach directory →
										</button>
									</div>
								)}

								{/* M8: equipped skills that won't reach any harness (from the
								    last sync report's affinity_skips). Links to harness config. */}
								{affinitySkips.length > 0 && (
									<div className="affinity-skip-banner" role="status">
										<Icon name="warning" size={14} />
										<span>
											<strong>
												{affinitySkips.length} equipped skill
												{affinitySkips.length === 1 ? "" : "s"}
											</strong>{" "}
											won't reach any harness — no installed harness matches
											their <span className="text-mono">harnesses:</span>{" "}
											affinity.
										</span>
										<button
											type="button"
											className="affinity-skip-link"
											onClick={() => navigate("/harnesses")}
										>
											Configure harnesses →
										</button>
									</div>
								)}

								{/* skill-refs: equipped skills that reference a registry skill
								    this project does not have (from the last sync report's
								    missing_refs). Names the consequence before the click. */}
								<MissingSkillsReview
									key={projectName}
									projectName={projectName}
									registry={registry}
									missingRefs={missingRefs}
									equipped={equipped}
								/>

								{/* A16/D11: pending `ships_with` companions per the last sync's
								    reconcile record — evidence, never a client-side prediction.
								    R16: neutral, never amber — a pending provision is neither
								    direct-equip provenance nor a risk severity (COMPONENTS.md
								    §Accents "Amber is provenance-only"), so this is its own
								    sibling class, not `.missing-refs-banner`. R14: still renders
								    (name-only, no action) when nothing resolves to an equipped
								    skill, so the evidence is never silently dropped. */}
								{companionsPending.length > 0 && (
									<div
										className="companions-pending-banner"
										data-testid="companions-pending-banner"
										role="status"
									>
										<Icon name="info" size={14} />
										<span className="companions-pending-copy">
											{/* R13: the noun counts every pending companion
											    (`companionsPending`), never the skills that own
											    them (`pendingSkillNames`) — a skill with three
											    pending companions is "3 pending companions", not
											    "1". */}
											<strong>
												{companionsPending.length} pending companion
												{companionsPending.length === 1 ? "" : "s"}
											</strong>{" "}
											for{" "}
											{unresolvedPending ? (
												<>
													{namedRawPending} — no longer matches an equipped
													skill on this project; re-sync to refresh.
												</>
											) : (
												<>
													{pendingSkillNames.map((name, index) => (
														<span key={name}>
															{index > 0 && ", "}
															<PreviewRefLink
																name={name}
																label={name}
																form="backtick"
																refs={{
																	names: pendingSkillNames,
																	describe: (skill) => registry.skills[skill]?.description ?? "",
																	onOpen: (skill) => navigate(`/skill/${encodeURIComponent(skill)}`, fromNav(projectBackTarget(projectName))),
																}}
															/>
														</span>
													))}.{bundleOnlyNote}
												</>
											)}
										</span>
										{!unresolvedPending && (
											<LoadingButton
												variant="ghost"
												size="sm"
												className="missing-refs-link"
												loading={provisioning}
												loadingLabel="Provisioning…"
												onClick={() => void handleProvision()}
											>
												{provisionLabel}
											</LoadingButton>
										)}
									</div>
								)}

								{/* Detected, not-yet-adopted local skills */}
								{localCandidates && localCandidates.length > 0 && (
									<ProjectLocalSkills
										candidates={localCandidates}
										onAdopt={onAdoptCandidate}
									/>
								)}

								<ProjectActivityOverview
									projectName={projectName}
									skills={model.skills}
									area={journey.area}
									pick={(name) => {
										journey.update({ query: name, exact: name, source: "" });
										requestAnimationFrame(focusInventory);
									}}
								/>
								<ProjectGroupedLoadout
									state={journey.state}
									update={journey.update}
									open={journey.open}
									projectName={projectName}
									proj={proj}
									registry={registry}
									onSetDragOver={onSetDragOver}
									onDrop={onDrop}
									installedHarnessIds={installedHarnessIds}
									equipStatus={equipStatus}
									missingRefs={missingRefs}
									onSetInvocationOverride={onSetInvocationOverride}
									onDisableSkill={onDisableSkill}
									usage={usageQuery.data}
									footprintTokens={usageTokens}
								/>
							</section>
						</div>
					</>
				}
				right={
					journey.state.panel === "overview" ? (
						<ProjectContextPanel
							projectName={projectName}
							proj={proj}
							registry={registry}
							area={journey.area}
							open={journey.open}
							manageHooks={() => journey.update({ hooks: true })}
						/>
					) : (
						<div className="loadout-library-panel">
							<AvailableSkillsPanel
                onClose={() => {
                  journey.update({ panel: "overview" });
                  // eslint-disable-next-line no-restricted-syntax -- called from a click handler: React flushes `journey.update` synchronously before yielding, and the rAF always runs after that commit and before the next paint, so the overview's primary button (mounted by this same panel switch) is already in the DOM.
                  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".loadout-header-actions .btn-primary")?.focus());
                }}
								registry={registry}
								availQuery={availQuery}
								onSetAvailQuery={onSetAvailQuery}
								filteredUnequipped={filteredUnequipped}
								dragOver={dragOver}
								onSetDragOver={onSetDragOver}
								onDrop={onDrop}
								scopeGroups={scopeGroups}
								availNav={availNav}
								availRowIndex={availRowIndex}
								equipStatus={equipStatus}
								expandedAvailable={expandedAvailable}
								onToggleAvailableDetails={onToggleAvailableDetails}
								onEnableSkill={onEnableSkill}
								onReadSkill={readSkill}
							/>
						</div>
					)
				}
			/>
			<ProjectHooksSheet
				projectName={projectName}
				open={journey.state.hooks}
				onClose={() => journey.update({ hooks: false })}
				navigate={journey.open}
			/>
			<HarnessManagePopover
				open={harnessOpen}
				onClose={() => setHarnessOpen(false)}
				projectName={projectName}
				projectPath={proj.path}
				globalHarnesses={registry.harnesses_global ?? []}
				projectHarnesses={proj.harnesses ?? []}
			/>
		</>
	);
}
