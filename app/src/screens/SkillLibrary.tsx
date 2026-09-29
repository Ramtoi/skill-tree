import { skillReferenceStats } from "@/lib/skillRowStats";
import { estimateSkillBodies } from "@/lib/skillBodyTokens";
import { useRunningTargets } from "@/store/processes";
import { BundlePlaybook } from "./library/BundlePlaybook";
import { bundleSections } from "@/lib/bundlePlaybook";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import { hubCmd, runHubCmd } from "@/lib/hubCmd";
import { errorDetail } from "@/lib/cliOutput";
import { SkillRow } from "@/components/SkillRow";
import { SkillCard } from "@/components/SkillCard";
import { SourceChip } from "@/components/SourceChip";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { NewBundleSheet } from "@/components/NewBundleSheet";
import { AddProjectSheet } from "@/components/AddProjectSheet";
import { ImportSkillDialog } from "@/components/ImportSkillDialog";
import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { Chips, Chip } from "@/components/Chips";
import { Select, type SelectOption } from "@/components/Select";
import { Popover } from "@/components/Popover";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubheaderGroup } from "@/components/SubheaderGroup";
import { FloatingSearch, type FloatingSearchKindOption } from "@/components/FloatingSearch";
import { ResourceRow } from "@/components/ResourceRow";
import { SectionHeader } from "@/components/SectionHeader";
import { EmptyState } from "@/components/EmptyState";
import { InfoBanner } from "@/components/InfoBanner";
import { EquipPicker } from "@/components/EquipPicker";
import {
	ProjectLocalSkills,
	type ProjectSkillCandidate,
} from "@/components/ProjectLocalSkills";
import { DetectedMcpServers } from "@/components/mcp/DetectedMcpServers";
import { McpCompareSheet } from "@/components/mcp/McpCompareSheet";
import type { McpCandidate } from "@/lib/mcpContract";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { buildSkillProjectTargets } from "@/hooks/useEquipTargets";
import { useSkillProjectEquip } from "@/hooks/useEquip";
import { useListNav } from "@/hooks/useListNav";
import { useLocalCandidates } from "@/hooks/useLocalCandidates";
import { useMcpCandidates } from "@/hooks/useMcpCandidates";
import { useMcpDecisions } from "@/hooks/useMcpDecisions";
import { useSnippetNames } from "@/hooks/useSnippets";
import { useLibrarySearch } from "@/hooks/useLibrarySearch";
import { useSearchCorpus } from "@/hooks/useSearchCorpus";
import { useFitsInline } from "@/hooks/useFitsInline";
import {
	useLibraryListState,
	type KindFilter,
	type InvocationFilter,
} from "@/hooks/useLibraryListState";
import { useLibraryReturn } from "@/hooks/useLibraryReturn";
import { useSkillRefsGraph } from "@/hooks/useSkillClassification";
import { nextSimpleContributionPaths, normalizeClassificationValues, resolveClassificationContributions, type SimplePathCursor } from "@/lib/skillClassification";
import { ContributionPathInspector } from "@/components/skillEditor/ClassificationContributions";
import { classificationValues, groupedClassificationEntries, passesClassification, type ClassificationGroup, type ClassificationScope, type LibraryClassificationSummary } from "@/lib/libraryClassification";
import type { ReturnFocus } from "@/lib/libraryReturn";
import {
	highlightParts,
	type SearchHit,
	type SearchItem,
	type SearchKind,
} from "@/lib/unifiedSearch";
import { useToast } from "@/components/Toast";
import {
	deriveSources,
	getSourceView,
	inferSkillSourceId,
	isExternalSource,
	sourceAccent,
} from "@/lib/skillSource";
import {
	effectiveLibraryMode,
	isConflicted,
	INVOCATION_LABEL,
} from "@/lib/invocation";
import {
	invalidPreview,
	normalizePreview,
	parseCliJson,
	type SkillPackPreview,
} from "@/lib/skillPack";
import { bundleBackTarget } from "@/lib/backTarget";
import {
	BundleHeader,
	BundleNotFoundHeader,
	BundleRowAction,
	useBundleLens,
} from "@/screens/library/BundleLens";
import type { Registry, Skill, SkillScope, SourceStatus, SourceView } from "@/types";

type View = "list" | "grid";
type GroupingMode = ClassificationGroup;

type GroupKey = "global" | "portable" | "project";

const GROUP_ORDER: GroupKey[] = ["global", "portable", "project"];

const GROUP_LABEL: Record<GroupKey, string> = {
	global: "GLOBAL",
	portable: "PORTABLE",
	project: "PROJECT",
};

const GROUPING_LS_KEY = "st-library-grouping";

/** Every `InvocationFilter` value's chip label, incl. the two the trigger
 *  facet chip row doesn't render as a standalone constant (`all`,
 *  `conflicted`) — shared by the facet chips and the narrow row's removable
 *  summary chip so they never say something different. */
const TRIGGER_FILTER_LABEL: Record<InvocationFilter, string> = {
	all: "All",
	auto: INVOCATION_LABEL.auto,
	"user-only": INVOCATION_LABEL["user-only"],
	"model-only": INVOCATION_LABEL["model-only"],
	conflicted: "Conflicted",
};

/** An allow-list, not a transform: `status.replace("-", " ")` only replaces
 *  the FIRST hyphen (garbling nothing here today, but a future multi-hyphen
 *  status would silently half-fix), and a status this frontend doesn't know
 *  about yet (`unknown`, or a value a newer backend adds) would print the
 *  raw enum value verbatim ("· unknown") instead of just staying silent.
 *  Every status not named here contributes no hint suffix at all — the
 *  skill count alone is enough to say "this source is unremarkable". */
const SOURCE_STATUS_HINT: Partial<Record<SourceStatus, string>> = {
	"update-available": "update available",
	error: "error",
	syncing: "syncing",
};

/** The SOURCE `Select`'s per-option status dot — the same three-tone read
 *  the old chip row's `dotColor` gave (amber = update available, red =
 *  error, else the source's own identity accent). */
const SOURCE_STATUS_DOT: Partial<Record<SourceStatus, string>> = {
	"update-available": "var(--amber)",
	error: "var(--red)",
};

/** The floating bar's five kind chips — counts are filled in per-render from
 * `countByKind`, which is query-scoped (G6). */
const KIND_OPTIONS: Omit<FloatingSearchKindOption, "count">[] = [
	{ value: "all", label: "ALL", icon: "library" },
	{ value: "skill", label: "SKILLS", icon: "skill" },
	{ value: "mcp", label: "MCP", icon: "mcp" },
	{ value: "bundle", label: "BUNDLES", icon: "bundle" },
	{ value: "snippet", label: "SNIPPETS", icon: "snippet" },
];

/** G1/G2: the ONE result cursor's flat, DOM-ordered pool — every rendered
 *  result row (a BUNDLES/SNIPPETS body hit OR a skill/mcp row, list or grid)
 *  maps to exactly one of these. `key` is `${kind}:${id}` (never a bare
 *  name — a bundle and a skill can share one), used for both the rovingnav
 *  index map and the wrapper's stable DOM id. */
interface FlatItem {
	key: string;
	kind: SearchKind;
	id: string;
	name: string;
	route: string;
}

function hitFlatItem(h: SearchHit): FlatItem {
	return {
		key: `${h.item.kind}:${h.item.id}`,
		kind: h.item.kind,
		id: h.item.id,
		name: h.item.label,
		route: h.item.route ?? "",
	};
}

function skillFlatItem(name: string, skill: Skill): FlatItem {
	const kind: SearchKind = skill.type === "mcp-server" ? "mcp" : "skill";
	return {
		key: `${kind}:${name}`,
		kind,
		id: name,
		name,
		route: `/skill/${encodeURIComponent(name)}`,
	};
}

function scopeToGroup(scope: SkillScope | undefined): GroupKey {
	if (scope === "portable") return "portable";
	if (scope === "project-specific") return "project";
	return "global";
}

function loadGroupingPref(): GroupingMode {
	if (typeof window === "undefined") return "scope";
	const stored = window.localStorage.getItem(GROUPING_LS_KEY);
	return stored === "source" || stored === "class" || stored === "mode" ? (stored as GroupingMode) : "scope";
}

function persistGroupingPref(mode: GroupingMode) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(GROUPING_LS_KEY, mode);
}

const VIEW_LS_KEY = "st-library-view";

function loadViewPref(): View {
	if (typeof window === "undefined") return "list";
	const stored = window.localStorage.getItem(VIEW_LS_KEY);
	return stored === "grid" ? "grid" : "list";
}

function persistViewPref(mode: View) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(VIEW_LS_KEY, mode);
}

