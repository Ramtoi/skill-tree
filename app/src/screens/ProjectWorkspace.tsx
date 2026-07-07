import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "@/components/Toast";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { useAppStore } from "@/store";
import {
	bundleProvidedSkills,
	directOnly as directOnlySkills,
	getBundleScope,
	resolveActiveSkills,
} from "@/lib/resolveActiveSkills";
import {
	projectFreshness,
	projectRecord,
	relTime,
} from "@/lib/syncFreshness";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { affinityMismatch } from "@/lib/affinity";
import { useHarnesses } from "@/hooks/useHarnesses";
import { shortenPath } from "@/lib/shortenPath";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag, ScopeBadge } from "@/components/Tag";
import { SkillInvocationOverride } from "@/components/SkillInvocationOverride";
import type { OverrideChoice } from "@/lib/invocation";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubheaderViewChips } from "@/components/SubheaderViewChips";
import { PROJECT_VIEWS, type ProjectView } from "@/lib/projectViews";
import { StatCard } from "@/components/StatCard";
import { SkillCard } from "@/components/SkillCard";
import {
	BundleChip,
	BundleChipAdd,
	type BundleChipAddOption,
} from "@/components/BundleChip";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";
import { bundleColor } from "@/components/bundleColors";
import { TreeView } from "@/components/TreeView";
import { ResizableSplit } from "@/components/ResizableSplit";
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { RemoveProjectDialog } from "@/components/RemoveProjectDialog";
import { HarnessTargetsLine } from "@/components/harness/HarnessTargetsLine";
import { HarnessIconGroup } from "@/components/harness/HarnessGlyph";
import { AgentDocsView } from "@/components/AgentDocsView";
import { ProjectPermissionsTab } from "@/components/ProjectPermissionsTab";
import {
	ProjectLocalSkills,
	type ProjectSkillCandidate,
} from "@/components/ProjectLocalSkills";
import { SubagentManager } from "@/components/subagents/SubagentManager";
import type { SkillScope } from "@/types";

type View = ProjectView;
type DropZone = "equipped" | "avail" | null;

// Concise per-state copy for the narrow Sync stat card (the full "registry
// changed — re-sync" phrasing lives in the StatusBar drawer).
const SYNC_CARD_LABEL: Record<
	"fresh" | "stale" | "unknown" | "error",
	string
> = {
	fresh: "in sync",
	stale: "registry changed",
	unknown: "run sync",
	error: "sync failed",
};
type EquipSort = "newest" | "name";
type EquipStatus = "pending" | "success" | "error";

