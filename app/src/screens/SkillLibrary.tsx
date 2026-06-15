import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
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
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubheaderGroup } from "@/components/SubheaderGroup";
import { SearchInput } from "@/components/SearchInput";
import { SectionHeader } from "@/components/SectionHeader";
import { EmptyState } from "@/components/EmptyState";
import { bundleColor } from "@/components/bundleColors";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
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

							<SubheaderGroup label="SOURCE">
								<Chips role="tablist">
									<Chip
										pressed={sourceFilter === null}
										onClick={() => setSourceFilter(null)}
									>
										ALL
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
							</SubheaderGroup>

							{bundles.length > 0 && (
								<SubheaderGroup label="BUNDLE">
									<Chips>
										{bundles.map(([name]) => (
											<Chip
												key={name}
												pressed={bundleFilter === name}
												dotColor={bundleColor(name)}
												onClick={() =>
													setBundleFilter(bundleFilter === name ? null : name)
												}
												title={`Filter by bundle: ${name}`}
											>
												{name}
											</Chip>
										))}
									</Chips>
								</SubheaderGroup>
							)}
						</>
					),
					right: (
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
					),
				}}
			/>

			<div className="main-body">
				{filtered.length === 0 ? (
					<EmptyState
						icon="search"
						title="No skills match your filters."
						description="Try clearing the search, source filter, or bundle filter."
					/>
				) : view === "list" ? (
					<>
						{grouping === "scope"
							? GROUP_ORDER.map((scope) => {
									const items = groupedByScope[scope];
									if (items.length === 0) return null;
									return (
										<Fragment key={scope}>
											<SectionHeader label={GROUP_LABEL[scope]} count={items.length} />
											{items.map(([name, skill]) => (
												<SkillRow
													key={name}
													name={name}
													skill={skill}
													registry={registry}
													onClick={() => navigate(`/skill/${encodeURIComponent(name)}`)}
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
											<SkillRow
												key={name}
												name={name}
												skill={skill}
												registry={registry}
												onClick={() => navigate(`/skill/${encodeURIComponent(name)}`)}
												equippedCount={equippedCounts.get(name) ?? 0}
												bundleTags={(bundlesBySkill.get(name) ?? []).map((bn) => ({
													name: bn,
													color: bundleColor(bn),
												}))}
												source={<SourceChip compact source={source} />}
											/>
										))}
									</Fragment>
							  ))}
						<div style={{ height: 80 }} />
					</>
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

			<NewSkillSheet open={showNewSkill} onClose={closeNewSkill} />
			<NewBundleSheet open={showNewBundle} onClose={closeNewBundle} />
			<AddProjectSheet open={showAddProject} onClose={closeAddProject} />
		</>
	);
}
