import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { ConfirmDialog } from "./Modal";
import { AgentDocsFixBanner } from "./AgentDocsFixBanner";
import { ScreenHeader } from "./ScreenHeader";
import { StatePill } from "./StatePill";
import { primaryHarness, useFootprintTokens } from "@/lib/footprintTokens";
import { useUsageFootprint } from "@/hooks/useUsageAnalytics";
import { useToast } from "./Toast";
import {
	resolveAgentDocDirMeta,
	useAgentDocsListing,
} from "@/hooks/useAgentDocs";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useRegistry } from "@/hooks/useRegistry";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { SkillRefsSection } from "./skillEditor/SkillRefsSection";
import { projectAgentDocsBackTarget } from "@/lib/backTarget";
import { useUnsavedGuard } from "@/lib/navGuard";
import type {
	AgentDocFile,
	AgentDocInstructionSet,
} from "@/types/agentDocs";
import { estimateTokens } from "@/lib/estimateTokens";
import {
	ancestorDirs,
	buildAgentDocMap,
	setRels,
	type AgentDocMapNode,
} from "@/lib/agentDocMap";
import { ResizableSplit } from "./ResizableSplit";
import { HarnessAgentStrip } from "./harness/HarnessAgentStrip";
import {
	EMPTY_FOLDER,
	editableRelForSet,
	flattenFiles,
	isDeviating,
	readBrowseMode,
	writeBrowseMode,
} from "./agentDocs/agentDocHelpers";
import { AgentDocModal } from "./agentDocs/AgentDocModal";
import { useTokenPulse } from "@/hooks/useTokenPulse";
import { useAgentDocBuffers } from "@/hooks/useAgentDocBuffers";
import { AgentDocsMapPane } from "./agentDocs/AgentDocsMapPane";
import { AgentDocsEditorPane } from "./agentDocs/AgentDocsEditorPane";
import { useProjectReview } from "@/screens/project/ProjectReviewProvider";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Buffer {
	content: string;
	baseline: string;
	loadedHash: string | null;
	loadedAtTs: number;
	isNew: boolean;
	/** True when the backend classified the loaded file as a hub-derived
	 *  `CLAUDE.md` (symlink to `AGENTS.md`, or a `@AGENTS.md` import pointer).
	 *  The editor renders a read-only stub for these and redirects edits to
	 *  the canonical source. */
	isDerivedPointer?: boolean;
}

export type Conflict = {
	rel: string;
	currentHash: string;
};

export type PendingDiscard = (() => void) | null;

interface Props {
	projectName: string;
	projectPath: string;
	/** The project navigator (area cards, folded), rendered under the header. */
	navigator?: ReactNode;
	/** Combined effective harness ids (global ∪ project). */
	projectHarnesses: string[];
	/** Harnesses enabled globally (for the strip's Manage popover). */
	globalHarnesses?: string[];
	/** Per-project harness list (for the strip's Manage popover). */
	ownHarnesses?: string[];
}


// ─── Main view ──────────────────────────────────────────────────────────────

