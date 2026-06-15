import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { shortenPath } from "@/lib/shortenPath";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag, ScopeBadge } from "@/components/Tag";
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
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { RemoveProjectDialog } from "@/components/RemoveProjectDialog";
import { HarnessTargetsLine } from "@/components/harness/HarnessTargetsLine";
import { HarnessIconGroup } from "@/components/harness/HarnessGlyph";
import { AgentDocsView } from "@/components/AgentDocsView";
import { ProjectPermissionsTab } from "@/components/ProjectPermissionsTab";
import type { SkillScope } from "@/types";

type View = ProjectView;
type DropZone = "equipped" | "avail" | null;
type EquipSort = "newest" | "name";
type EquipStatus = "pending" | "success" | "error";

export function ProjectWorkspace() {
	const { name: projectName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const { data: registry, isLoading } = useRegistry();
	const toast = useToast();
	const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);
	const setSyncStatus = useAppStore((s) => s.setSyncStatus);
	const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);

	const [view, setView] = useState<View>("loadout");
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

	const projPath = projectName
		? registry?.projects?.[projectName]?.path
		: undefined;
	const envPath = projPath ? `${projPath}/.env` : "";
	const { data: envExists } = useQuery({
		queryKey: ["env-exists", projPath],
		queryFn: () => invoke<boolean>("path_exists", { path: envPath }),
		enabled: !!projPath,
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

	async function enableSkill(skillName: string) {
		if (equipStatus[skillName] === "pending") return;
		setEquipStatus((current) => ({ ...current, [skillName]: "pending" }));
		try {
			await runHubCmd(["enable", skillName, "--project", projectName!]);
			setRecentlyEquipped((current) => ({
				...current,
				[skillName]: Date.now(),
			}));
			setEquipStatus((current) => ({ ...current, [skillName]: "success" }));
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			window.setTimeout(() => {
				setEquipStatus((current) => {
					if (current[skillName] !== "success") return current;
					const { [skillName]: _removed, ...rest } = current;
					return rest;
				});
			}, 900);
			toast.push({
				kind: "success",
				title: "Equipped",
				body: skillName,
			});
		} catch (err) {
			setEquipStatus((current) => ({ ...current, [skillName]: "error" }));
			toast.error("Failed to equip", String(err));
		}
	}

	async function disableSkill(skillName: string) {
		try {
			await runHubCmd(["disable", skillName, "--project", projectName!]);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.push({
				kind: "info",
				title: "Unequipped",
				body: skillName,
			});
		} catch (err) {
			toast.error("Failed to unequip", String(err));
		}
	}

	async function applyBundle(bundleName: string) {
		try {
			await trackProcess(
				{
					title: `Applying bundle · ${bundleName}`,
					body: "equipping skills…",
					kind: "batch",
					target: `bundle:${bundleName}:${projectName}`,
				},
				async () => {
					await runHubCmd([
						"bundle",
						"apply",
						bundleName,
						"--project",
						projectName!,
					]);
					await queryClient.invalidateQueries({ queryKey: ["registry"] });
				},
				{
					successBody: "written to .claude / .agents",
					retry: () => void applyBundle(bundleName),
				},
			);
		} catch {
			/* error surfaced on the process card */
		}
	}

	async function removeBundle(bundleName: string) {
		try {
			await runHubCmd([
				"bundle",
				"remove",
				bundleName,
				"--project",
				projectName!,
			]);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.push({
				kind: "info",
				title: "Bundle removed",
				body: bundleName,
			});
		} catch (err) {
			toast.error("Failed to remove bundle", String(err));
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

	const bundleProvidedSet = new Set(
		proj.bundles.flatMap((bn) => registry.bundles[bn]?.skills ?? []),
	);

	const directOnly = proj.enabled.filter(
		(name) => !bundleProvidedSet.has(name),
	).length;

	const mcpCount = equipped.filter(
		(s) => registry.skills[s]?.type === "mcp-server",
	).length;
	const skillCount = equipped.filter(
		(s) => registry.skills[s]?.type !== "mcp-server",
	).length;

	const availableBundles: BundleChipAddOption[] = Object.entries(
		registry.bundles,
	)
		.filter(([n]) => !proj.bundles.includes(n))
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
				subline="last sync —"
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
				<div className="workspace-grid">
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
								sub={`${directOnly} direct · ${proj.bundles.length} via bundles`}
							/>
							<StatCard
								label="Skills"
								value={skillCount}
								sub={`${mcpCount} MCP servers`}
							/>
							<StatCard
								label="Bundles"
								value={proj.bundles.length}
								sub="applied to this project"
							/>
							<StatCard
								className="stat-card-sync"
								label="Sync"
								value="● up to date"
								valueStyle={{
									color: "var(--green)",
									fontSize: 16,
									fontFamily: "var(--font-mono)",
									marginTop: 4,
								}}
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
						</div>
						</section>
						<section className="ws-band ws-band-loadout">

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
									const viaNames = proj.bundles.filter((bn) =>
										registry.bundles[bn]?.skills?.includes(name),
									);
									return (
										<SkillCard
											key={name}
											className={
												recentlyEquipped[name]
													? "skill-card-newly-equipped"
													: undefined
											}
											name={name}
											kind={skill.type}
											scope={skill.scope}
											description={skill.description}
											version={skill.version}
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
														via {viaNames.join(", ")}
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

					{/* Side panel: Available */}
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
				</div>
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
