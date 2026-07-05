import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { useAppStore } from "@/store";
import { SkillRow } from "@/components/SkillRow";
import { SkillCard } from "@/components/SkillCard";
import { SourceChip } from "@/components/SourceChip";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { NewBundleSheet } from "@/components/NewBundleSheet";
import { AddProjectSheet } from "@/components/AddProjectSheet";
import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { Chips, Chip } from "@/components/Chips";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubheaderGroup } from "@/components/SubheaderGroup";
import { SearchInput } from "@/components/SearchInput";
import { SectionHeader } from "@/components/SectionHeader";
import { EmptyState } from "@/components/EmptyState";
import { EquipPicker } from "@/components/EquipPicker";
import {
	ProjectLocalSkills,
	type ProjectSkillCandidate,
} from "@/components/ProjectLocalSkills";
import { bundleColor } from "@/components/bundleColors";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { buildSkillProjectTargets } from "@/hooks/useEquipTargets";
import { useSkillProjectEquip } from "@/hooks/useEquip";
import { useListNav } from "@/hooks/useListNav";
import { useLocalCandidates } from "@/hooks/useLocalCandidates";
import { useToast } from "@/components/Toast";
import {
	deriveSources,
	getSourceView,
	inferSkillSourceId,
	sourceAccent,
} from "@/lib/skillSource";
import type { Registry, Skill, SkillScope, SourceView } from "@/types";

type KindFilter = "all" | "skill" | "mcp";
type View = "list" | "grid";
type GroupingMode = "scope" | "source";

type GroupKey = "global" | "portable" | "project";

const GROUP_ORDER: GroupKey[] = ["global", "portable", "project"];

const GROUP_LABEL: Record<GroupKey, string> = {
	global: "GLOBAL",
	portable: "PORTABLE",
	project: "PROJECT",
};

const GROUPING_LS_KEY = "st-library-grouping";

function scopeToGroup(scope: SkillScope | undefined): GroupKey {
	if (scope === "portable") return "portable";
	if (scope === "project-specific") return "project";
	return "global";
}

function loadGroupingPref(): GroupingMode {
	if (typeof window === "undefined") return "scope";
	const stored = window.localStorage.getItem(GROUPING_LS_KEY);
	return stored === "source" ? "source" : "scope";
}

function persistGroupingPref(mode: GroupingMode) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(GROUPING_LS_KEY, mode);
}

export function SkillLibrary() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: registry, isLoading, error } = useRegistry();

	const [q, setQ] = useState("");
	const [kindFilter, setKindFilter] = useState<KindFilter>("all");
	const [bundleFilter, setBundleFilter] = useState<string | null>(null);
	const [sourceFilter, setSourceFilter] = useState<string | null>(null);
	const [grouping, setGrouping] = useState<GroupingMode>(() => loadGroupingPref());
	const [view, setView] = useState<View>("list");
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

	function openNewSkill() {
		setShowNewSkill(true);
	}

	function closeNewSkill() {
		setShowNewSkill(false);
		if (searchParams.get("new") === "1") {
			const next = new URLSearchParams(searchParams);
			next.delete("new");
			setSearchParams(next, { replace: true });
		}
	}

	function closeNewBundle() {
		setShowNewBundle(false);
		if (searchParams.get("addBundle") === "1") {
			const next = new URLSearchParams(searchParams);
			next.delete("addBundle");
			setSearchParams(next, { replace: true });
		}
	}

	function closeAddProject() {
		setShowAddProject(false);
		if (searchParams.get("addProject") === "1") {
			const next = new URLSearchParams(searchParams);
			next.delete("addProject");
			setSearchParams(next, { replace: true });
		}
	}

	if (isLoading) {
		return (
			<div className="main-body">
				<EmptyState icon="search" title="Loading library" description="Reading your registry…" />
			</div>
		);
	}

	if (error || !registry) {
		return (
			<div className="main-body">
				<EmptyState
					icon="search"
					title="Library unavailable"
					description={String(error ?? "Failed to load registry")}
				/>
			</div>
		);
	}

	return (
		<LibraryView
			registry={registry}
			navigate={navigate}
			q={q}
			setQ={setQ}
			kindFilter={kindFilter}
			setKindFilter={setKindFilter}
			bundleFilter={bundleFilter}
			setBundleFilter={setBundleFilter}
			sourceFilter={sourceFilter}
			setSourceFilter={setSourceFilter}
			grouping={grouping}
			setGrouping={setGrouping}
			view={view}
			setView={setView}
			openNewSkill={openNewSkill}
			showNewSkill={showNewSkill}
			closeNewSkill={closeNewSkill}
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
	navigate: ReturnType<typeof useNavigate>;
	q: string;
	setQ: (v: string) => void;
	kindFilter: KindFilter;
	setKindFilter: (k: KindFilter) => void;
	bundleFilter: string | null;
	setBundleFilter: (b: string | null) => void;
	sourceFilter: string | null;
	setSourceFilter: (s: string | null) => void;
	grouping: GroupingMode;
	setGrouping: (g: GroupingMode) => void;
	view: View;
	setView: (v: View) => void;
	openNewSkill: () => void;
	showNewSkill: boolean;
	closeNewSkill: () => void;
	showNewBundle: boolean;
	closeNewBundle: () => void;
	openAddProject: () => void;
	showAddProject: boolean;
	closeAddProject: () => void;
}