export function ProjectWorkspace() {
	const { name: projectName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const { data: registry, isLoading } = useRegistry();
	const { data: syncEnvelope } = useSyncReport();
	const harnesses = useHarnesses();
	const installedHarnessIds = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);
	const toast = useToast();
	const runUndoable = useUndoableAction();
	const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);
	const setSyncStatus = useAppStore((s) => s.setSyncStatus);
	const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);

	// Deep-link into a tab via `?tab=` (palette "Open project…" verb).
	const PROJECT_TABS: View[] = [
		"loadout",
		"tree",
		"agent-docs",
		"permissions",
		"subagents",
	];
	const initialTab = searchParams.get("tab");
	const [view, setView] = useState<View>(() =>
		initialTab && (PROJECT_TABS as string[]).includes(initialTab)
			? (initialTab as View)
			: "loadout",
	);
	const [dragOver, setDragOver] = useState<DropZone>(null);
	const [availQuery, setAvailQuery] = useState("");
	const [expandedAvailable, setExpandedAvailable] = useState<Set<string>>(
		() => new Set(),
	);
	const [equipStatus, setEquipStatus] = useState<Record<string, EquipStatus>>(
		{},
	);
	const [recentlyEquipped, setRecentlyEquipped] = useState<
		Record<string, number>
	>({});
	const [equipSort, setEquipSort] = useState<EquipSort>("newest");
	const [showEditPath, setShowEditPath] = useState(false);
	const [showRemove, setShowRemove] = useState(false);

	useEffect(() => {
		if (projectName) addRecentlyVisited({ type: "project", name: projectName });
	}, [projectName, addRecentlyVisited]);

	// Follow a later `?tab=` change while the component stays mounted.
	useEffect(() => {
		if (initialTab && (PROJECT_TABS as string[]).includes(initialTab)) {
			setView(initialTab as View);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialTab]);

	const projPath = projectName
		? registry?.projects?.[projectName]?.path
		: undefined;
	const envPath = projPath ? `${projPath}/.env` : "";
	const { data: envExists } = useQuery({
		queryKey: ["env-exists", projPath],
		queryFn: () => invoke<boolean>("path_exists", { path: envPath }),
		enabled: !!projPath,
	});

	const { data: localCandidates } = useQuery({
		queryKey: ["project-candidates", projectName],
		queryFn: () =>
			invoke<ProjectSkillCandidate[]>("project_scan_candidates", {
				name: projectName,
			}),
		enabled: !!projectName,
	});

	if (isLoading) {
		return (
			<EmptyState
				icon="bolt"
				title="Loading workspace"
				description="Preparing project state, bundle membership, and active skill resolution."
			/>
		);
	}

	if (!projectName || !registry?.projects?.[projectName]) {
		return (
			<EmptyState
				icon="project"
				title={
					projectName
						? `Project "${projectName}" not found`
						: "No project selected"
				}
				description="Register a project to manage bundles and project-specific skill activation."
			/>
		);
	}

	const proj = registry.projects[projectName];

	// --- mutations --------------------------------------------------------

	async function createEnvFile() {
		try {
			await invoke("create_empty_file", { path: envPath });
			await queryClient.invalidateQueries({
				queryKey: ["env-exists", projPath],
			});
			toast.push({ kind: "success", title: "Created .env", body: envPath });
		} catch (err) {
			toast.error("Failed to create .env", String(err));
		}
	}

	async function runHubCmd(args: string[]): Promise<void> {
		const result = await invoke<{ success: boolean; output: string }>(
			"hub_cmd",
			{ args },
		);
		if (!result.success) throw new Error(result.output);
	}

	async function adoptCandidate(cand: ProjectSkillCandidate) {
		try {
			await runHubCmd([
				"project",
				"import-skill",
				cand.name,
				"--project",
				projectName!,
			]);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["registry"] }),
				queryClient.invalidateQueries({
					queryKey: ["project-candidates", projectName],
				}),
			]);
			toast.push({ kind: "success", title: "Adopted", body: cand.name });
		} catch (err) {
			toast.error("Failed to adopt", String(err));
			throw err;
		}
	}

	// enable/disable & bundle apply/remove are reversible edges — they get
	// undo-instead-of-confirm via `useUndoableAction` (D4). Destructive actions
	// (remove project) keep their ConfirmDialog.
	async function enableSkill(skillName: string) {
		if (equipStatus[skillName] === "pending") return;
		setEquipStatus((current) => ({ ...current, [skillName]: "pending" }));
		try {
			await runUndoable({
				do: () => runHubCmd(["enable", skillName, "--project", projectName!]),
				undo: () => runHubCmd(["disable", skillName, "--project", projectName!]),
				label: `Equipped ${skillName} on ${projectName}`,
				invalidate: [["registry"], ["syncReport"]],
			});
			setRecentlyEquipped((current) => ({
				...current,
				[skillName]: Date.now(),
			}));
			setEquipStatus((current) => ({ ...current, [skillName]: "success" }));
			window.setTimeout(() => {
				setEquipStatus((current) => {
					if (current[skillName] !== "success") return current;
					const { [skillName]: _removed, ...rest } = current;
					return rest;
				});
			}, 900);
		} catch (err) {
			setEquipStatus((current) => ({ ...current, [skillName]: "error" }));
			toast.error("Failed to equip", String(err));
		}
	}

	async function disableSkill(skillName: string) {
		try {
			await runUndoable({
				do: () => runHubCmd(["disable", skillName, "--project", projectName!]),
				undo: () => runHubCmd(["enable", skillName, "--project", projectName!]),
				label: `Unequipped ${skillName} from ${projectName}`,
				invalidate: [["registry"], ["syncReport"]],
			});
		} catch (err) {
			toast.error("Failed to unequip", String(err));
		}
	}

	async function applyBundle(bundleName: string) {
		try {
			await runUndoable({
				do: () =>
					runHubCmd(["bundle", "apply", bundleName, "--project", projectName!]),
				undo: () =>
					runHubCmd(["bundle", "remove", bundleName, "--project", projectName!]),
				label: `Applied ${bundleName} to ${projectName}`,
				invalidate: [["registry"], ["syncReport"]],
			});
		} catch (err) {
			toast.error("Failed to apply bundle", String(err));
		}
	}

	async function removeBundle(bundleName: string) {
		try {
			await runUndoable({
				do: () =>
					runHubCmd(["bundle", "remove", bundleName, "--project", projectName!]),
				undo: () =>
					runHubCmd(["bundle", "apply", bundleName, "--project", projectName!]),
				label: `Removed ${bundleName} from ${projectName}`,
				invalidate: [["registry"], ["syncReport"]],
			});
		} catch (err) {
			toast.error("Failed to remove bundle", String(err));
		}
	}

	// Per-project invocation override — reversible, so it gets an undo toast.
	// `inherit` clears the override; undo restores the previous state (which may
	// itself be "no override" → `inherit`).
	async function setInvocationOverride(
		skillName: string,
		choice: OverrideChoice,
		previous: "auto" | "user-only" | "model-only" | undefined,
	) {
		const prevMode = previous ?? "inherit";
		try {
			await runUndoable({
				do: () =>
					runHubCmd([
						"project",
						"invocation",
						projectName!,
						"--skill",
						skillName,
						"--mode",
						choice,
					]),
				undo: () =>
					runHubCmd([
						"project",
						"invocation",
						projectName!,
						"--skill",
						skillName,
						"--mode",
						prevMode,
					]),
				label:
					choice === "inherit"
						? `Cleared triggering override for ${skillName}`
						: `Set ${skillName} triggering to ${choice} on ${projectName}`,
				invalidate: [["registry"], ["syncReport"]],
			});
		} catch (err) {
			toast.error("Failed to set triggering override", String(err));
		}
	}

	async function runSync() {
		setSyncStatus("syncing");
		try {
			await trackProcess(
				{ title: "Registry sync", body: "writing .claude / .agents", kind: "local" },
				async () => {
					await runHubCmd(["sync"]);
					await queryClient.invalidateQueries({ queryKey: ["registry"] });
					await queryClient.invalidateQueries({ queryKey: ["syncReport"] });
				},
				{ successBody: "registry aligned", retry: () => void runSync() },
			);
			setSyncStatus("synced");
			setLastSyncedAt(new Date());
		} catch {
			setSyncStatus("error");
		}
	}

	function handleDrop(zone: "equipped" | "avail", skillName: string) {
		setDragOver(null);
		if (!skillName) return;
		const inDirect = proj.enabled.includes(skillName);
		if (zone === "equipped") {
			if (!inDirect) void enableSkill(skillName);
		} else if (zone === "avail") {
			if (inDirect) void disableSkill(skillName);
		}
	}

	// --- derived ----------------------------------------------------------

	const equipped = resolveActiveSkills(proj, registry);
	const orderedEquipped = useMemo(() => {
		const names = [...equipped];
		if (equipSort === "name") return names.sort((a, b) => a.localeCompare(b));
		return names.sort((a, b) => {
			const aRecent = recentlyEquipped[a] ?? 0;
			const bRecent = recentlyEquipped[b] ?? 0;
			if (aRecent !== bRecent) return bRecent - aRecent;
			const aDirectIndex = proj.enabled.indexOf(a);
			const bDirectIndex = proj.enabled.indexOf(b);
			const aDirect = aDirectIndex >= 0 ? 1 : 0;
			const bDirect = bDirectIndex >= 0 ? 1 : 0;
			if (aDirect !== bDirect) return bDirect - aDirect;
			if (aDirect && bDirect && aDirectIndex !== bDirectIndex) {
				return bDirectIndex - aDirectIndex;
			}
			return a.localeCompare(b);
		});
	}, [equipped, equipSort, proj.enabled, recentlyEquipped]);
	const equippedSet = new Set(equipped);

	// Shared, global-bundle-aware provenance selectors (design D1) — no local
	// re-derivation, so a global-bundle skill is never mislabelled as DIRECT.
	const bundleProvidedSet = bundleProvidedSkills(proj, registry);
	const directCount = directOnlySkills(proj, registry).length;
	const viaCount = equipped.length - directCount;

	// Globally-scoped bundles auto-apply to every project — surfaced as a
	// read-only cluster, never folded into the removable applied count.
	const globalBundles = Object.entries(registry.bundles).filter(
		([, b]) => getBundleScope(b) === "global",
	);

	const freshness = projectFreshness(projectName, syncEnvelope);

	// M8 per-project banner: the sync report's `affinity_skips` is the evidence
	// (what the last sync actually skipped for want of a matching harness). It is
	// the source of truth when present; the per-card badge is its predictive twin.
	const affinitySkips =
		projectRecord(projectName, syncEnvelope)?.affinity_skips ?? [];

	const mcpCount = equipped.filter(
		(s) => registry.skills[s]?.type === "mcp-server",
	).length;
	const skillCount = equipped.filter(
		(s) => registry.skills[s]?.type !== "mcp-server",
	).length;

	const availableBundles: BundleChipAddOption[] = Object.entries(
		registry.bundles,
	)
		.filter(([n, b]) => !proj.bundles.includes(n) && getBundleScope(b) !== "global")
		.map(([n, b]) => ({
			name: n,
			icon: b.icon,
			color: bundleColor(n),
			count: b.skills?.length ?? 0,
		}));

	const unequippedNames = Object.keys(registry.skills).filter(
		(name) => !equippedSet.has(name),
	);

	const filteredUnequipped = useMemo(() => {
		const q = availQuery.trim().toLowerCase();
		if (!q) return unequippedNames;
		return unequippedNames.filter((name) => {
			const s = registry.skills[name];
			return (
				name.toLowerCase().includes(q) ||
				(s?.description ?? "").toLowerCase().includes(q)
			);
		});
	}, [availQuery, unequippedNames, registry.skills]);

	function toggleAvailableDetails(skillName: string) {
		setExpandedAvailable((current) => {
			const next = new Set(current);
			if (next.has(skillName)) next.delete(skillName);
			else next.add(skillName);
			return next;
		});
	}

	const scopeGroups: { scope: SkillScope; label: string; names: string[] }[] = [
		{
			scope: "global",
			label: "GLOBAL",
			names: filteredUnequipped.filter(
				(n) => registry.skills[n]?.scope === "global",
			),
		},
		{
			scope: "portable",
			label: "PORTABLE",
			names: filteredUnequipped.filter(
				(n) => registry.skills[n]?.scope === "portable",
			),
		},
		{
			scope: "project-specific",
			label: "PROJECT",
			names: filteredUnequipped.filter(
				(n) => registry.skills[n]?.scope === "project-specific",
			),
		},
	];

	if (view === "agent-docs") {
		return (
			<>
				<AgentDocsView
					projectName={projectName}
					projectPath={proj.path}
					view={view}
					onChangeView={setView}
					projectHarnesses={[
						...(registry.harnesses_global ?? []),
						...(proj.harnesses ?? []),
					]}
					globalHarnesses={registry.harnesses_global ?? []}
					ownHarnesses={proj.harnesses ?? []}
				/>
				<EditProjectPathDialog
					open={showEditPath}
					onClose={() => setShowEditPath(false)}
					projectName={projectName}
					currentPath={proj.path}
				/>
				<RemoveProjectDialog
					open={showRemove}
					onClose={() => setShowRemove(false)}
					projectName={projectName}
					onRemoved={() => navigate("/")}
				/>
			</>
		);
	}

	if (view === "permissions") {
		return (
			<>
				<ProjectPermissionsTab
					projectName={projectName}
					projectPath={proj.path}
					view={view}
					onChangeView={setView}
				/>
				<EditProjectPathDialog
					open={showEditPath}
					onClose={() => setShowEditPath(false)}
					projectName={projectName}
					currentPath={proj.path}
				/>
				<RemoveProjectDialog
					open={showRemove}
					onClose={() => setShowRemove(false)}
					projectName={projectName}
					onRemoved={() => navigate("/")}
				/>
			</>
		);
	}

	if (view === "subagents") {
		// Effective harnesses for this project (global ∪ project). Codex is
		// user-scope only — its agents live at /harness/codex, not here — so the
		// hint is shown ONLY when codex is actually active, where it's relevant.
		const codexActive = new Set([
			...(registry.harnesses_global ?? []),
			...(proj.harnesses ?? []),
		]).has("codex");
		return (
			<>
				<SubagentManager
					initialScope="project"
					initialProject={projectName}
					lockScope
					listClassName="project-subagents-tab"
					listLead={
						codexActive ? (
							<div className="project-subagents-codex-hint" role="note">
								<Icon name="agent" size={13} />
								<span>
									Only <strong>Claude Code</strong> has project sub-agents —
									Codex agents are user-wide by design.
								</span>
								<Button
									variant="ghost"
									size="sm"
									icon="arrow-right"
									onClick={() => navigate("/harness/codex")}
								>
									Manage Codex agents
								</Button>
							</div>
						) : undefined
					}
					listHeader={
						<ScreenHeader
							leading={<span className="project-dot" />}
							title={projectName}
							meta={
								<Tag size="sm">
									{equipped.length}{" "}
									{equipped.length === 1 ? "skill" : "skills"}
								</Tag>
							}
							crumbs={["project", projectName, "sub-agents"]}
							subline="Project sub-agents — Claude Code personas in .claude/agents/"
							subheader={{
								left: (
									<SubheaderViewChips<ProjectView>
										views={PROJECT_VIEWS}
										value={view}
										onChange={setView}
									/>
								),
							}}
						/>
					}
				/>
				<EditProjectPathDialog
					open={showEditPath}
					onClose={() => setShowEditPath(false)}
					projectName={projectName}
					currentPath={proj.path}
				/>
				<RemoveProjectDialog
					open={showRemove}
					onClose={() => setShowRemove(false)}
					projectName={projectName}
					onRemoved={() => navigate("/")}
				/>
			</>
		);
	}

	return (
		<>
			<ScreenHeader
				leading={<span className="project-dot" />}
				title={projectName}
				meta={
					<Tag size="sm">
						{equipped.length} {equipped.length === 1 ? "skill" : "skills"}
					</Tag>
				}
				crumbs={[
					<span className="crumb-path" key="path">
						<Icon name="folder" size={11} />
						<span className="path has-tip">
							<span className="path-text">{shortenPath(proj.path)}</span>
							<span className="path-tip" role="tooltip">
								{proj.path}
							</span>
						</span>
					</span>,
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
										onClick={() => void createEnvFile()}
									>
										<Icon name="plus" size={10} />
										.env
									</button>,
								]
							: []),
				]}
				subline={`last sync ${relTime(projectRecord(projectName, syncEnvelope)?.ts)}`}
				primary={
					<Button variant="primary" icon="refresh" onClick={runSync}>
						Sync
					</Button>
				}
				overflow={[
					{
						icon: "edit",
						label: "Edit path",
						onClick: () => setShowEditPath(true),
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
						onClick: () => setShowRemove(true),
					},
				]}
				subheader={{
					left: (
						<SubheaderViewChips<ProjectView>
							views={PROJECT_VIEWS}
							value={view}
							onChange={setView}
						/>
					),
				}}
			/>

			{view === "loadout" ? (
				<ResizableSplit
					className="workspace-grid"
					fixedPane="right"
					storageKey="st:layout:project-workspace"
					defaultRightPx={320}
					minRightPx={280}
					maxRightPx={520}
					paneLabel="Available"
					handleAriaLabel="Resize available panel"
					left={
					<div className="workspace-main">
						<section className="ws-band ws-band-overview">
						<div className="hero-strip">
							<StatCard
								accent
								label="Equipped"
								value={
									<>
										{equipped.length}
										<span
											style={{
												color: "var(--fg-mute)",
												fontSize: 14,
												marginLeft: 6,
											}}
										>
											skills
										</span>
									</>
								}
								sub={`${directCount} direct · ${viaCount} via bundles`}
							/>
							<StatCard
								label="Skills"
								value={skillCount}
								sub={`${mcpCount} MCP servers`}
							/>
							<StatCard
								label="Bundles"
								value={proj.bundles.length}
								sub={
									globalBundles.length > 0
										? `applied · ${globalBundles.length} global auto-applied`
										: "applied to this project"
								}
							/>
							<StatCard
								className="stat-card-sync"
								label="Sync"
								value={
									<FreshnessBadge
										state={freshness}
										dotSize={9}
										label={SYNC_CARD_LABEL[freshness]}
										className="stat-sync-badge"
									/>
								}
								valueStyle={{ marginTop: 4 }}
								sub={
									<HarnessTargetsLine
										projectName={projectName ?? ""}
										globalHarnesses={registry?.harnesses_global ?? []}
										projectHarnesses={proj?.harnesses ?? []}
									/>
								}
							/>
						</div>

						{/* Active bundles */}
						<div className="loadout-section">
							<h3>
								<Icon name="bundle" size={14} />
								<span style={{ whiteSpace: "nowrap" }}>Active bundles</span>
								<span className="count">{proj.bundles.length}</span>
								<span className="stretch" />
								<span
									style={{
										color: "var(--fg-dim)",
										fontSize: 11,
										fontFamily: "var(--font-mono)",
									}}
								>
									applied first · skills add on top
								</span>
							</h3>
							<div>
								{proj.bundles.map((bn) => {
									const b = registry.bundles[bn];
									if (!b) return null;
									return (
										<BundleChip
											key={bn}
											name={bn}
											icon={b.icon}
											count={b.skills?.length ?? 0}
											color={bundleColor(bn)}
											onClick={() =>
												navigate(`/bundle/${encodeURIComponent(bn)}`)
											}
											onRemove={() => removeBundle(bn)}
										/>
									);
								})}
								<BundleChipAdd
									available={availableBundles}
									onPick={(name) => applyBundle(name)}
								/>
							</div>
							{globalBundles.length > 0 && (
								<div className="global-bundle-cluster">
									<span className="global-bundle-label">
										<Icon name="globe" size={11} />
										Global · auto-applied
									</span>
									<div className="global-bundle-chips">
										{globalBundles.map(([bn, b]) => (
											<BundleChip
												key={bn}
												name={bn}
												icon={b.icon}
												count={b.skills?.length ?? 0}
												color={bundleColor(bn)}
												onClick={() =>
													navigate(`/bundle/${encodeURIComponent(bn)}`)
												}
											/>
										))}
									</div>
								</div>
							)}
						</div>
						</section>
						<section className="ws-band ws-band-loadout">

						{/* M8: equipped skills that won't reach any agent (from the
						    last sync report's affinity_skips). Links to harness config. */}
						{affinitySkips.length > 0 && (
							<div className="affinity-skip-banner" role="status">
								<Icon name="warning" size={14} />
								<span>
									<strong>
										{affinitySkips.length} equipped skill
										{affinitySkips.length === 1 ? "" : "s"}
									</strong>{" "}
									won't reach any agent — no installed harness matches their{" "}
									<span className="text-mono">harnesses:</span> affinity.
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

						{/* Detected, not-yet-adopted local skills */}
						{localCandidates && localCandidates.length > 0 && (
							<ProjectLocalSkills
								candidates={localCandidates}
								onAdopt={adoptCandidate}
							/>
						)}

						{/* Equipped skills */}
						<div className="loadout-section">
							<h3>
								<Icon name="plug" size={14} />
								<span style={{ whiteSpace: "nowrap" }}>Equipped skills</span>
								<span className="count">{equipped.length}</span>
								<span className="stretch" />
								<label className="loadout-sort">
									<span>sort</span>
									<select
										value={equipSort}
										onChange={(e) => setEquipSort(e.target.value as EquipSort)}
										aria-label="Sort equipped skills"
									>
										<option value="newest">Newest</option>
										<option value="name">Name</option>
									</select>
								</label>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: 12,
										fontFamily: "var(--font-mono)",
										fontSize: 10.5,
										color: "var(--fg-mute)",
									}}
								>
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											gap: 4,
										}}
									>
										<span
											style={{
												width: 8,
												height: 8,
												borderRadius: 2,
												background:
													"color-mix(in oklab, var(--amber) 50%, transparent)",
											}}
										/>{" "}
										direct
									</span>
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											gap: 4,
										}}
									>
										<span
											style={{
												width: 8,
												height: 8,
												borderRadius: 2,
												background: "var(--fg-dim)",
											}}
										/>{" "}
										from bundle
									</span>
								</span>
							</h3>
							<div
								className={`skill-grid ${dragOver === "equipped" ? "dropzone-active" : ""}`}
								onDragOver={(e) => {
									e.preventDefault();
									setDragOver("equipped");
								}}
								onDragLeave={() => setDragOver(null)}
								onDrop={(e) =>
									handleDrop("equipped", e.dataTransfer.getData("text/skill"))
								}
								style={{ minHeight: 80 }}
							>
								{equipped.length === 0 && (
									<div
										style={{
											gridColumn: "1 / -1",
											textAlign: "center",
											padding: "28px 0",
											color: "var(--fg-mute)",
											fontSize: 12,
											border: "1px dashed var(--border)",
											borderRadius: 6,
										}}
									>
										No skills equipped. Drag a skill here, or apply a bundle.
									</div>
								)}
								{orderedEquipped.map((name) => {
									const skill = registry.skills[name];
									if (!skill) return null;
									const inDirect = proj.enabled.includes(name);
									const viaBundle = bundleProvidedSet.has(name) && !inDirect;
									// Providing bundles = applied OR globally-scoped bundles
									// that contain this skill (design D1 — includes globals).
									const viaNames = Object.entries(registry.bundles)
										.filter(
											([bn, b]) =>
												(getBundleScope(b) === "global" ||
													proj.bundles.includes(bn)) &&
												(b.skills ?? []).includes(name),
										)
										.map(([bn]) => bn);
									// M8: an equipped skill whose harness affinity excludes
									// every effective harness of this project won't sync here.
									const wontSync = affinityMismatch(
										skill,
										proj,
										registry,
										installedHarnessIds,
									);
									return (
										<SkillCard
											key={name}
											className={
												recentlyEquipped[name]
													? "skill-card-newly-equipped"
													: undefined
											}
											leadingBadge={
												wontSync ? (
													<StatusBadge
														channel="warn"
														shape="pill"
														icon="warning"
														className="skill-affinity-badge"
														title={`This skill declares harnesses: [${(skill.harnesses ?? []).join(", ")}], none of which are active on this project — it won't sync here. Enable a matching harness.`}
													>
														won't sync here
													</StatusBadge>
												) : undefined
											}
											name={name}
											kind={skill.type}
											scope={skill.scope}
											description={skill.description}
											version={skill.version}
											invocationControl={
												skill.type === "mcp-server" ? undefined : (
													<SkillInvocationOverride
														libraryInvocation={skill.invocation}
														override={proj.invocation_overrides?.[name]}
														scope={skill.scope}
														onPick={(choice, prev) =>
															void setInvocationOverride(name, choice, prev)
														}
													/>
												)
											}
											draggable
											onDragStart={(e) =>
												e.dataTransfer.setData("text/skill", name)
											}
											onClick={() =>
												navigate(`/skill/${encodeURIComponent(name)}`)
											}
											equipped={inDirect && !viaBundle}
											via={viaBundle ? "bundle" : null}
											onUnequipped={
												inDirect && !viaBundle
													? () => disableSkill(name)
													: undefined
											}
											source={
												viaBundle ? (
													<span style={{ color: "var(--fg-mute)" }}>
														via{" "}
														{viaNames.map((bn, i) => (
															<Fragment key={bn}>
																{i > 0 && ", "}
																<button
																	type="button"
																	className="via-bundle-link"
																	onClick={(e) => {
																		e.stopPropagation();
																		navigate(
																			`/bundle/${encodeURIComponent(bn)}`,
																		);
																	}}
																>
																	{bn}
																</button>
															</Fragment>
														))}
													</span>
												) : (
													<span style={{ color: "var(--amber)" }}>◆ DIRECT</span>
												)
											}
										/>
									);
								})}
							</div>
						</div>
						</section>
					</div>
					}
					right={
					/* Side panel: Available */
					<div className="workspace-side">
						<div style={{ marginBottom: 18 }}>
							<div
								style={{
									display: "flex",
									alignItems: "baseline",
									justifyContent: "space-between",
									marginBottom: 10,
								}}
							>
								<div
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 10.5,
										letterSpacing: ".12em",
										color: "var(--fg-dim)",
										textTransform: "uppercase",
									}}
								>
									Available
								</div>
								<span className="text-dim text-mono" style={{ fontSize: 10.5 }}>
									{filteredUnequipped.length}
								</span>
							</div>
							<div style={{ marginBottom: 10 }}>
								<SearchInput
									value={availQuery}
									onChange={setAvailQuery}
									placeholder="Filter library…"
								/>
							</div>
							<div
								className={dragOver === "avail" ? "dropzone-active" : ""}
								onDragOver={(e) => {
									e.preventDefault();
									setDragOver("avail");
								}}
								onDragLeave={() => setDragOver(null)}
								onDrop={(e) =>
									handleDrop("avail", e.dataTransfer.getData("text/skill"))
								}
								style={{ borderRadius: 6, padding: "4px 0" }}
							>
								{scopeGroups.map((group) => {
									if (group.names.length === 0) return null;
									return (
										<div key={group.scope} style={{ marginBottom: 12 }}>
											<div
												style={{
													fontFamily: "var(--font-mono)",
													fontSize: 9.5,
													letterSpacing: ".14em",
													color: "var(--fg-dim)",
													textTransform: "uppercase",
													padding: "6px 8px",
												}}
											>
												{group.label} · {group.names.length}
											</div>
											{group.names.map((name) => {
												const s = registry.skills[name];
												if (!s) return null;
												const status = equipStatus[name];
												const isPending = status === "pending";
												const isExpanded = expandedAvailable.has(name);
												const bundleNames = Object.entries(registry.bundles)
													.filter(([, bundle]) => bundle.skills?.includes(name))
													.map(([bundleName]) => bundleName);
												const harnesses = s.harnesses ?? [];
												return (
													<div
														key={name}
														className="avail-skill-wrap"
														data-status={status ?? "idle"}
														data-expanded={isExpanded}
													>
														<button
															type="button"
															className="avail-skill"
															draggable={!isPending}
															aria-label={`Equip ${name}`}
															aria-busy={isPending}
															disabled={isPending}
															onDragStart={(e) =>
																e.dataTransfer.setData("text/skill", name)
															}
															onClick={() => enableSkill(name)}
															title={`Equip ${name}`}
														>
															<ScopeBadge scope={s.scope} />
															<span className="name">{name}</span>
															{s.type === "mcp-server" && (
																<Tag color="var(--amber)" size="sm">
																	MCP
																</Tag>
															)}
															<span className="equip-copy">
																{status === "success"
																	? "Equipped"
																	: status === "error"
																		? "Retry"
																		: isPending
																			? "Equipping…"
																			: "Equip"}
															</span>
															<Icon
																name={status === "success" ? "check" : "plus"}
																size={12}
																className="equip"
															/>
														</button>
														<button
															type="button"
															className="avail-skill-expand"
															aria-expanded={isExpanded}
															aria-label={`${isExpanded ? "Hide" : "Show"} ${name} summary`}
															onClick={(e) => {
																e.stopPropagation();
																toggleAvailableDetails(name);
															}}
														>
															<Icon name="chevronDown" size={12} />
														</button>
														{isExpanded && (
															<div className="avail-skill-details">
																<p>{s.description || "No description yet."}</p>
																<div className="avail-skill-meta">
																	<span>
																		{s.type === "mcp-server" ? "MCP" : "SKILL"}
																	</span>
																	<span>{s.scope}</span>
																	{s.version && <span>v{s.version}</span>}
																	{harnesses.length > 0 && (
																		<span className="avail-skill-harnesses">
																			<HarnessIconGroup
																				ids={harnesses}
																				size={14}
																				maxVisible={3}
																			/>
																		</span>
																	)}
																</div>
																{bundleNames.length > 0 && (
																	<div className="avail-skill-bundles">
																		via {bundleNames.slice(0, 2).join(", ")}
																		{bundleNames.length > 2
																			? ` +${bundleNames.length - 2}`
																			: ""}
																	</div>
																)}
															</div>
														)}
													</div>
												);
											})}
										</div>
									);
								})}
								{filteredUnequipped.length === 0 && (
									<div
										style={{
											padding: "16px 8px",
											color: "var(--fg-mute)",
											fontSize: 11.5,
											fontFamily: "var(--font-mono)",
										}}
									>
										{availQuery
											? "No skills match the filter."
											: "Every skill is equipped."}
									</div>
								)}
							</div>
						</div>
					</div>
				}
				/>
			) : (
				<TreeView
					project={proj}
					projectName={projectName}
					registry={registry}
					onApplyBundle={applyBundle}
					onRemoveBundle={removeBundle}
					onEnableSkill={enableSkill}
					onDisableSkill={disableSkill}
				/>
			)}

			<EditProjectPathDialog
				open={showEditPath}
				onClose={() => setShowEditPath(false)}
				projectName={projectName}
				currentPath={proj.path}
			/>
			<RemoveProjectDialog
				open={showRemove}
				onClose={() => setShowRemove(false)}
				projectName={projectName}
				onRemoved={() => navigate("/")}
			/>
		</>
	);
}