export function AgentDocsView({
	projectName,
	projectPath,
	navigator,
	projectHarnesses,
	globalHarnesses = [],
	ownHarnesses = [],
}: Props) {
	const toast = useToast();
	const review = useProjectReview();
	const queryClient = useQueryClient();
	const allHarnesses = useHarnesses();
	const registryQuery = useRegistry();
	const registry = registryQuery.data;
	const publishOnSave =
		registry?.projects?.[projectName]?.agent_docs?.publish_on_save ?? false;
	// A referrer returning from `/skill/:name` carries the file that was open
	// (`projectAgentDocsBackTarget`'s `restore.adSelected`) — read once, off
	// the location this view mounted with. Only a non-empty string is honoured;
	// `useAgentDocBuffers` itself decides whether the rel still exists.
	const location = useLocation();
	const restoreState = location.state as { adSelected?: unknown } | null;
	const initialSelected =
		typeof restoreState?.adSelected === "string" && restoreState.adSelected
			? restoreState.adSelected
			: null;
	const [showAllMarkdown, setShowAllMarkdown] = useState(false);
	const [filter, setFilter] = useState("");
	const [includeIgnored, setIncludeIgnored] = useState(false);
	const listing = useAgentDocsListing(
		projectPath,
		showAllMarkdown,
		true,
		includeIgnored,
	);
	const footprint = useUsageFootprint(projectName);
	const tokens = useFootprintTokens(
		footprint.data?.ok ? footprint.data : undefined,
		primaryHarness(footprint.data?.ok ? footprint.data : undefined),
	);
	// The other mode's index, so a filter that matches nothing here can say
	// where the matches actually are instead of reporting "no results" for a
	// file that exists. Only fetched while a filter is active.
	const otherListing = useAgentDocsListing(
		projectPath,
		!showAllMarkdown,
		filter.trim().length > 0,
		includeIgnored,
	);

	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const data = listing.data;
	const bufHook = useAgentDocBuffers({
		projectPath,
		data,
		toast,
		queryClient,
		initialSelected,
		publishOnSave,
	});

	// Skill cross-references for the live buffer. `back` is safe as an inline
	// literal — `useSkillRefs` memoizes on its VALUES, not identity — and this
	// is keyed on `bufHook.selected`/its content the same way the skill editor
	// keys its own call. Called a second time inside `SkillRefsSection` below
	// for the strip; the hook holds no state, so the two calls can never
	// disagree (same contract the skill editor's side panel relies on).
	const refs = useSkillRefs({
		host: {
			back: projectAgentDocsBackTarget(projectName, bufHook.selected),
		},
		content: bufHook.selectedBuffer?.content ?? "",
		registry,
	});
	const refsStrip = registry ? (
		<SkillRefsSection
			host={{
				back: projectAgentDocsBackTarget(projectName, bufHook.selected),
			}}
			content={bufHook.selectedBuffer?.content ?? ""}
			registry={registry}
			layout="strip"
		/>
	) : null;

	// The busiest exit from a dirty buffer is not a navigation at all — it's
	// the project area strip switching `view` (component state one level up,
	// in ProjectWorkspace). That switch is wrapped in `attemptNavigation`
	// there, which is exactly what this guard intercepts, alongside every
	// in-app router navigation (rail, palette, chords, the back arrow).
	const leaveGuard = useUnsavedGuard(bufHook.dirtyRels.size > 0);
	const leaveDirtyCount = bufHook.dirtyRels.size;

	// Reset the component's own slice of state when the project changes. The
	// buffer/selection/conflict slice resets in useAgentDocBuffers's own
	// effect — splitting one effect into two independently-owned ones is
	// behaviour-identical here since neither slice reads the other's state.
	useEffect(() => {
		setExpanded({});
		setFilter("");
		setIncludeIgnored(false);
		setShowAllMarkdown(readBrowseMode(projectPath));
	}, [projectPath]);


	// ── Derived ──
	const allRels = data?.all_rels ?? [];
	// External targets have no project rel, so they get their own group rather
	// than a fabricated one: rels are what read/write confinement is expressed
	// in, and inventing one for a path outside the project would be a lie the
	// backend would then have to refuse.
	const externalImports = useMemo(
		() => data?.external_imports ?? [],
		[data?.external_imports],
	);
	const fileMap = useMemo(() => {
		if (!data) return new Map<string, AgentDocFile>();
		const m = new Map<string, AgentDocFile>();
		for (const f of flattenFiles(data.root)) m.set(f.rel, f);
		return m;
	}, [data]);

	// Computed from what the agent actually loads — instruction files and
	// resolved imports — not from every markdown file in the project. Summing
	// `all_rels` counted a browse listing's entire index as loaded context, and
	// the figure climbed as folders were expanded, firing the changed-on-disk
	// pulse on nothing at all. This set is eagerly sized in both modes, so the
	// number is stable while browsing.
	// The split (root chain vs. discoverable) is shared with the project area
	// strip's Agent Docs card, so the two never disagree about the number.
	const tokenSummary = tokens
		? { upfront: tokens.upfront, discoverable: tokens.discoverable }
		: null;
	const tokenUnavailable = footprint.isError || footprint.data?.ok === false;

	const { pulseUpfront, pulseDisc } = useTokenPulse(
		!!data && !!tokens,
		tokenSummary ?? { upfront: 0, discoverable: 0 },
	);

	// ── Layout verdicts — read straight from the scanner, never re-derived ──
	const policy = data?.policy ?? null;
	const instructionSets = showAllMarkdown ? [] : (data?.instruction_sets ?? []);
	const rootSet =
		instructionSets.find((s) => s.relative_dir === "") ?? null;
	const deviations = useMemo(
		() => instructionSets.filter(isDeviating),
		[instructionSets],
	);
	const allCanonical = instructionSets.length > 0 && deviations.length === 0;
	// The root pair folds into one unified row only when the scanner says the
	// layout is canonical (real AGENTS.md + derived CLAUDE.md).
	const unifyRootMode =
		!showAllMarkdown && policy?.derived && rootSet?.verdict === "canonical"
			? policy.strategy
			: null;

	// Per-harness display info
	const harnessRows = projectHarnesses
		.map((id) => {
			const meta = (allHarnesses ?? []).find((h) => h.id === id);
			return { id, label: meta?.label ?? id };
		})
		.filter((x) => x.id);

	// One tree for both modes: directories, instruction sets, and file rows.
	const mapTree = useMemo(
		() =>
			buildAgentDocMap({
				root: data?.root ?? EMPTY_FOLDER,
				sets: instructionSets,
				allMarkdown: showAllMarkdown,
				resolved: bufHook.resolvedMeta,
			}),
		[data?.root, instructionSets, showAllMarkdown, bufHook.resolvedMeta],
	);

	// Every rel the active view can render — files plus the rows an instruction
	// set stands in for. This is what the filter matches against.
	const viewRels = useMemo(() => {
		const out = new Set<string>(allRels);
		for (const s of instructionSets) for (const r of setRels(s)) out.add(r);
		return out;
	}, [allRels, instructionSets]);

	const query = filter.trim().toLowerCase();
	const match = useMemo(() => {
		if (!query) return null;
		const rels = new Set<string>();
		for (const rel of viewRels) {
			if (rel.toLowerCase().includes(query)) rels.add(rel);
		}
		return { rels, dirs: ancestorDirs(rels) };
	}, [query, viewRels]);

	// Matches that exist only in the OTHER mode. Reporting "no results" for a
	// file that is right there behind a toggle is the original bug in a new hat.
	const hiddenMatchCount = useMemo(() => {
		if (!query) return 0;
		const other = otherListing.data;
		if (!other) return 0;
		const here = match?.rels ?? new Set<string>();
		let n = 0;
		for (const rel of other.all_rels) {
			if (here.has(rel)) continue;
			if (rel.toLowerCase().includes(query)) n += 1;
		}
		return n;
	}, [query, otherListing.data, match]);

	// An external row is still a row: a filter that leaves it standing while
	// hiding everything else reads as "this is your only match".
	const visibleExternalImports = useMemo(() => {
		if (!query) return externalImports;
		return externalImports.filter((f) =>
			f.absolute_path.toLowerCase().includes(query),
		);
	}, [externalImports, query]);

	const hasVisibleMatch =
		match !== null &&
		(match.rels.size > 0 ||
			(!showAllMarkdown && visibleExternalImports.length > 0));

	// ── Resolve metadata for directories that are actually on screen ──
	const defaultOpen = !showAllMarkdown;
	const isNodeOpen = useCallback(
		(path: string) => expanded[path] ?? (match ? true : defaultOpen),
		[expanded, match, defaultOpen],
	);
	const visiblePendingDirs = useMemo(() => {
		const out: string[] = [];
		const visit = (n: AgentDocMapNode) => {
			if (n.hasPendingMeta) out.push(n.path);
			for (const c of n.children) if (isNodeOpen(c.path)) visit(c);
		};
		visit(mapTree);
		return out;
	}, [mapTree, isNodeOpen]);

	// Keyed on the listing instance: a refetch must re-resolve, since noticing
	// an external write is the whole point of not caching the listing.
	const requestedDirs = useRef<{ token: unknown; dirs: Set<string> }>({
		token: null,
		dirs: new Set(),
	});
	// `dataUpdatedAt`, not the data object: react-query structurally shares an
	// unchanged result, and a browse-only row carries no metadata in the
	// listing, so an external edit to one leaves the listing byte-identical.
	// Keying on the object would miss precisely the case this reset is for.
	const fetchedAt = listing.dataUpdatedAt;
	useEffect(() => {
		if (!data) return;
		if (requestedDirs.current.token !== fetchedAt) {
			requestedDirs.current = { token: fetchedAt, dirs: new Set() };
			// Dropping the resolved sizes is what makes the reset effective.
			// Leaving them would keep `hasPendingMeta` false for every directory
			// already resolved, so nothing would be re-requested and the row
			// would show its pre-edit size for the rest of the session — and a
			// stale entry also overwrites the fresh size the listing stat'd
			// eagerly for an instruction file in the same directory.
			bufHook.setResolvedMeta((prev) => (prev.size === 0 ? prev : new Map()));
			return;
		}
		const todo = visiblePendingDirs.filter(
			(d) => !requestedDirs.current.dirs.has(d),
		);
		if (todo.length === 0) return;
		for (const dir of todo) requestedDirs.current.dirs.add(dir);
		const token = fetchedAt;
		// Deliberately NOT cancelled on cleanup. This effect re-runs whenever
		// another folder opens, and a cleanup that dropped the in-flight result
		// would strand the directory that requested it: it is already recorded
		// as requested, so nothing would ever ask again and its rows would sit
		// pending forever. Merging is idempotent; the token check is what keeps
		// a previous listing's answer from landing on a newer one.
		for (const dir of todo) {
			void resolveAgentDocDirMeta(projectPath, dir)
				.catch(() => [] as AgentDocFile[])
				.then((files) => {
					if (files.length === 0) return;
					if (requestedDirs.current.token !== token) return;
					bufHook.setResolvedMeta((prev) => {
						const next = new Map(prev);
						for (const f of files) next.set(f.rel, f);
						return next;
					});
				});
		}
	}, [data, fetchedAt, visiblePendingDirs, projectPath]);

	const selectedSet = bufHook.selected
		? (instructionSets.find((set) =>
				(["CLAUDE", "AGENT"] as const).some(
					(format) => set.formats[format].file?.rel === bufHook.selected,
				),
			) ?? null)
		: null;

	// Selected file derived state
	const selectedFile = bufHook.selected
		? (fileMap.get(bufHook.selected) ?? null)
		: null;
	const selectedTokenCount = useMemo(
		() => estimateTokens(bufHook.selectedBuffer?.content ?? ""),
		[bufHook.selectedBuffer?.content],
	);

	const saveLabel = bufHook.selectedBuffer?.isNew ? "Create" : "Save";
	// A dirty buffer must never be written from a view where its row does not
	// exist. `read/write_agent_doc` accept any markdown rel, so before the two
	// trees merged a buffer for `docs/architecture.md` survived a flip to the
	// default mode and ⌘S still wrote it — invisibly.
	const selectedHasRow =
		!data || !bufHook.selected || viewRels.has(bufHook.selected);
	const saveDisabled =
		!bufHook.selectedBuffer ||
		!selectedHasRow ||
		bufHook.saving ||
		(!bufHook.selectedDirty && !bufHook.selectedBuffer.isNew);

	// ── Actions ──

	// One key namespace (the directory path) shared by both modes, so an
	// explicit expand/collapse survives a mode flip. The DEFAULT differs per
	// mode — open in the instruction map, closed while browsing — which is why
	// the caller passes the state it actually rendered.
	const toggleExpanded = useCallback(
		(path: string, currentlyOpen: boolean) => {
			setExpanded((e) => ({ ...e, [path]: !currentlyOpen }));
		},
		[],
	);

	const selectFileCb = useCallback(
		(rel: string) => bufHook.setSelected(rel),
		[bufHook.setSelected],
	);
	const selectSetCb = useCallback(
		(set: AgentDocInstructionSet) =>
			bufHook.setSelected(editableRelForSet(set)),
		[bufHook.setSelected],
	);

	// Flipping browse mode used to clear selection AND expansion; now it
	// carries `expanded` across untouched. `expanded` holds only EXPLICIT
	// choices, which is exactly what should survive — an earlier version also
	// materialized each mode's implicit default, and since browse mode defaults
	// closed, opening a project that was last left in browse mode and toggling
	// it off recorded every directory as collapsed and rendered the instruction
	// map, whose default is open, fully shut.
	const changeBrowseMode = useCallback(
		(next: boolean) => {
			setShowAllMarkdown(next);
			writeBrowseMode(projectPath, next);
		},
		[projectPath],
	);

	// ⌘S
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				if (saveDisabled) {
					e.preventDefault();
					return;
				}
				e.preventDefault();
				bufHook.save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [saveDisabled, bufHook.selected, bufHook.selectedBuffer?.content]);

	// ── Render ──
	const existingCount = allRels.filter((r) => fileMap.get(r)?.exists).length;
	const mapTitle = showAllMarkdown ? "Markdown files" : "Instruction map";
	const mapCount = showAllMarkdown
		? `${existingCount} files`
		: instructionSets.length > 0
			? `${instructionSets.length} sets`
			: `${existingCount}/${allRels.length}`;

	return (
		<>
			<ScreenHeader
				leading={<span className="project-dot" />}
				nameMono={projectName}
				state={
					bufHook.selectedDirty ? (
						<StatePill state="unsaved">UNSAVED</StatePill>
					) : null
				}
				crumbs={[
					<span className="crumb-path" key="path">
						<Icon name="folder" size={11} />
						<span className="path" title={projectPath}>
							{projectPath}
						</span>
					</span>,
				]}
				subline="Agent Docs · disk is source of truth"
				primary={
					<Button
						variant="primary"
						icon={bufHook.selectedBuffer?.isNew ? "plus" : "check"}
						kbd="⌘S"
						disabled={saveDisabled}
						busy={bufHook.saving}
						onClick={bufHook.save}
						data-testid="agent-docs-save"
					>
						{saveLabel}
					</Button>
				}
				overflow={[
					{
						icon: "refresh",
						label: "Refresh from disk",
						onClick: bufHook.refresh,
					},
					{
						icon: "folder",
						label: "Reveal in Finder",
						onClick: () => void revealItemInDir(projectPath),
					},
				]}
			/>
			{navigator}

			{/* Status line — quiet when canonical */}
			<div
				className={`agent-docs-strip${review.isParticipating("agent-docs") ? " agent-docs-review" : ""}`}
				data-review-area={review.isParticipating("agent-docs") ? "agent-docs" : undefined}
			>
				<HarnessAgentStrip
					projectName={projectName}
					projectPath={projectPath}
					globalHarnesses={globalHarnesses}
					projectHarnesses={ownHarnesses}
					effectiveHarnesses={harnessRows.map((h) => ({
						id: h.id,
						label: h.label,
					}))}
					policy={policy}
					allCanonical={allCanonical}
					publishInfo={
						publishOnSave
							? {
									project: projectName,
									enabled: true,
									remote: "origin",
									branch: "main",
								}
							: null
					}
				/>
			</div>

			{/* The single conditional banner — renders only on deviation */}
			{policy && deviations.length > 0 && (
				<AgentDocsFixBanner
					projectName={projectName}
					projectPath={projectPath}
					policy={policy}
					deviations={deviations}
					anyDirty={bufHook.anyDirty}
					onMutated={() => void bufHook.reloadSelectedSilently()}
				/>
			)}

			{/* Body */}
			<ResizableSplit
				className={`agent-docs-grid${review.isParticipating("agent-docs") ? " agent-docs-review" : ""}`}
				storageKey="st:layout:agent-docs-map"
				defaultLeftPx={304}
				minLeftPx={220}
				maxLeftPx={600}
				handleAriaLabel="Resize Agent Docs map"
				paneLabel="Map"
				left={
					<AgentDocsMapPane
						mapTitle={mapTitle}
						mapCount={mapCount}
						filter={filter}
						onSetFilter={setFilter}
						showAllMarkdown={showAllMarkdown}
						onChangeBrowseMode={changeBrowseMode}
						data={data}
						onSetIncludeIgnored={setIncludeIgnored}
						includeIgnored={includeIgnored}
						projectName={projectName}
						listing={listing}
						instructionSets={instructionSets}
						mapTree={mapTree}
						unifyRootMode={unifyRootMode}
						selected={bufHook.selected}
						selectedSet={selectedSet}
						dirtyRels={bufHook.dirtyRels}
						dirtyDirs={bufHook.dirtyDirs}
						externalEditTarget={bufHook.externalEditTarget}
						onSelectFile={selectFileCb}
						onSelectSet={selectSetCb}
						toggleExpanded={toggleExpanded}
						isNodeOpen={isNodeOpen}
						match={match}
						visibleExternalImports={visibleExternalImports}
						query={query}
						hiddenMatchCount={hiddenMatchCount}
						otherListing={otherListing}
						hasVisibleMatch={hasVisibleMatch}
						selectedBuffer={bufHook.selectedBuffer}
						selectedFile={selectedFile}
						pulseUpfront={pulseUpfront}
						tokenSummary={tokenSummary}
						tokenUnavailable={tokenUnavailable}
						pulseDisc={pulseDisc}
					/>
				}
				right={
					<AgentDocsEditorPane
						selected={bufHook.selected}
						selectedBuffer={bufHook.selectedBuffer}
						selectedDirty={bufHook.selectedDirty}
						externallyChanged={bufHook.externallyChanged}
						markerIssue={bufHook.markerIssue}
						editorMode={bufHook.editorMode}
						onSetEditorMode={bufHook.setEditorMode}
						selectedFile={selectedFile}
						projectPath={projectPath}
						selectedSet={selectedSet}
						onSelectFile={selectFileCb}
						loadingRel={bufHook.loadingRel}
						showAllMarkdown={showAllMarkdown}
						policy={policy}
						onEditBuf={bufHook.editBuf}
						projectName={projectName}
						onReloadSelectedSilently={() => void bufHook.reloadSelectedSilently()}
						selectedTokenCount={selectedTokenCount}
						refs={refs}
						refsStrip={refsStrip}
					/>
				}
			/>

			{bufHook.pendingDiscard && (
				<AgentDocModal
					title="Discard unsaved edits?"
					accent="amber"
					onClose={() => bufHook.setPendingDiscard(null)}
					actions={
						<>
							<Button onClick={() => bufHook.setPendingDiscard(null)}>Cancel</Button>
							<Button
								variant="primary"
								onClick={() => {
									const fn = bufHook.pendingDiscard;
									bufHook.setPendingDiscard(null);
									fn?.();
								}}
							>
								Discard & reload
							</Button>
						</>
					}
				>
					<p>
						<span className="text-mono">{bufHook.selected}</span> has unsaved changes in
						the editor buffer. Reloading from disk will overwrite the buffer
						with the on-disk version.
					</p>
				</AgentDocModal>
			)}

			{bufHook.conflict && (
				<AgentDocModal
					title={`${bufHook.conflict.rel} changed on disk`}
					accent="red"
					onClose={() => bufHook.setConflict(null)}
					actions={
						<>
							<Button onClick={() => bufHook.setConflict(null)}>Cancel</Button>
							<Button onClick={bufHook.reloadAfterConflict}>Reload from disk</Button>
							<Button variant="primary" onClick={bufHook.overwriteAfterConflict}>
								Overwrite with my edits
							</Button>
						</>
					}
				>
					<p>
						This file was modified outside Skill Tree since you loaded it.
						Saving now would overwrite those changes.
					</p>
					<div className="agent-docs-conflict-grid">
						<div>
							<div className="ad-c-label">YOUR BUFFER</div>
							<div className="ad-c-meta">
								loaded{" "}
								{bufHook.selectedBuffer
									? new Date(bufHook.selectedBuffer.loadedAtTs).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
											hour12: false,
										})
									: "—"}{" "}
								· hash {bufHook.selectedBuffer?.loadedHash ?? "—"}
							</div>
						</div>
						<div>
							<div className="ad-c-label">DISK NOW</div>
							<div className="ad-c-meta">
								modified just now · hash {bufHook.conflict.currentHash.slice(0, 8)}
							</div>
						</div>
					</div>
				</AgentDocModal>
			)}

			{/* Raised by the navigation guard for any in-app exit while a buffer
			    is unwritten — including the project area strip's own switch,
			    which routes through `attemptNavigation` in ProjectWorkspace. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Leave without saving?"
				body={`${leaveDirtyCount} file${leaveDirtyCount === 1 ? "" : "s"} ${
					leaveDirtyCount === 1 ? "has" : "have"
				} unsaved changes. Leaving discards them.`}
				confirmLabel="Leave"
				cancelLabel="Stay"
				tone="danger"
			/>
		</>
	);
}