export function SkillLibrary() {
	const navigate = useNavigate();
	const { name: bundleName } = useParams<{ name?: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: registry, isLoading, error } = useRegistry();

	const [grouping, setGrouping] = useState<GroupingMode>(() => loadGroupingPref());
	const [view, setView] = useState<View>(() => loadViewPref());
	const [showNewSkill, setShowNewSkill] = useState(false);
	const [showNewBundle, setShowNewBundle] = useState(false);
	const [showAddProject, setShowAddProject] = useState(false);

	useEffect(() => {
		if (searchParams.get("new") === "1") {
			setShowNewSkill(true);
		}
	}, [searchParams]);

	useEffect(() => {
		if (searchParams.get("addBundle") === "1") {
			setShowNewBundle(true);
		}
	}, [searchParams]);

	useEffect(() => {
		if (searchParams.get("addProject") === "1") {
			setShowAddProject(true);
		}
	}, [searchParams]);

	useEffect(() => {
		persistGroupingPref(grouping);
	}, [grouping]);

	useEffect(() => {
		persistViewPref(view);
	}, [view]);

	function openNewSkill() {
		setShowNewSkill(true);
	}

	// Finding 4: the FUNCTIONAL `setSearchParams` form — reads the params as
	// they exist when this actually runs, never a `searchParams` value closed
	// over by a stale render (the same staleness `useLibraryListState`'s
	// mirror write guards against). A guard-then-write built on the render-time
	// `searchParams` can otherwise strip against a base that's already missing
	// a `q`/`kind`/`source`/`trigger` write the list state made moments
	// earlier, silently reintroducing it.
	function stripOneShotParam(key: string) {
		setSearchParams(
			(prev) => {
				if (prev.get(key) !== "1") return prev;
				const next = new URLSearchParams(prev);
				next.delete(key);
				return next;
			},
			{ replace: true },
		);
	}

	function closeNewSkill() {
		setShowNewSkill(false);
		// Both one-shot flags strip in the SAME `setSearchParams` call: two
		// separate calls in the same tick each compute their `next` off the
		// same pre-update `prev`, so the second silently clobbers the first's
		// removal (reproduced: `new=1` survived when `mcp=paste` was stripped
		// right after it).
		setSearchParams(
			(prev) => {
				let changed = false;
				const next = new URLSearchParams(prev);
				if (next.get("new") === "1") {
					next.delete("new");
					changed = true;
				}
				// m15: the `c m` chord / palette verb's `?mcp=paste` one-shot flag
				// (S6: strip it whenever present, not only when it is literally
				// "paste" — any other value is inert but must not stick around).
				if (next.has("mcp")) {
					next.delete("mcp");
					changed = true;
				}
				return changed ? next : prev;
			},
			{ replace: true },
		);
	}

	function closeNewBundle() {
		setShowNewBundle(false);
		stripOneShotParam("addBundle");
	}

	function closeAddProject() {
		setShowAddProject(false);
		stripOneShotParam("addProject");
	}

	// C4: both pending branches keep the chrome. The Library is the app's
	// landing route, so a headerless frame here is the first thing a cold start
	// shows — and then everything drops 57px when the registry lands.
	if (isLoading) {
		return (
			<>
				<ScreenHeader icon="library" title="Library" crumbs={["skill-tree", "library"]} />
				<div className="main-body">
					<EmptyState icon="search" title="Loading library" description="Reading your registry…" />
				</div>
			</>
		);
	}

	if (error || !registry) {
		return (
			<>
				<ScreenHeader icon="library" title="Library" crumbs={["skill-tree", "library"]} />
				<div className="main-body">
					<EmptyState
						icon="search"
						title="Library unavailable"
						description={String(error ?? "Couldn't load the registry")}
					/>
				</div>
			</>
		);
	}

	// A bundle route the registry doesn't (or no longer) know: same chrome +
	// way back as any other missing-entity screen, and none of the search/
	// grouping state below is meaningful for it.
	if (bundleName && !registry.bundles[bundleName]) {
		return <BundleNotFoundHeader bundleName={bundleName} navigate={navigate} />;
	}

	return (
		<LibraryView
			registry={registry}
			bundleName={bundleName}
			navigate={navigate}
			grouping={grouping}
			setGrouping={setGrouping}
			view={view}
			setView={setView}
			openNewSkill={openNewSkill}
			showNewSkill={showNewSkill}
			closeNewSkill={closeNewSkill}
			newSkillMcpMode={searchParams.get("mcp") === "paste" ? "paste" : undefined}
			showNewBundle={showNewBundle}
			closeNewBundle={closeNewBundle}
			openAddProject={() => setShowAddProject(true)}
			showAddProject={showAddProject}
			closeAddProject={closeAddProject}
		/>
	);
}

interface LibraryViewProps {
	registry: Registry;
	bundleName?: string;
	navigate: ReturnType<typeof useNavigate>;
	grouping: GroupingMode;
	setGrouping: (g: GroupingMode) => void;
	view: View;
	setView: (v: View) => void;
	openNewSkill: () => void;
	showNewSkill: boolean;
	closeNewSkill: () => void;
	newSkillMcpMode?: "paste";
	showNewBundle: boolean;
	closeNewBundle: () => void;
	openAddProject: () => void;
	showAddProject: boolean;
	closeAddProject: () => void;
}