function LibraryView({
	registry,
	navigate,
	q,
	setQ,
	kindFilter,
	setKindFilter,
	bundleFilter,
	setBundleFilter,
	sourceFilter,
	setSourceFilter,
	grouping,
	setGrouping,
	view,
	setView,
	openNewSkill,
	showNewSkill,
	closeNewSkill,
	showNewBundle,
	closeNewBundle,
	openAddProject,
	showAddProject,
	closeAddProject,
}: LibraryViewProps) {
	const setSyncStatus = useAppStore((s) => s.setSyncStatus);
	const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);
	const toast = useToast();
	const [filterOpen, setFilterOpen] = useState(false);
	const [equipFor, setEquipFor] = useState<{ name: string; rect: DOMRect } | null>(
		null,
	);
	const { data: localCandidates } = useLocalCandidates();

	async function adoptCandidate(cand: ProjectSkillCandidate) {
		const res = await invoke<{ success: boolean; output: string }>("hub_cmd", {
			args: ["project", "import-skill", cand.name, "--project", cand.project],
		});
		if (!res.success) {
			toast.error("Adopt failed", res.output.trim() || undefined);
			throw new Error(res.output);
		}
		toast.success(`Adopted ${cand.name}`, `equipped on ${cand.project}`);
		await queryClient.invalidateQueries({ queryKey: ["registry"] });
		await queryClient.invalidateQueries({ queryKey: ["localCandidates"] });
	}

	async function runSync() {
		setSyncStatus("syncing");
		try {
			await trackProcess(
				{ title: "Registry sync", body: "writing .claude / .agents", kind: "local" },
				async () => {
					const result = await invoke<{ success: boolean; output: string }>(
						"hub_cmd",
						{ args: ["sync"] },
					);
					if (!result.success) throw new Error(result.output);
					await queryClient.invalidateQueries({ queryKey: ["registry"] });
					return result;
				},
				{ successBody: "registry aligned", retry: () => void runSync() },
			);
			setSyncStatus("synced");
			setLastSyncedAt(new Date());
		} catch {
			setSyncStatus("error");
		}
	}

	const allSkills = useMemo(
		() => Object.entries(registry.skills) as Array<[string, Skill]>,
		[registry.skills],
	);

	const bundles = useMemo(
		() => Object.entries(registry.bundles),
		[registry.bundles],
	);

	const sources = useMemo<SourceView[]>(() => deriveSources(registry), [registry]);

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

	const counts = useMemo(() => {
		let skill = 0;
		let mcp = 0;
		for (const [, s] of allSkills) {
			if (s.type === "mcp-server") mcp++;
			else skill++;
		}
		return { all: allSkills.length, skill, mcp };
	}, [allSkills]);

	const filtered = useMemo(() => {
		const lq = q.trim().toLowerCase();
		return allSkills.filter(([name, s]) => {
			if (kindFilter === "mcp" && s.type !== "mcp-server") return false;
			if (kindFilter === "skill" && s.type === "mcp-server") return false;
			if (bundleFilter) {
				const inBundle = (registry.bundles[bundleFilter]?.skills ?? []).includes(name);
				if (!inBundle) return false;
			}
			if (sourceFilter) {
				const sid = sourceBySkill.get(name)?.id ?? "local";
				if (sid !== sourceFilter) return false;
			}
			if (lq) {
				const hay = name.toLowerCase() + " " + (s.description ?? "").toLowerCase();
				if (!hay.includes(lq)) return false;
			}
			return true;
		});
	}, [allSkills, q, kindFilter, bundleFilter, sourceFilter, registry.bundles, sourceBySkill]);

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

	const total = Object.keys(registry.skills).length;
	const activeFilterCount = (sourceFilter ? 1 : 0) + (bundleFilter ? 1 : 0);
	const candidates = localCandidates ?? [];

	// Roving keyboard nav (ux-command-layer D6). Flat render order across every
	// group so j/k crosses group boundaries; `e` opens the equip picker anchored
	// to the focused row.
	const flatRows = useMemo(
		() =>
			grouping === "scope"
				? GROUP_ORDER.flatMap((scope) =>
						groupedByScope[scope].map(([name]) => name),
					)
				: groupedBySource.flatMap((g) => g.items.map(([name]) => name)),
		[grouping, groupedByScope, groupedBySource],
	);
	const rowIndex = useMemo(
		() => new Map(flatRows.map((n, i) => [n, i])),
		[flatRows],
	);
	const rowEls = useRef<(HTMLElement | null)[]>([]);
	const nav = useListNav({
		count: flatRows.length,
		onOpen: (i) => {
			const name = flatRows[i];
			if (name) navigate(`/skill/${encodeURIComponent(name)}`);
		},
		onSecondary: (i) => {
			const name = flatRows[i];
			const el = rowEls.current[i];
			if (name && el) setEquipFor({ name, rect: el.getBoundingClientRect() });
		},
	});
	function navRowProps(name: string) {
		const i = rowIndex.get(name) ?? 0;
		const { ref, ...rest } = nav.itemProps(i);
		return {
			className: "lib-nav-row",
			ref: (el: HTMLDivElement | null) => {
				ref(el);
				rowEls.current[i] = el;
			},
			...rest,
		};
	}

	return (
		<>
			<ScreenHeader
				title="Library"
				meta={
					<Tag size="md" color="var(--fg-mute)" style={{ textTransform: "none" }}>
						{filtered.length} of {total}
					</Tag>
				}
				crumbs={[
					"skill-tree",
					"library",
					...(sourceFilter
						? [
								<span style={{ color: "var(--violet-2)" }} key="src">
									source:{" "}
									{sources.find((s) => s.id === sourceFilter)?.name ??
										sourceFilter}
								</span>,
							]
						: []),
				]}
				primary={
					<Button variant="primary" icon="plus" onClick={openNewSkill}>
						New skill
					</Button>
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
						onClick: () => void runSync(),
					},
				]}
				subheader={{
					left: (
						<>
							<SearchInput
								value={q}
								onChange={setQ}
								placeholder="Search skills, tags, descriptions…"
								autoFocus
								screenSearch
							/>
							<SubheaderGroup>
								<Chips role="tablist">
									<Chip
										pressed={kindFilter === "all"}
										onClick={() => setKindFilter("all")}
									>
										ALL <span className="count">{counts.all}</span>
									</Chip>
									<Chip
										pressed={kindFilter === "skill"}
										icon="skill"
										onClick={() => setKindFilter("skill")}
									>
										SKILL <span className="count">{counts.skill}</span>
									</Chip>
									<Chip
										pressed={kindFilter === "mcp"}
										icon="mcp"
										onClick={() => setKindFilter("mcp")}
									>
										MCP <span className="count">{counts.mcp}</span>
									</Chip>
								</Chips>
							</SubheaderGroup>

							<SubheaderGroup>
								<Chips>
									<Chip
										icon="filter"
										pressed={filterOpen}
										onClick={() => setFilterOpen(true)}
										title="Filter by source, bundle, or grouping"
									>
										Filter
										{activeFilterCount > 0 && (
											<span className="count">{activeFilterCount}</span>
										)}
									</Chip>
								</Chips>
							</SubheaderGroup>

							{(sourceFilter || bundleFilter) && (
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
										{bundleFilter && (
											<Chip
												pressed
												dotColor={bundleColor(bundleFilter)}
												onClick={() => setBundleFilter(null)}
												title="Clear bundle filter"
											>
												bundle: {bundleFilter} <Icon name="x" size={9} />
											</Chip>
										)}
									</Chips>
								</SubheaderGroup>
							)}
						</>
					),
					right: (
						<>
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
					),
				}}
			/>

			<div className="main-body">
				{candidates.length > 0 && (
					<div className="library-candidate-banner">
						<ProjectLocalSkills
							candidates={candidates}
							onAdopt={adoptCandidate}
						/>
					</div>
				)}
				{total === 0 ? (
					<EmptyState
						icon="skill"
						title="Create your first skill"
						description="Your registry has no skills yet. Author one to start equipping projects, bundles, and remotes."
						action={
							<Button variant="primary" icon="plus" onClick={openNewSkill}>
								New skill
							</Button>
						}
					/>
				) : filtered.length === 0 ? (
					<EmptyState
						icon="search"
						title="No skills match your filters."
						description="Try clearing the search, source filter, or bundle filter."
					/>
				) : view === "list" ? (
					<div {...nav.containerProps} className="lib-list">
						{grouping === "scope"
							? GROUP_ORDER.map((scope) => {
									const items = groupedByScope[scope];
									if (items.length === 0) return null;
									return (
										<Fragment key={scope}>
											<SectionHeader label={GROUP_LABEL[scope]} count={items.length} />
											{items.map(([name, skill]) => (
												<div key={name} {...navRowProps(name)}>
													<SkillRow
														name={name}
														skill={skill}
														registry={registry}
														onClick={() => navigate(`/skill/${encodeURIComponent(name)}`)}
														onOpenEquipPicker={(rect) => setEquipFor({ name, rect })}
														equippedCount={equippedCounts.get(name) ?? 0}
														bundleTags={(bundlesBySkill.get(name) ?? []).map((bn) => ({
															name: bn,
															color: bundleColor(bn),
														}))}
														source={
															<SourceChip
																compact
																source={sourceBySkill.get(name) ?? sources[0]}
																onClick={() => setSourceFilter(sourceBySkill.get(name)?.id ?? null)}
															/>
														}
													/>
												</div>
											))}
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
										{items.map(([name, skill]) => (
											<div key={name} {...navRowProps(name)}>
												<SkillRow
													name={name}
													skill={skill}
													registry={registry}
													onClick={() => navigate(`/skill/${encodeURIComponent(name)}`)}
													onOpenEquipPicker={(rect) => setEquipFor({ name, rect })}
													equippedCount={equippedCounts.get(name) ?? 0}
													bundleTags={(bundlesBySkill.get(name) ?? []).map((bn) => ({
														name: bn,
														color: bundleColor(bn),
													}))}
													source={<SourceChip compact source={source} />}
												/>
											</div>
										))}
									</Fragment>
							  ))}
						<div style={{ height: 80 }} />
					</div>
				) : (
					<div className="skill-grid" style={{ padding: "20px 24px" }}>
						{filtered.map(([name, skill]) => (
							<SkillCard
								key={name}
								name={name}
								kind={skill.type}
								scope={skill.scope}
								description={skill.description}
								version={skill.version}
								onClick={() => navigate(`/skill/${encodeURIComponent(name)}`)}
								source={<SourceChip compact source={sourceBySkill.get(name) ?? sources[0]} />}
							/>
						))}
					</div>
				)}
			</div>

			<Modal
				open={filterOpen}
				onClose={() => setFilterOpen(false)}
				title="Filter skills"
				width={420}
				footer={
					<>
						<Button
							variant="ghost"
							onClick={() => {
								setSourceFilter(null);
								setBundleFilter(null);
							}}
							disabled={activeFilterCount === 0}
						>
							Clear filters
						</Button>
						<Button variant="primary" onClick={() => setFilterOpen(false)}>
							Done
						</Button>
					</>
				}
			>
				<div className="library-filter-popover">
					<div className="filter-group">
						<span className="filter-label">SOURCE</span>
						<Chips>
							<Chip
								pressed={sourceFilter === null}
								onClick={() => setSourceFilter(null)}
							>
								All
							</Chip>
							{sources.map((s) => {
								const updateIndicator =
									s.status === "update-available"
										? "var(--amber)"
										: s.status === "error"
											? "var(--red)"
											: undefined;
								return (
									<Chip
										key={s.id}
										pressed={sourceFilter === s.id}
										dotColor={updateIndicator ?? sourceAccent(s.id)}
										onClick={() =>
											setSourceFilter(sourceFilter === s.id ? null : s.id)
										}
										title={`Filter by source: ${s.name}${s.status ? ` (${s.status})` : ""}`}
									>
										{s.name} <span className="count">{s.skill_count ?? 0}</span>
									</Chip>
								);
							})}
						</Chips>
					</div>
					{bundles.length > 0 && (
						<div className="filter-group">
							<span className="filter-label">BUNDLE</span>
							<Chips>
								<Chip
									pressed={bundleFilter === null}
									onClick={() => setBundleFilter(null)}
								>
									All
								</Chip>
								{bundles.map(([name]) => (
									<Chip
										key={name}
										pressed={bundleFilter === name}
										dotColor={bundleColor(name)}
										onClick={() =>
											setBundleFilter(bundleFilter === name ? null : name)
										}
									>
										{name}
									</Chip>
								))}
							</Chips>
						</div>
					)}
					<div className="filter-group">
						<span className="filter-label">GROUP BY</span>
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
						</Chips>
					</div>
				</div>
			</Modal>

			{equipFor && (
				<RowEquipPopover
					name={equipFor.name}
					rect={equipFor.rect}
					registry={registry}
					onClose={() => setEquipFor(null)}
				/>
			)}

			<NewSkillSheet open={showNewSkill} onClose={closeNewSkill} />
			<NewBundleSheet open={showNewBundle} onClose={closeNewBundle} />
			<AddProjectSheet open={showAddProject} onClose={closeAddProject} />
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