function LibraryView({
	registry,
	bundleName,
	navigate,
	grouping,
	setGrouping,
	view,
	setView,
	openNewSkill,
	showNewSkill,
	closeNewSkill,
	newSkillMcpMode,
	showNewBundle,
	closeNewBundle,
	openAddProject,
	showAddProject,
	closeAddProject,
}: LibraryViewProps) {
	// R1: query, kind and both facets live ONLY in the URL — no parallel
	// `useState`. `sourceFilterRaw` is the raw (unvalidated) URL value; H7
	// normalizes it against the real source list below, once `sources` exists.
	const {
		q,
		kind: kindFilter,
		source: sourceFilterRaw,
		trigger: invocationFilter,
		classFilter,
		mode: modeFilter,
		classificationScope,
		search: listSearch,
		patch,
	} = useLibraryListState();
	// `hub sync` has exactly ONE implementation (`useRunSync`), so a sync fired
	// from here reports itself through the same process card and the same
	// StatusBar chip as one fired from the palette or the status bar.
	const runSync = useRunSync();
	const syncing = useSyncing();
	const toast = useToast();
	// Every piece of bundle-mode state and every bundle write lives behind this
	// one hook (screens/library/BundleLens.tsx) — this file only composes its
	// output. `bundleLens` is `undefined` off a defined `bundleName` for at
	// most one render (the SkillLibrary-level guard above already routes a
	// genuinely missing bundle to `BundleNotFoundHeader` and never mounts this
	// view) — every read below goes through the optional, never an assertion.
	const bundleLens = useBundleLens(bundleName, registry);
	const graphQuery = useSkillRefsGraph();
	const graph = graphQuery.data;
	const rowReferences = useMemo(() => skillReferenceStats(graph), [graph]);
	const referencesLoading = classificationScope === "references" && !graph && graphQuery.isPending && classFilter !== null;
	const bundleMode = !!bundleLens;
	const [filterOpen, setFilterOpen] = useState(false);
	// G8: this PR's ARIA is a live region, not full combobox semantics (no
	// `role="combobox"`/`aria-activedescendant` — the result wrappers have no
	// valid `option` role and nest `role="button"`). Announces "<N> results ·
	// <name>" when the arrow-cursor moves via the input, "<N> results" when
	// the query or kind filter changes.
	const [liveMessage, setLiveMessage] = useState("");
	// The row measures the inline SOURCE/TRIGGER facets' natural width
	// (`facetsRef`) against how much of the ROW (`subheaderRowRef`, the
	// `.main-subheader` element) is left once the right cluster
	// (`subheaderRightRef`, `.main-subheader-right`) takes its share — both
	// forwarded through `ScreenHeader`. Measuring the row rather than
	// `.main-subheader-left` itself matters: that child's own box reshapes at
	// the `@container appmain (max-width: 780px)` wrap breakpoint, which would
	// otherwise read as "more room" exactly when the two clusters have in fact
	// stopped sharing one line (non-monotonic collapse/inline flips as the
	// window narrows). When they don't fit the row collapses to the Filter
	// chip, whose own DOM node anchors the popover (`Chip` doesn't forward
	// refs, so the wrapping `<span>` does).
	const {
		rowRef: subheaderRowRef,
		rightRef: subheaderRightRef,
		contentRef: facetsRef,
		fits,
	} = useFitsInline();
	// If the row gains room while the Filter popover is open (a window
	// resize, a source disappearing), the row flips back to inline and the
	// Filter chip — the popover's own anchor — unmounts out from under it,
	// orphaning the portalled panel with no way to close. Closing here is a
	// no-op the rest of the time (`filterOpen` is already false whenever
	// `fits` is true in the ordinary open→pick→close flow).
	useEffect(() => {
		if (fits) setFilterOpen(false);
	}, [fits]);
	const filterAnchorRef = useRef<HTMLButtonElement | null>(null);
	const [equipFor, setEquipFor] = useState<{ name: string; rect: DOMRect } | null>(
		null,
	);
	// `.skillpack` import: pick a file → dry-run preview → confirm dialog.
	const [importPack, setImportPack] = useState<{
		path: string;
		preview: SkillPackPreview | null;
	} | null>(null);
	const [importPicking, setImportPicking] = useState(false);
	const { data: localCandidates } = useLocalCandidates();
	const { data: mcpReconcile } = useMcpCandidates();
	const [mcpCompareCand, setMcpCompareCand] = useState<McpCandidate | null>(null);
	// `noUsage: true` fast path, cache shared with the Snippets screen. Always
	// enabled: a registry with zero SKILLS but real bundles or snippets must
	// still search them (review m12) — the dock's own visibility is gated on
	// `searchItems.length`, not on the skill count.
	const { data: snippetNames = [], isFetched: snippetsFetched } = useSnippetNames();
	// H4: the restore effect's "give up and land on row 0" fallback needs to
	// know when every query the cursor's key could come from has settled —
	// the corpus feeds cross-entity hits (via `useLibrarySearch` below, same
	// query key, deduped by react-query) and snippet names feed the SNIPPETS
	// group.
	const { data: corpus, isFetched: corpusFetched } = useSearchCorpus();
	const skillBodyTokens = useMemo(() => estimateSkillBodies(corpus), [corpus]);

	async function pickSkillPack() {
		if (importPicking) return;
		setImportPicking(true);
		try {
			const path = await invoke<string | null>("pick_file", {
				extension: "skillpack",
			});
			// Cancelled sheet — a silent no-op, not an error.
			if (!path) return;
			const result = await hubCmd(["skill", "import", path, "--dry-run", "--json"]);
			// A refused pack still has to name WHICH pack and why, so a non-zero
			// exit becomes an invalid preview in the dialog rather than a bare toast.
			let preview: SkillPackPreview;
			try {
				preview = normalizePreview(parseCliJson<unknown>(result.output));
			} catch (e) {
				preview = invalidPreview([
					(result.success ? String(e) : result.output) || String(e),
				]);
			}
			setImportPack({ path, preview });
		} catch (err) {
			toast.error("Could not read that skill pack", errorDetail(err).headline);
		} finally {
			setImportPicking(false);
		}
	}

	async function adoptCandidate(cand: ProjectSkillCandidate) {
		try {
			await runHubCmd([
				"project",
				"import-skill",
				cand.name,
				"--project",
				cand.project,
			]);
		} catch (err) {
			// Was a raw stdout+stderr blob, ANSI escapes and all, dumped into the
			// toast body. Same single-line headline the sync card uses.
			toast.error("Couldn't import skill", errorDetail(err).headline);
			throw err;
		}
		toast.success(
			"Imported to library",
			`${cand.name} — now equipped on ${cand.project}`,
		);
		await invalidateRegistry(queryClient);
		await queryClient.invalidateQueries({ queryKey: qk.localCandidates() });
	}

	// Detected MCP servers (design D5/M9) — the wire-up logic lives in
	// `useMcpDecisions` (its own file, `componentSizeGuard`'s LEGACY_FILES
	// note against growing this one further).
	const { adoptMcp, keepMcp, compareAdoptMcp } = useMcpDecisions();

	const allSkills = useMemo(() => {
		const entries = Object.entries(registry.skills) as Array<[string, Skill]>;
		if (!bundleLens) return entries;
		const memberSet = new Set(bundleLens.memberNames);
		return entries.filter(([name]) => memberSet.has(name));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `bundleLens.memberNames` is the one stable (memoized) field this reads; the rest of `bundleLens` is a fresh object every render.
	}, [registry.skills, bundleLens?.memberNames]);
	// Bundle mode only: names whose "create then follow-up" bundle addition
	// (newSkillCompletion.ts) is still in flight get `pending` on their row
	// (SkillRow -> ariaBusy + a dim mono "adding…" segment), design.md
	// Decisions #4. `bundle-add-source:<bundle>` is AddSourceToBundleModal's
	// own write, under its own verb so it can never collide with a
	// `bundle-add:<bundle>:<skill>` target even for a skill literally named
	// "source": the `memberSet.has(name)` check below still guards against
	// any other non-member target. `useRunningTargets` (not `useProcesses`)
	// so an unrelated process update elsewhere (e.g. per-chunk sync progress)
	// never re-renders every row in this list. The hook is always called;
	// out of bundle mode the prefix is null, and `useRunningTargets` returns
	// its shared stable empty array for a null prefix without matching
	// anything real.
	const bundleAddPrefix = bundleLens ? `bundle-add:${bundleLens.bundleName}:` : null;
	const runningBundleAdds = useRunningTargets(bundleAddPrefix);
	const pendingMembers = useMemo(() => {
		if (!bundleLens) return new Set<string>();
		const memberSet = new Set(bundleLens.memberNames);
		const names = new Set<string>();
		for (const target of runningBundleAdds) {
			const name = target.slice((bundleAddPrefix ?? "").length);
			if (memberSet.has(name)) names.add(name);
		}
		return names;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- same shape as `allSkills` above: `bundleLens.memberNames` is the stable field this reads, the rest of `bundleLens` is a fresh object every render.
	}, [runningBundleAdds, bundleAddPrefix, bundleLens?.memberNames]);
	const classificationSummaries = useMemo(() => {
		const map = new Map<string, LibraryClassificationSummary>();
		if (!graph) return map;
		for (const [name] of allSkills) map.set(name, resolveClassificationContributions(name, registry, graph));
		return map;
	}, [allSkills, registry, graph]);
	const classOptions = useMemo(() => {
		const values = new Set<string>();
		for (const [name, skill] of allSkills) for (const value of classificationValues(skill, classificationSummaries.get(name), classificationScope).classes) values.add(value.value);
		return normalizeClassificationValues([...values]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	}, [allSkills, classificationSummaries, classificationScope]);

	const bundles = useMemo(
		() => Object.entries(registry.bundles),
		[registry.bundles],
	);

	const sources = useMemo<SourceView[]>(() => deriveSources(registry), [registry]);
	// H7: a `source` id the URL still names but the registry no longer knows
	// (the source was removed) reads as NO facet — the URL itself is left
	// alone (`useLibraryListState` never strips it on our behalf).
	const sourceFilter = useMemo(
		() => (sourceFilterRaw && sources.some((s) => s.id === sourceFilterRaw) ? sourceFilterRaw : null),
		[sourceFilterRaw, sources],
	);

	// skill name -> source view
	const sourceBySkill = useMemo(() => {
		const map = new Map<string, SourceView>();
		for (const [name, skill] of allSkills) {
			map.set(name, getSourceView(inferSkillSourceId(skill), sources));
		}
		return map;
	}, [allSkills, sources]);

	const bundlesBySkill = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const [bn, b] of bundles) {
			for (const sn of b.skills ?? []) {
				const arr = map.get(sn) ?? [];
				arr.push(bn);
				map.set(sn, arr);
			}
		}
		return map;
	}, [bundles]);

	const equippedCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const [name] of allSkills) {
			counts.set(name, 0);
		}
		for (const project of Object.values(registry.projects)) {
			const active = resolveActiveSkills(project, registry);
			for (const sn of active) {
				counts.set(sn, (counts.get(sn) ?? 0) + 1);
			}
		}
		return counts;
	}, [allSkills, registry]);

	// Shared by `searchItems` and `filtered` (G6) so a chip count, the header
	// tag, and the rows on screen never disagree about what a facet excludes.
	const passesFacets = useCallback(
		(name: string, s: Skill) => {
			if (!graph && graphQuery.isPending && classificationScope === "references" && classFilter) return false;
			if (!passesClassification(s, classificationSummaries.get(name), classFilter, modeFilter, classificationScope)) return false;
			if (invocationFilter !== "all") {
				// Conflicted is its own facet — it must not also fold into Auto.
				const matches = isConflicted(s.invocation)
					? invocationFilter === "conflicted"
					: effectiveLibraryMode(s.invocation) === invocationFilter;
				if (!matches) return false;
			}
			if (sourceFilter) {
				const sid = sourceBySkill.get(name)?.id ?? "local";
				if (sid !== sourceFilter) return false;
			}
			return true;
		},
		[invocationFilter, sourceFilter, sourceBySkill, classFilter, modeFilter, classificationScope, classificationSummaries, graph, graphQuery.isPending],
	);

	// Cross-entity pool. No `keywords` on skill/mcp (G12) — bundle membership
	// has its own control; folding it in would match "global" on every global
	// skill. Snippets keep `tags`, the Snippets screen's own vocabulary.
	// Bundle mode's pool is member skills only (G6) — bundle and snippet
	// entries never enter the cross-entity search at all in that mode.
	const searchItems = useMemo<SearchItem[]>(
		() => [
			...allSkills
				.filter(([name, s]) => passesFacets(name, s))
				.map(([name, s]) => ({
					kind: (s.type === "mcp-server" ? "mcp" : "skill") as SearchKind,
					id: name,
					label: name,
					description: s.description,
					route: `/skill/${encodeURIComponent(name)}`,
				})),
			...(bundleMode
				? []
				: bundles.map(([name, b]) => ({
						kind: "bundle" as const,
						id: name,
						label: name,
						description: b.description,
						route: `/bundle/${encodeURIComponent(name)}`,
					}))),
			...(bundleMode
				? []
				: snippetNames.map((s) => ({
						kind: "snippet" as const,
						id: s.name,
						label: s.name,
						description: s.description,
						keywords: s.tags,
						route: `/snippet/${encodeURIComponent(s.name)}`,
					}))),
		],
		[allSkills, passesFacets, bundles, snippetNames, bundleMode],
	);

	// The Library's one search call (band A ∪ band B — a skill/snippet body
	// match), sliced into what the screen needs. Replaces three separate
	// `matchItems` calls per keystroke (`counts`, `listMatchIds`, `crossHits`)
	// with one `searchAll` call plus cheap derived slices (D13).
	const { counts, listHits, bundleHits, snippetHits } = useLibrarySearch({
		items: searchItems,
		query: q,
		kindFilter,
	});
	// The kind = bundle/snippet body IS one of the two cross-entity lists —
	// exactly one is ever non-empty in that mode (the hook's `kindFilter`
	// param already narrows to the active kind).
	const crossHits = kindFilter === "bundle" ? bundleHits : snippetHits;

	const filtered = useMemo(() => {
		const rows = allSkills.filter(([name, s]) => {
			if (kindFilter === "bundle" || kindFilter === "snippet") return false;
			if (kindFilter === "mcp" && s.type !== "mcp-server") return false;
			if (kindFilter === "skill" && s.type === "mcp-server") return false;
			if (!passesFacets(name, s)) return false;
			if (listHits && !listHits.has(name)) return false;
			return true;
		});
		// D10: with a query, rank the visible rows by hit score within their
		// existing group — the best match reads first without dismantling the
		// scope/source grouping below. No query → `listHits` is null → the
		// sort is skipped, so the landing order is byte-identical to before.
		if (listHits) {
			const hits = listHits;
			rows.sort((a, b) => hits.get(a[0])!.score - hits.get(b[0])!.score);
		}
		return rows;
	}, [allSkills, kindFilter, passesFacets, listHits]);

	/** A hit label with its matched range(s) bolded — cheap since `ResourceRow`
	 *  (and `SkillRow`/`SkillCard`'s `nameNode`) take a node for the name. */
	function hitName(h: SearchHit) {
		const parts = highlightParts(h.item.label, h.ranges);
		if (parts.length === 1 && !parts[0].hit) return h.item.label;
		return parts.map((part, i) =>
			part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
		);
	}

	/** The description with every matched range marked. */
	function hitDesc(h: SearchHit) {
		if (!h.item.description) return undefined;
		if (h.descRanges.length === 0) return h.item.description;
		return highlightParts(h.item.description, h.descRanges).map((part, i) =>
			part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
		);
	}

	/** The "why this row is here" line for a BODY-only match — undefined for
	 *  every other hit (band A never carries an `excerpt`). */
	function hitExcerpt(h: SearchHit | undefined) {
		if (!h?.excerpt) return undefined;
		return (
			<>
				<span className="resource-excerpt-label">in content</span>
				{highlightParts(h.excerpt.text, h.excerpt.ranges).map((part, i) =>
					part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
				)}
			</>
		);
	}

	const groupedByScope = useMemo(() => {
		const g: Record<GroupKey, Array<[string, Skill]>> = {
			global: [],
			portable: [],
			project: [],
		};
		for (const entry of filtered) {
			g[scopeToGroup(entry[1].scope)].push(entry);
		}
		return g;
	}, [filtered]);

	const groupedBySource = useMemo(() => {
		const map = new Map<string, Array<[string, Skill]>>();
		for (const entry of filtered) {
			const sid = sourceBySkill.get(entry[0])?.id ?? "local";
			const arr = map.get(sid) ?? [];
			arr.push(entry);
			map.set(sid, arr);
		}
		const ordered: Array<{ source: SourceView; items: Array<[string, Skill]> }> = [];
		for (const s of sources) {
			const items = map.get(s.id);
			if (items && items.length > 0) ordered.push({ source: s, items });
		}
		return ordered;
	}, [filtered, sourceBySkill, sources]);
	const groupedByClassification = useMemo(() => groupedClassificationEntries(filtered, grouping), [filtered, grouping]);

	const total = Object.keys(registry.skills).length;
	/** The registry itself is empty — NOT "the current filter matched nothing".
	 *  Only the first suppresses the toolbar; a filtered-to-zero list still
	 *  needs its filters on screen so the user can undo them. */
	const registryEmpty = total === 0;
	const activeFilterCount =
		(sourceFilter ? 1 : 0) + (invocationFilter !== "all" ? 1 : 0) + (classFilter ? 1 : 0) + (modeFilter !== "all" ? 1 : 0);
	const hasConflicted = useMemo(
		() => allSkills.some(([, s]) => s.invocation === "conflicted"),
		[allSkills],
	);
	const candidates = localCandidates ?? [];

	// Roving keyboard nav (ux-command-layer D6, extended by G1-G14 for the
	// combobox-style arrow cursor). ONE flat, DOM-ordered pool across every
	// rendered result row — cross-entity body hits (BUNDLES/SNIPPETS, or the
	// whole body when kind = bundle/snippet) THEN the skill/mcp rows (list
	// groups, or grid cards) — so `j`/`k`/ArrowDown/ArrowUp cross from a body
	// hit into the skill rows with no seam, and `e` opens the equip picker
	// anchored to the focused row.
	const crossFlatItems = useMemo<FlatItem[]>(() => {
		if (kindFilter === "bundle" || kindFilter === "snippet") {
			return crossHits.map(hitFlatItem);
		}
		return [...bundleHits.map(hitFlatItem), ...snippetHits.map(hitFlatItem)];
	}, [kindFilter, crossHits, bundleHits, snippetHits]);
	const skillFlatItems = useMemo<FlatItem[]>(() => {
		if (kindFilter === "bundle" || kindFilter === "snippet") return [];
		if (bundleLens) {
			const visible = new Map(filtered);
			return bundleSections(bundleLens.bundle).flatMap((section) => section.skills.filter((name) => visible.has(name)).map((name) => skillFlatItem(name, visible.get(name)!)));
		}
		if (view === "grid") return filtered.map(([name, skill]) => skillFlatItem(name, skill));
		if (grouping === "class" || grouping === "mode") return groupedByClassification.flatMap((g) => g.items.map(([name]) => ({ ...skillFlatItem(name, registry.skills[name]), key: `skill:${name}:${g.key}` })));
		return grouping === "scope"
			? GROUP_ORDER.flatMap((scope) =>
					groupedByScope[scope].map(([name, skill]) => skillFlatItem(name, skill)),
				)
			: groupedBySource.flatMap((g) =>
					g.items.map(([name, skill]) => skillFlatItem(name, skill)),
				);
	}, [kindFilter, view, filtered, grouping, groupedByScope, groupedBySource, groupedByClassification, registry.skills, bundleLens]);
	const flatItems = useMemo<FlatItem[]>(
		// Grill MAJOR 2: with an empty registry the `registryEmpty` branch below
		// renders zero result rows (only the dock — see the empty-state JSX) —
		// but bundles/snippets can still exist, so `crossFlatItems` would be
		// non-empty and hand the roving cursor rows that are not on screen.
		() => (registryEmpty ? [] : [...crossFlatItems, ...skillFlatItems]),
		[registryEmpty, crossFlatItems, skillFlatItems],
	);
	const rowIndex = useMemo(
		() => new Map(flatItems.map((item, i) => [item.key, i])),
		[flatItems],
	);
	const rowEls = useRef<(HTMLElement | null)[]>([]);
	// A row's disclosure detail is keyboard-reachable via the roving list's
	// ArrowRight/ArrowLeft (REVIEW-A #2) — a wrapper owns the roving tab stop
	// here, so the chevron itself drops out of the tab order (SkillRow's
	// `tabIndex={-1}` below).
	const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
	const [pathInspect, setPathInspect] = useState<{ root: string; field: "classes" | "outputs"; value: string; occurrenceKey: string; contributors: string[]; contributorIndex: number; paths: string[][]; cursor: SimplePathCursor | null } | null>(null);
	const inspectorRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		setPathInspect(null);
	}, [graph, registry]);
	useEffect(() => {
		if (!pathInspect) return;
		requestAnimationFrame(() => {
			inspectorRef.current?.scrollIntoView({ block: "nearest" });
			inspectorRef.current?.focus({ preventScroll: true }); // eslint-disable-line no-restricted-syntax -- the inspector mounted in the commit that set pathInspect; the rAF only follows its scroll-into-view.
		});
	}, [pathInspect]);
	function inspectContribution(root: string, field: "classes" | "outputs", value: string, occurrenceKey: string) {
		const summary = classificationSummaries.get(root);
		const item = summary?.[field].find((entry) => entry.value === value);
		const contributor = item?.contributors[0];
		if (!contributor || !graph) return;
		const page = nextSimpleContributionPaths(root, contributor, graph, null, 8, new Set(Object.keys(registry.skills)));
		setPathInspect({ root, field, value, occurrenceKey, contributors: item?.contributors ?? [], contributorIndex: 0, paths: page.paths, cursor: page.nextCursor });
	}
	function loadMorePaths() {
		if (!pathInspect || !graph) return;
		const nextContributor = pathInspect.contributors[pathInspect.contributorIndex + 1];
		if (!pathInspect.cursor && !nextContributor) return;
		const contributorIndex = pathInspect.cursor ? pathInspect.contributorIndex : pathInspect.contributorIndex + 1;
		const contributor = pathInspect.contributors[contributorIndex];
		const page = nextSimpleContributionPaths(pathInspect.root, contributor, graph, pathInspect.cursor, 8, new Set(Object.keys(registry.skills)));
		setPathInspect({ ...pathInspect, contributorIndex, paths: [...pathInspect.paths, ...page.paths], cursor: page.nextCursor });
	}
	function toggleDetail(name: string) {
		setOpenDetails((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}
	// R2/H6: opening a result focuses "row" (Enter while a row had DOM focus)
	// — `nav.onOpen` fires ONLY from that path (a click uses its own `onClick`
	// below, wired to `openItem(..., "none")`; the bar's Enter is `onCommit`,
	// wired to `"bar"`).
	const nav = useListNav({
		count: flatItems.length,
		onOpen: (i) => {
			const item = flatItems[i];
			if (item) openItem(item, "row");
		},
		onSecondary: (i) => {
			// Cross-entity (bundle/snippet) rows have no equip picker — 'e' is a
			// no-op there, same as it always was for a row `useListNav` didn't
			// know about.
			const item = flatItems[i];
			const el = rowEls.current[i];
			if (item && el && (item.kind === "skill" || item.kind === "mcp")) {
				setEquipFor({ name: item.id, rect: el.getBoundingClientRect() });
			}
		},
		onToggleDetail: (i) => {
			const item = flatItems[i];
			if (item && (item.kind === "skill" || item.kind === "mcp")) toggleDetail(item.key);
		},
		// Bundle mode only, and never on a linked bundle (membership isn't the
		// reader's to change there — see `BundleRowAction`).
		onRemove:
			bundleLens && !bundleLens.isLinked
				? (i) => {
						const item = flatItems[i];
						if (item) bundleLens.removeSkill(item.id);
					}
				: undefined,
	});
	function navRowProps(key: string) {
		const i = rowIndex.get(key) ?? 0;
		const { ref, ...rest } = nav.itemProps(i);
		return {
			className: "lib-nav-row",
			ref: (el: HTMLDivElement | null) => {
				ref(el);
				rowEls.current[i] = el;
			},
			...rest,
			onFocus: () => nav.setActiveIndex(i),
		};
	}

	// R3/H4: restores the cursor + focus when the Library is shown again
	// after a result opened from it (a real Back, or an explicit back arrow
	// carrying `BackTarget.restore`, H1). `searchInputRef` is handed to
	// `FloatingSearch` below.
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const { openWithReturn } = useLibraryReturn({
		rowIndex,
		setActiveIndex: nav.setActiveIndex,
		rowEls,
		inputRef: searchInputRef,
		settled: corpusFetched && snippetsFetched && !referencesLoading,
		// Bundle mode hands back a referrer to THIS bundle (not the plain
		// library) — same contract opening a skill from a project uses.
		bundleBack: bundleLens ? bundleBackTarget(bundleLens.bundleName) : undefined,
	});
	// R2: the ONE path every result-open funnels through — Enter from the
	// bar, Enter on a focused row, and a mouse click on a row/card/body hit
	// all call this (with their own `focus` value, H6) so the Library always
	// stamps a return before it navigates away.
	function openItem(item: FlatItem, focus: ReturnFocus) {
		if (!item.route) return;
		openWithReturn(item.kind, item.key, focus, item.route, listSearch);
	}

	// S2/G8: ArrowUp/ArrowDown from the focused input move the cursor WITHOUT
	// moving DOM focus off the input — clamp (no wrap, matching `useListNav`),
	// scroll the target row into view (G4), and announce it (aria-live, since
	// no combobox ARIA ships this round — G8).
	function onMove(delta: 1 | -1) {
		if (flatItems.length === 0) return;
		const next = Math.max(0, Math.min(nav.activeIndex + delta, flatItems.length - 1));
		nav.setActiveIndex(next);
		const item = flatItems[next];
		if (item) {
			setLiveMessage(
				`${flatItems.length} result${flatItems.length === 1 ? "" : "s"} · ${item.name}`,
			);
		}
		rowEls.current[next]?.scrollIntoView({ block: "nearest" });
	}

	// G3: unmodified Tab from the input hands DOM focus to the cursor row
	// (the dock renders AFTER the results, so native Tab would otherwise leave
	// `.app-main` for the dock's own clear button / kind chips).
	function onFocusCursor(): boolean {
		const el = rowEls.current[nav.activeIndex];
		if (el) {
			el.focus();
			return true;
		}
		return false;
	}

	// G13: Enter opens the CURSOR row (row 0 by default — G9 resets it on
	// every query/kind change) — this REPLACES the old "Enter focuses row 0"
	// behaviour. `true` means the host navigated; `FloatingSearch` only
	// `preventDefault()`s the keystroke then. H6: Enter from the bar is
	// always `focus: "bar"` on return.
	function onCommit(): boolean {
		const item = flatItems[nav.activeIndex];
		if (!item?.route) return false;
		openItem(item, "bar");
		return true;
	}

	// G9/H3: the cursor resets to 0 in the SAME batch as the query/kind/facet
	// change — not a `useEffect` — so it never visibly lags one keystroke
	// behind. Every write goes through the ONE `patch()` call (H3) so a
	// handler that changes two keys at once (`clearFacets`) can never
	// clobber itself.
	function setQ(v: string) {
		patch({ q: v });
		nav.setActiveIndex(0);
	}
	function setKindFilter(k: KindFilter) {
		patch({ kind: k });
		nav.setActiveIndex(0);
	}
	// Grill MINOR 6: the source/invocation facets narrow `filtered` the same
	// way `q`/`kindFilter` do, so a facet change must reset the cursor the
	// same synchronous way — otherwise the cursor can land past the end of
	// the newly-narrowed `flatItems` (or on a stale row).
	function setSourceFilter(s: string | null) {
		patch({ source: s });
		nav.setActiveIndex(0);
	}
	function setInvocationFilter(f: InvocationFilter) {
		patch({ trigger: f });
		nav.setActiveIndex(0);
	}
	function setClassFilter(value: string | null) { patch({ classFilter: value }); nav.setActiveIndex(0); }
	function setModeFilter(value: "all" | "inline" | "delegator" | "mixed") { patch({ mode: value }); nav.setActiveIndex(0); }
	function setClassificationScope(value: ClassificationScope) { patch({ classificationScope: value }); nav.setActiveIndex(0); }
	// H3: "Clear filters" changes BOTH facets — one `patch()` call, not two
	// independent setter calls (each would read the same pre-update params
	// and the second write would clobber the first).
	function clearFacets() {
		patch({ source: null, trigger: "all", classFilter: null, mode: "all", classificationScope: "references" });
		nav.setActiveIndex(0);
	}

	// G8: the query/kind-filter branch of the live region — the cursor-move
	// branch is set directly by `onMove` above (it already knows the target
	// row's name; this effect would only see the post-reset row 0).
	useEffect(() => {
		// Grill MINOR 7: an idle mount (no query, no kind filter) has nothing to
		// announce — "N results" on load is noise for a screen reader user who
		// never asked for a search.
		if ((q.trim() === "" && kindFilter === "all") || referencesLoading) {
			setLiveMessage("");
			return;
		}
		setLiveMessage(`${flatItems.length} result${flatItems.length === 1 ? "" : "s"}`);
	}, [q, kindFilter, flatItems.length, referencesLoading]);

	// The GROUP scope/source + list/grid cluster — byte-identical whether the
	// row2 band beside it is the plain library's facets or the bundle-mode
	// band, so it is built exactly once and handed to whichever renders.
	const rightCluster = (
		<>
			<SubheaderGroup label="GROUP">
				<Chips>
					<Chip
						pressed={grouping === "scope"}
						onClick={() => setGrouping("scope")}
						title="Group by skill scope"
					>
						Scope
					</Chip>
					<Chip
						pressed={grouping === "source"}
						onClick={() => setGrouping("source")}
						title="Group by source"
					>
						Source
					</Chip>
					<Chip pressed={grouping === "class"} onClick={() => setGrouping("class")} title="Group by class">Class</Chip>
					<Chip pressed={grouping === "mode"} onClick={() => setGrouping("mode")} title="Group by working mode">Mode</Chip>
				</Chips>
			</SubheaderGroup>
			<Chips>
				<Chip
					pressed={view === "list"}
					icon="view.list"
					onClick={() => setView("list")}
					ariaLabel="List view"
				/>
				<Chip
					pressed={view === "grid"}
					icon="view.grid"
					onClick={() => setView("grid")}
					ariaLabel="Grid view"
				/>
			</Chips>
		</>
	);
	const renderSkill = (name: string, skill: Skill, occurrenceKey: string) => {
		const item = skillFlatItem(name, skill);
		const summary = classificationValues(skill, classificationSummaries.get(name), "references");
		return <div key={occurrenceKey} {...navRowProps(occurrenceKey)}>
			<SkillRow referenceStats={rowReferences ? rowReferences.get(name) ?? { incoming: [], outgoing: [] } : undefined} bodyTokens={skillBodyTokens[name]} name={name} nameNode={listHits ? hitName(listHits.get(name)!) : undefined} descNode={listHits ? hitDesc(listHits.get(name)!) : undefined} excerpt={listHits ? hitExcerpt(listHits.get(name)!) : undefined} skill={skill} registry={registry} classification={summary} onClassificationInspect={(field, value) => inspectContribution(name, field, value, occurrenceKey)} onClick={() => openItem({ ...item, key: occurrenceKey }, "none")} onOpenEquipPicker={(rect) => setEquipFor({ name, rect })} equippedCount={equippedCounts.get(name) ?? 0} bundleNames={(bundlesBySkill.get(name) ?? []).filter((bundle) => bundle !== bundleLens?.bundleName)} tabIndex={-1} detailOpen={openDetails.has(occurrenceKey)} onDetailToggle={() => toggleDetail(occurrenceKey)} extraActions={bundleLens && <BundleRowAction lens={bundleLens} name={name} />} pending={bundleLens ? pendingMembers.has(name) : undefined} source={isExternalSource(sourceBySkill.get(name) ?? sources[0]) ? <SourceChip compact source={sourceBySkill.get(name) ?? sources[0]} onClick={() => setSourceFilter(sourceBySkill.get(name)?.id ?? null)} /> : undefined} />
		</div>;
	};

	return (
		<>
			{bundleLens ? (
				<BundleHeader
					lens={bundleLens}
					subheaderRight={undefined}
					subheaderFilters={
						<SubheaderGroup>
							<Chips>
								<Chip
									ref={filterAnchorRef}
									icon="filter"
									pressed={filterOpen}
									onClick={() => setFilterOpen((open) => !open)}
									title="Filter by source, trigger, class, mode, or class matching"
								>
									Filter
									{activeFilterCount > 0 && <span className="count">{activeFilterCount}</span>}
								</Chip>
							</Chips>
						</SubheaderGroup>
					}
				/>
			) : (
			<ScreenHeader
				icon="library"
				title="Library"
				meta={
					// ZERO-COUNT CHROME. With an empty registry "0 of 0" is a
					// measurement of nothing — it reads as a broken filter, not as a
					// fresh install. Same reason the whole subheader is dropped below.
					// Also hidden for kind = bundle/snippet: "3 of 15" would measure
					// the skill list while the body shows bundle/snippet rows instead.
					registryEmpty || kindFilter === "bundle" || kindFilter === "snippet" || referencesLoading ? undefined : (
						<Tag size="sm" color="var(--fg-mute)" style={{ textTransform: "none" }}>
							{filtered.length} of {total}
						</Tag>
					)
				}
				crumbs={[
					"skill-tree",
					"library",
					...(sourceFilter
						? [
								<span style={{ color: "var(--anchor-2)" }} key="src">
									source:{" "}
									{sources.find((s) => s.id === sourceFilter)?.name ??
										sourceFilter}
								</span>,
							]
						: []),
				]}
				primary={
					// Exactly ONE primary-variant button survives in this slot — Import
					// is a soft sibling so the create action keeps its emphasis.
					<>
						<Button
							variant="soft"
							icon="import"
							busy={importPicking}
							title="Import a .skillpack file"
							onClick={() => void pickSkillPack()}
						>
							Import
						</Button>
						<Button variant="primary" icon="plus" onClick={openNewSkill}>
							New skill
						</Button>
					</>
				}
				overflow={[
					{ icon: "project", label: "Add project", onClick: openAddProject },
					{
						icon: "source",
						label: "Manage sources",
						onClick: () => navigate("/sources"),
					},
					{ divider: true },
					{
						icon: "refresh",
						label: "Sync registry",
						busy: syncing,
						onClick: () => void runSync(),
					},
				]}
				/* Nothing to filter and nothing to lay out two ways over an empty
				   registry — search + kind chips live in the floating bar below,
				   which is itself suppressed while the registry is empty. */
				subheader={
					registryEmpty ? undefined : {
					rowRef: subheaderRowRef,
					rightRef: subheaderRightRef,
					left: (
						<>
							{/* Measured against how much of the ROW is left once the right
							    cluster takes its share (`useFitsInline`): fits → renders in
							    place; doesn't fit → parked off-flow (`[data-collapsed]`,
							    still measurable, never visible or reachable) while the
							    Filter chip + summary chips stand in below. */}
							<div
								className="library-facets"
								ref={facetsRef}
								data-collapsed={fits ? undefined : ""}
								inert={fits ? undefined : true}
								aria-hidden={fits ? undefined : true}
							>
											<LibraryFacets
									layout="row"
									sources={sources}
									sourceFilter={sourceFilter}
									setSourceFilter={setSourceFilter}
									invocationFilter={invocationFilter}
									setInvocationFilter={setInvocationFilter}
						hasConflicted={hasConflicted}
												classFilter={classFilter} classOptions={classOptions} setClassFilter={setClassFilter} modeFilter={modeFilter} setModeFilter={setModeFilter} classificationScope={classificationScope} setClassificationScope={setClassificationScope}
											/>
							</div>
							{!fits && (
								<>
									<SubheaderGroup>
										<Chips>
											<Chip
												ref={filterAnchorRef}
												icon="filter"
												pressed={filterOpen}
												onClick={() => setFilterOpen((o) => !o)}
												title="Filter by source or trigger"
											>
												Filter
												{activeFilterCount > 0 && (
													<span className="count">{activeFilterCount}</span>
												)}
											</Chip>
										</Chips>
									</SubheaderGroup>

									{(sourceFilter || invocationFilter !== "all") && (
										<SubheaderGroup>
											<Chips>
												{sourceFilter && (
													<Chip
														pressed
														dotColor={sourceAccent(sourceFilter)}
														onClick={() => setSourceFilter(null)}
														title="Clear source filter"
													>
														source:{" "}
														{sources.find((s) => s.id === sourceFilter)?.name ??
															sourceFilter}{" "}
														<Icon name="x" size={9} />
													</Chip>
												)}
												{invocationFilter !== "all" && (
													<Chip
														pressed
														onClick={() => setInvocationFilter("all")}
														title="Clear trigger filter"
													>
														trigger: {TRIGGER_FILTER_LABEL[invocationFilter]}{" "}
														<Icon name="x" size={9} />
													</Chip>
												)}
											</Chips>
										</SubheaderGroup>
									)}
								</>
							)}
						</>
					),
					right: rightCluster,
					}
				}
			/>
			)}

			<div
				className="main-body library-body"
				data-dock={registryEmpty && !bundleMode ? undefined : ""}
			>
				{pathInspect && <div ref={inspectorRef} tabIndex={-1}><Button variant="ghost" size="sm" onClick={() => setPathInspect(null)}>Close inspection</Button><ContributionPathInspector value={pathInspect.value} contributors={pathInspect.contributors} paths={pathInspect.paths} hasMore={!!pathInspect.cursor || pathInspect.contributorIndex + 1 < pathInspect.contributors.length} onLoadMore={loadMorePaths} onOpenContributor={(name) => openItem({ kind: "skill", id: name, name, route: `/skill/${encodeURIComponent(name)}`, key: pathInspect.occurrenceKey }, "none")} /></div>}
				{referencesLoading && <InfoBanner>Loading reference classifications…</InfoBanner>}
				{graphQuery.isError && classificationScope === "references" && <InfoBanner>{graph ? "Reference classifications are stale; showing cached values." : "References unavailable; showing assigned classifications."} <Button variant="ghost" size="sm" onClick={() => void graphQuery.refetch()}>Retry</Button></InfoBanner>}
				{!bundleMode && candidates.length > 0 && kindFilter !== "bundle" && kindFilter !== "snippet" && (
					<div className="library-candidate-banner">
						<ProjectLocalSkills
							candidates={candidates}
							onAdopt={adoptCandidate}
						/>
					</div>
				)}
				{!bundleMode && (mcpReconcile?.candidates ?? []).some(
					(c) => c.status === "new" || c.status === "conflict",
				) &&
					kindFilter !== "bundle" &&
					kindFilter !== "snippet" && (
						<div className="library-candidate-banner">
							<DetectedMcpServers
								candidates={mcpReconcile?.candidates ?? []}
								onAdopt={(cand) => adoptMcp(cand)}
								onAdoptAsRef={(cand) => adoptMcp(cand, { replaceWithRef: true })}
								onAdoptAnyway={(cand) => adoptMcp(cand, { allowLiteral: true })}
								onKeep={keepMcp}
								onCompare={setMcpCompareCand}
							/>
						</div>
					)}
				<McpCompareSheet
					open={mcpCompareCand !== null}
					onClose={() => setMcpCompareCand(null)}
					candidate={mcpCompareCand}
					onAdopt={compareAdoptMcp}
				/>
				{bundleLens ? (
					<div className="lib-results" {...nav.containerProps}><BundlePlaybook key={bundleLens.bundleName} lens={bundleLens} visible={filtered} renderSkill={renderSkill} /></div>
				) : registryEmpty ? (
					<EmptyState
						icon="skill"
						title="Create your first skill"
						/* Modelled on the hooks empty state: name the concept, give
						   concrete uses, then the way in. "Your registry has no skills
						   yet" only restated the blank screen back at the user. */
						description="A skill is a folder of instructions your coding agent loads on demand — a review checklist, a deploy runbook, a framework guide. Author one here, then equip it on the projects, bundles, and remotes that need it."
						action={
							<div style={{ display: "flex", gap: 8 }}>
								<Button variant="primary" icon="plus" onClick={openNewSkill}>
									New skill
								</Button>
								<Button variant="ghost" icon="project" onClick={openAddProject}>
									Add project
								</Button>
							</div>
						}
					/>
				) : kindFilter === "bundle" || kindFilter === "snippet" ? (
					crossHits.length === 0 ? (
						<EmptyState
							icon="search"
							title={kindFilter === "bundle" ? "No matching bundles" : "No matching snippets"}
							description="Try a different search."
							action={
								<Button variant="ghost" icon="skill" onClick={() => setKindFilter("all")}>
									Show skills
								</Button>
							}
						/>
					) : (
						// G1: the kind=bundle/snippet body IS one of the "ALL result
						// containers" the roving cursor owns — one `.lib-results`
						// ancestor, `nav.containerProps` spread exactly once.
						// NIT 10: `role="listbox"` here is pre-existing (it ships on
						// `useListNav`'s `.lib-list` container elsewhere too) and now
						// also wraps section headers/banners, not just option rows —
						// full combobox/`role="option"` ARIA is the listed follow-up.
						<div className="lib-results" {...nav.containerProps}>
							<SectionHeader
								label={kindFilter === "bundle" ? "BUNDLES" : "SNIPPETS"}
								count={crossHits.length}
							/>
							<div className="library-body-hits">
								{crossHits.map((h) => {
									const item = hitFlatItem(h);
									return (
										<div key={item.key} {...navRowProps(item.key)}>
											<ResourceRow
												glyph={<Icon name={h.item.kind} size={16} />}
												name={hitName(h)}
												desc={hitDesc(h)}
												excerpt={hitExcerpt(h)}
												ariaLabel={h.item.label}
												onClick={h.item.route ? () => openItem(item, "none") : undefined}
												dataset={{ testid: "library-body-hit", kind: h.item.kind, id: h.item.id }}
												tabIndex={-1}
											/>
										</div>
									);
								})}
							</div>
						</div>
					)
				) : referencesLoading ? (
					<EmptyState icon="search" title="Loading classifications" description="Waiting for reference classifications before showing derived matches." />
				) : filtered.length === 0 && bundleHits.length === 0 && snippetHits.length === 0 ? (
					<EmptyState
						icon="search"
						title="No matching skills"
						description="Try clearing the search, source filter, or trigger filter."
					/>
				) : (
					<>
						{/* review m6: a facet can silently hide every skill while a
						    cross-entity group still renders below — name the cause. */}
						{filtered.length === 0 && (sourceFilter || invocationFilter !== "all") && (
							<InfoBanner className="library-facet-hint">
								No skills match the current source or trigger filter.
							</InfoBanner>
						)}
						<div className="lib-results" {...nav.containerProps}>
							{/* Cross-entity matches only ever appear here with kind = all
							    and a non-empty query (crossHits is otherwise empty) — the
							    bundle screen and the unified search's own BUNDLES rows
							    already own "skills in bundle X" (there is no bundle
							    FACET), so this stays a name search, not a second filter
							    mode. Rendered ABOVE the skill groups (review M2): they are
							    the small, bounded set, and the floating dock sits right
							    where a "below the skill list" placement would land them —
							    invisible without a scroll. */}
							{bundleHits.length > 0 && (
								<>
									<SectionHeader label="BUNDLES" count={bundleHits.length} />
									<div className="library-body-hits">
										{bundleHits.map((h) => {
											const item = hitFlatItem(h);
											return (
												<div key={item.key} {...navRowProps(item.key)}>
													<ResourceRow
														glyph={<Icon name={h.item.kind} size={16} />}
														name={hitName(h)}
														desc={hitDesc(h)}
														excerpt={hitExcerpt(h)}
														ariaLabel={h.item.label}
														onClick={h.item.route ? () => openItem(item, "none") : undefined}
														dataset={{ testid: "library-body-hit", kind: h.item.kind, id: h.item.id }}
														tabIndex={-1}
													/>
												</div>
											);
										})}
									</div>
								</>
							)}
							{snippetHits.length > 0 && (
								<>
									<SectionHeader label="SNIPPETS" count={snippetHits.length} />
									<div className="library-body-hits">
										{snippetHits.map((h) => {
											const item = hitFlatItem(h);
											return (
												<div key={item.key} {...navRowProps(item.key)}>
													<ResourceRow
														glyph={<Icon name={h.item.kind} size={16} />}
														name={hitName(h)}
														desc={hitDesc(h)}
														excerpt={hitExcerpt(h)}
														ariaLabel={h.item.label}
														onClick={h.item.route ? () => openItem(item, "none") : undefined}
														dataset={{ testid: "library-body-hit", kind: h.item.kind, id: h.item.id }}
														tabIndex={-1}
													/>
												</div>
											);
										})}
									</div>
								</>
							)}
							{filtered.length > 0 &&
								(view === "list" ? (
									<div className="lib-list">
						{(grouping === "class" || grouping === "mode")
			? groupedByClassification.map((group) => <Fragment key={group.key}><SectionHeader label={group.label} count={group.items.length} detail={grouping === "class" ? "Grouped by assigned classes only." : undefined} />{group.items.map(([name, skill]) => renderSkill(name, skill, `skill:${name}:${group.key}`))}</Fragment>)
							: grouping === "scope"
											? GROUP_ORDER.map((scope) => {
													const items = groupedByScope[scope];
													if (items.length === 0) return null;
													return (
														<Fragment key={scope}>
															<SectionHeader label={GROUP_LABEL[scope]} count={items.length} />
											{items.map(([name, skill]) => {
												const key = skillFlatItem(name, skill).key;
												return (
													<div key={key} {...navRowProps(key)}>
																		<SkillRow referenceStats={rowReferences ? rowReferences.get(name) ?? { incoming: [], outgoing: [] } : undefined} bodyTokens={skillBodyTokens[name]}
																			name={name}
																			nameNode={listHits ? hitName(listHits.get(name)!) : undefined}
																			descNode={listHits ? hitDesc(listHits.get(name)!) : undefined}
																			excerpt={listHits ? hitExcerpt(listHits.get(name)) : undefined}
																			skill={skill}
																registry={registry}
															classification={classificationValues(skill, classificationSummaries.get(name), "references")}
																onClassificationInspect={(field, value) => inspectContribution(name, field, value, key)}
																			onClick={() => openItem(skillFlatItem(name, skill), "none")}
																			onOpenEquipPicker={(rect) => setEquipFor({ name, rect })}
																			equippedCount={equippedCounts.get(name) ?? 0}
																			bundleNames={bundlesBySkill.get(name) ?? []}
																			tabIndex={-1}
																detailOpen={openDetails.has(key)}
																onDetailToggle={() => toggleDetail(key)}
																			extraActions={bundleLens && <BundleRowAction lens={bundleLens} name={name} />}
																			source={
																				isExternalSource(sourceBySkill.get(name) ?? sources[0]) ? (
																					<SourceChip
																						compact
																						source={sourceBySkill.get(name) ?? sources[0]}
																						onClick={() => setSourceFilter(sourceBySkill.get(name)?.id ?? null)}
																					/>
																				) : undefined
																			}
																		/>
																	</div>
																);
															})}
														</Fragment>
													);
											  })
											: groupedBySource.map(({ source, items }) => (
													<Fragment key={source.id}>
														<SectionHeader
															label={source.name.toUpperCase()}
															count={items.length}
															accent={sourceAccent(source.id)}
															detail={
																source.type === "git" && source.url
																	? `${source.url}${source.branch ? ` · ${source.branch}` : ""}${
																			source.path ? ` · /${source.path}` : ""
																	  }`
																	: undefined
															}
														/>
														{items.map(([name, skill]) => {
															const key = skillFlatItem(name, skill).key;
															return (
																<div key={key} {...navRowProps(key)}>
																	<SkillRow referenceStats={rowReferences ? rowReferences.get(name) ?? { incoming: [], outgoing: [] } : undefined} bodyTokens={skillBodyTokens[name]}
																		name={name}
																		nameNode={listHits ? hitName(listHits.get(name)!) : undefined}
																		descNode={listHits ? hitDesc(listHits.get(name)!) : undefined}
																		excerpt={listHits ? hitExcerpt(listHits.get(name)) : undefined}
															skill={skill}
															registry={registry}
															classification={classificationValues(skill, classificationSummaries.get(name), "references")}
															onClassificationInspect={(field, value) => inspectContribution(name, field, value, key)}
															onClick={() => openItem(skillFlatItem(name, skill), "none")}
																		onOpenEquipPicker={(rect) => setEquipFor({ name, rect })}
																		equippedCount={equippedCounts.get(name) ?? 0}
																		bundleNames={bundlesBySkill.get(name) ?? []}
																		tabIndex={-1}
																detailOpen={openDetails.has(key)}
																onDetailToggle={() => toggleDetail(key)}
																		extraActions={bundleLens && <BundleRowAction lens={bundleLens} name={name} />}
																	/>
																</div>
															);
														})}
													</Fragment>
											  ))}
									</div>
								) : (
									<div className="skill-grid lib-grid">
										{filtered.map(([name, skill]) => {
											const cardSource = sourceBySkill.get(name) ?? sources[0];
											const cardEquipped = equippedCounts.get(name) ?? 0;
											const key = skillFlatItem(name, skill).key;
											return (
												<div key={key} {...navRowProps(key)}>
													<SkillCard
														name={name}
														nameNode={listHits ? hitName(listHits.get(name)!) : undefined}
														descNode={listHits ? hitDesc(listHits.get(name)!) : undefined}
														excerpt={listHits ? hitExcerpt(listHits.get(name)) : undefined}
														kind={skill.type}
														scope={skill.scope}
														description={skill.description}
																version={skill.version}
															classification={classificationValues(skill, classificationSummaries.get(name), "references")}
															workingMode={skill.classification?.working_mode}
															interactionStyle={skill.classification?.interaction_style}
															maturity={skill.classification?.maturity}
															onClassificationInspect={(field, value) => inspectContribution(name, field, value, key)}
														invocation={skill.invocation}
														onClick={() => openItem(skillFlatItem(name, skill), "none")}
														tabIndex={-1}
														badges={
															<>

																<span className="equipped-pip" data-active={cardEquipped > 0}>
																	<Icon name="equip" size={11} />
																	{cardEquipped}
																</span>
															</>
														}
														source={
															isExternalSource(cardSource) ? (
																<SourceChip compact source={cardSource} />
															) : undefined
														}
													/>
												</div>
											);
										})}
									</div>
								))}
						</div>
					</>
				)}
			</div>

			{(searchItems.length > 0 || bundleMode) && (
				<div className="floating-search-dock">
					<FloatingSearch
						value={q}
						onChange={setQ}
						placeholder={
							bundleMode ? "Search this bundle…" : "Search skills, MCP, bundles, snippets…"
						}
						screenSearch
						context={
							bundleLens
								? {
										icon: "bundle",
										label: bundleLens.bundleName,
										onClear: () => navigate("/"),
										testid: "bundle-context-pill",
									}
								: undefined
						}
						kinds={(bundleMode
							? KIND_OPTIONS.filter((k) => k.value !== "bundle" && k.value !== "snippet")
							: KIND_OPTIONS
						).map((k) => ({ ...k, count: counts[k.value] }))}
						activeKind={kindFilter}
						onKindChange={setKindFilter}
						onCommit={onCommit}
						onMove={onMove}
						onFocusCursor={onFocusCursor}
						inputRef={searchInputRef}
					/>
					{/* G8: live-region announcement — not full combobox ARIA this
					    round (see the `liveMessage` state doc above). */}
					<span className="sr-only" aria-live="polite" data-testid="library-search-live">
						{liveMessage}
					</span>
				</div>
			)}

			<Popover
				open={filterOpen}
				onClose={() => setFilterOpen(false)}
				anchorRef={filterAnchorRef}
				label="Filter skills"
				width={400}
				className="library-filter-popover"
			>
				<LibraryFacets
					layout="stack"
					sources={sources}
					sourceFilter={sourceFilter}
					setSourceFilter={setSourceFilter}
					invocationFilter={invocationFilter}
					setInvocationFilter={setInvocationFilter}
						hasConflicted={hasConflicted}
						classFilter={classFilter} classOptions={classOptions} setClassFilter={setClassFilter} modeFilter={modeFilter} setModeFilter={setModeFilter} classificationScope={classificationScope} setClassificationScope={setClassificationScope}
				/>
				<div className="library-filter-foot">
					<Button
						variant="ghost"
						size="sm"
						disabled={activeFilterCount === 0}
						onClick={clearFacets}
					>
						Clear filters
					</Button>
				</div>
			</Popover>

			{equipFor && (
				<RowEquipPopover
					name={equipFor.name}
					rect={equipFor.rect}
					registry={registry}
					onClose={() => setEquipFor(null)}
				/>
			)}

			<NewSkillSheet
				open={showNewSkill}
				onClose={closeNewSkill}
				initialMcpMode={newSkillMcpMode}
			/>
			<NewBundleSheet open={showNewBundle} onClose={closeNewBundle} />
			<AddProjectSheet open={showAddProject} onClose={closeAddProject} />
			{importPack && (
				<ImportSkillDialog
					open
					filePath={importPack.path}
					preview={importPack.preview}
					onClose={() => setImportPack(null)}
					onImported={(name) => {
						void invalidateRegistry(queryClient);
						toast.success(`Imported "${name}"`);
						navigate(`/skill/${encodeURIComponent(name)}`);
					}}
				/>
			)}
		</>
	);
}

interface LibraryFacetsProps {
	layout: "row" | "stack";
	sources: SourceView[];
	sourceFilter: string | null;
	setSourceFilter: (id: string | null) => void;
	invocationFilter: InvocationFilter;
	setInvocationFilter: (f: InvocationFilter) => void;
	classFilter: string | null;
	classOptions: string[];
	setClassFilter: (value: string | null) => void;
	modeFilter: "all" | "inline" | "delegator" | "mixed";
	setModeFilter: (value: "all" | "inline" | "delegator" | "mixed") => void;
	classificationScope: ClassificationScope;
	setClassificationScope: (value: ClassificationScope) => void;
	/** Any skill in the registry is `conflicted` — only then is that option shown. */
	hasConflicted: boolean;
}

/** SOURCE + TRIGGER facets, shared between the row (inline, "wide") and the
 *  Filter popover (stacked, "narrow") — one definition so the two never
 *  drift in which options or copy they offer. SOURCE is a `Select`, not a
 *  chip row: a real registry can carry half a dozen+ sources, each with a
 *  name and a count — a chip per source never fits inline at any realistic
 *  width, where a combobox costs one closed-trigger width regardless of how
 *  many options it holds. */
function LibraryFacets({
	layout,
	sources,
	sourceFilter,
	setSourceFilter,
	invocationFilter,
	setInvocationFilter,
	hasConflicted,
	classFilter, classOptions, setClassFilter, modeFilter, setModeFilter, classificationScope, setClassificationScope,
}: LibraryFacetsProps) {
	const sourceOptions: SelectOption<string>[] = [
		{ value: "all", label: "All" },
		...sources.map((s) => {
			const statusWord = s.status ? SOURCE_STATUS_HINT[s.status] : undefined;
			return {
				value: s.id,
				label: s.name,
				hint: `${s.skill_count ?? 0} skills${statusWord ? ` · ${statusWord}` : ""}`,
				dot: SOURCE_STATUS_DOT[s.status ?? "unknown"] ?? sourceAccent(s.id),
			};
		}),
	];
	const selectedSourceName = sources.find((s) => s.id === sourceFilter)?.name;
	const sourceSelect = (
		<Select
			label="Source"
			value={sourceFilter ?? "all"}
			options={sourceOptions}
			onChange={(v) => setSourceFilter(v === "all" ? null : v)}
			title={
				selectedSourceName
					? `Showing skills from ${selectedSourceName}`
					: "Showing skills from every source"
			}
			// ROW layout only: `.main-subheader-left`'s `overflow-x: auto` (an
			// edge-fade scroll cue for a long chip strip) computes `overflow-y`
			// to `auto` too per the CSS Overflow spec (a mixed visible/
			// non-visible pair is not achievable), so a plain `position:
			// absolute` dropdown gets silently clipped/scroll-trapped to a
			// sliver. The STACK layout must stay non-portal: it already sits
			// inside the Filter `Popover` (itself `position: fixed`, unclipped),
			// and portalling the menu OUT of the popover's own DOM subtree would
			// make `Popover`'s outside-mousedown check read a click on an option
			// as "outside" and close the whole popover before the pick lands.
			menuPortal={layout === "row"}
		/>
	);

	const triggerOptions: [InvocationFilter, string][] = [
		["all", TRIGGER_FILTER_LABEL.all],
		["auto", TRIGGER_FILTER_LABEL.auto],
		["user-only", TRIGGER_FILTER_LABEL["user-only"]],
		["model-only", TRIGGER_FILTER_LABEL["model-only"]],
		// Also shown while `conflicted` is the ACTIVE filter even if the
		// registry no longer has a conflicted skill (e.g. the one that had it
		// got fixed or re-synced) — otherwise the lit chip vanishes out from
		// under an active filter, leaving it unclearable from the row itself.
		...(hasConflicted || invocationFilter === "conflicted"
			? ([["conflicted", TRIGGER_FILTER_LABEL.conflicted]] as [InvocationFilter, string][])
			: []),
	];
	const triggerChips = (
		<Chips>
			{triggerOptions.map(([value, label]) => (
				<Chip
					key={value}
					pressed={invocationFilter === value}
					onClick={() =>
						setInvocationFilter(invocationFilter === value ? "all" : value)
					}
				>
					{label}
				</Chip>
			))}
		</Chips>
	);
	const classControl = (
		<div className="filter-group"><span className="filter-label">CLASS</span><Select label="Class" value={classFilter ? `class:${classFilter}` : "all"} options={[{ value: "all", label: "All" }, ...classOptions.map((value) => ({ value: `class:${value}`, label: value }))]} onChange={(value) => setClassFilter(value === "all" ? null : value.replace(/^class:/, ""))} menuPortal={layout === "row"} /></div>
	);
	const classificationControls = <>
		<div className="filter-group"><span className="filter-label">MODE</span><Chips>{(["all", "inline", "delegator", "mixed"] as const).map((value) => <Chip key={value} pressed={modeFilter === value} onClick={() => setModeFilter(value)}>{value === "all" ? "All" : value}</Chip>)}</Chips></div>
		<div className="filter-group"><span className="filter-label">CLASS MATCHING</span><Chips><Chip pressed={classificationScope === "references"} title="Applies to class filters; grouping uses assigned classes." onClick={() => setClassificationScope("references")}>Assigned + references</Chip><Chip pressed={classificationScope === "assigned"} title="Applies to class filters; grouping uses assigned classes." onClick={() => setClassificationScope("assigned")}>Assigned only</Chip></Chips></div>
	</>;

	if (layout === "row") {
		return (
			<>
				<SubheaderGroup label="SOURCE">{sourceSelect}</SubheaderGroup>
				<SubheaderGroup label="TRIGGER">{triggerChips}</SubheaderGroup>
				{classControl}
				{classificationControls}
			</>
		);
	}
	return (
		<>
			<div className="library-filter-selects">
				<div className="filter-group">
					<span className="filter-label">SOURCE</span>
					{sourceSelect}
				</div>
				{classControl}
			</div>
			{classificationControls}
			<div className="filter-group">
				<span className="filter-label">TRIGGER</span>
				{triggerChips}
			</div>
		</>
	);
}

const ROW_EQUIP_POPOVER_WIDTH = 340;
const ROW_EQUIP_POPOVER_MAX_HEIGHT = 320;
const VIEWPORT_GUTTER_PX = 8;
const POPOVER_Y_OFFSET_PX = 4;

/** Skill→projects equip popover anchored under a Library row's equip button. */
function RowEquipPopover({
	name,
	rect,
	registry,
	onClose,
}: {
	name: string;
	rect: DOMRect;
	registry: Registry;
	onClose: () => void;
}) {
	const onToggle = useSkillProjectEquip(name);
	const targets = buildSkillProjectTargets(name, registry);
	const left = Math.max(
		VIEWPORT_GUTTER_PX,
		Math.min(rect.left, window.innerWidth - ROW_EQUIP_POPOVER_WIDTH - VIEWPORT_GUTTER_PX),
	);
	const top = Math.min(
		rect.bottom + POPOVER_Y_OFFSET_PX,
		window.innerHeight - ROW_EQUIP_POPOVER_MAX_HEIGHT,
	);
	return (
		<div
			className="equip-anchor-layer"
			style={{ position: "fixed", top, left, width: ROW_EQUIP_POPOVER_WIDTH, zIndex: 60 }}
		>
			<EquipPicker
				variant="popover"
				subject={{ kind: "skill", name }}
				targets={targets}
				onToggle={onToggle}
				onClose={onClose}
				searchPlaceholder="Equip on project…"
				emptyLabel="No projects registered."
			/>
		</div>
	);
}
