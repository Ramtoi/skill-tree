import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { fromNav } from "@/lib/backTarget";
import { shortenPath } from "@/lib/shortenPath";

import { ScreenHeader } from "@/components/ScreenHeader";
import { LoadingButton } from "@/components/loading";
import { trackProcess } from "@/lib/trackProcess";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { Icon } from "@/components/Icon";
import { InfoBanner } from "@/components/InfoBanner";
import { StatusBadge } from "@/components/StatusBadge";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import {
	HARNESS_IDENTITY,
	harnessFile,
	harnessTint,
	type RootFile,
} from "@/components/harness/harnessRegistry";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useRegistry } from "@/hooks/useRegistry";
import { useSubagentList } from "@/hooks/useSubagents";
import { useProjectActivity } from "@/hooks/useProjectActivity";
import {
	useGlobalDocStatus,
	docStatusFor,
	type GlobalDocStatusRow,
} from "@/hooks/useGlobalDocStatus";
import type { SubagentHarness } from "@/lib/subagents";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { invalidateRegistry } from "@/lib/invalidate";
import { orderProjects } from "@/lib/projectActivity";
import { relativeTimestamp } from "@/lib/backupContract";
import type { HarnessStatus } from "@/store";

/** How many USED BY chips a card shows before collapsing the rest behind a
 *  "+N more" button — a globally-on harness's `effective` set is every
 *  registered project, and a card must not spam a dozen-plus chips. */
const USED_BY_VISIBLE = 6;

/** Process-card target id for a harness rescan. */
export const HARNESS_SCAN_TARGET = "harness:scan";

export function Harnesses() {
	const harnesses = useHarnesses();
	const { data: registry } = useRegistry();
	const navigate = useNavigate();
	const toast = useToast();
	const rescan = useAppStore((s) => s.rescanHarnesses);
	const setMutating = useAppStore((s) => s.setMutating);
	const mutating = useAppStore((s) => s.mutating);
	const [scanning, setScanning] = useState(false);
	const activity = useProjectActivity();
	const { data: docStatusRows } = useGlobalDocStatus();
	const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>(
		{},
	);

	const total = harnesses.length;
	const installedCount = harnesses.filter((h) => h.installed).length;

	// A harness counts as "active" only when it is both enabled globally AND
	// installed. If some harness is enabled globally but none of the enabled ones
	// are installed, every sync is a silent no-op — surface that honestly.
	const globalHarnesses = harnesses.filter((h) => h.on_globally);
	const noActiveHarness =
		globalHarnesses.length > 0 && globalHarnesses.every((h) => !h.installed);

	// Projects requiring a given root file = any project whose effective
	// harnesses (global ∪ project) include an agent that reads that file.
	const projectsByFile = useMemo(() => {
		const out: Record<RootFile, string[]> = {
			"CLAUDE.md": [],
			"AGENTS.md": [],
		};
		if (!registry) return out;
		const globals = registry.harnesses_global ?? [];
		for (const [name, proj] of Object.entries(registry.projects)) {
			const ids = new Set([...globals, ...(proj.harnesses ?? [])]);
			const files = new Set<RootFile>();
			for (const id of ids) files.add(harnessFile(id));
			for (const f of files) out[f].push(name);
		}
		return out;
	}, [registry]);

	// Group known harnesses by the root file they read (for the bottom overview).
	const fileGroups = useMemo(() => {
		const groups: Record<RootFile, string[]> = {
			"CLAUDE.md": [],
			"AGENTS.md": [],
		};
		for (const id of Object.keys(HARNESS_IDENTITY)) {
			groups[harnessFile(id)].push(id);
		}
		return (Object.keys(groups) as RootFile[])
			.filter((f) => groups[f].length > 0)
			.sort()
			.map((f) => ({ file: f, harnessIds: groups[f] }));
	}, []);

	async function doRescan() {
		setScanning(true);
		try {
			// Probing four harnesses' install roots is real disk work, so it gets
			// the same process card as every other live action.
			await trackProcess(
				{
					title: "Scanning harnesses",
					body: "probing install roots",
					kind: "fs",
					target: HARNESS_SCAN_TARGET,
				},
				async () => {
					await rescan();
					await invalidateRegistry(queryClient);
					const list = useAppStore.getState().harnesses;
					return list;
				},
				{
					successBody: (list) => {
						const inst = list.filter((h) => h.installed).length;
						return `${inst} installed · ${list.length - inst} missing`;
					},
					retry: () => void doRescan(),
				},
			);
		} catch {
			/* The card carries the failure; nothing further to say here. */
		} finally {
			setScanning(false);
		}
	}

	async function toggleGlobal(h: HarnessStatus, enabled: boolean) {
		setMutating(true);
		try {
			await invoke("harness_set_global", { id: h.id, enabled });
			await rescan();
			await invalidateRegistry(queryClient);
			toast.push({
				kind: "info",
				title: `Global ${h.label}`,
				body: enabled
					? "Every capable project picks this up."
					: "No longer applied to every project.",
			});
		} catch (err) {
			toast.error("Couldn't update harness", String(err));
		} finally {
			setMutating(false);
		}
	}

	async function openConfigDir(h: HarnessStatus) {
		try {
			await invoke("harness_open_dir", { harnessId: h.id });
		} catch (err) {
			toast.error("Couldn't open folder", String(err));
		}
	}

	const labelOf = useMemo(
		() => new Map(harnesses.map((h) => [h.id, h.label])),
		[harnesses],
	);

	// Effective harnesses for a project = harnesses_global ∪ project.harnesses
	// (CLAUDE.md §Data Model) — every registered project, sorted, is who a
	// globally-on harness actually reaches.
	const allProjectNames = useMemo(
		() => Object.keys(registry?.projects ?? {}).sort(),
		[registry],
	);

	return (
		<>
			<ScreenHeader
				icon="harness"
				title="Harnesses"
				meta={
					<Tag size="sm">
						{installedCount}/{total} installed
					</Tag>
				}
				subline="Coding agents this machine can talk to · skills sync to the root file each one reads"
				primary={
					<LoadingButton
						variant="primary"
						icon="refresh"
						loading={scanning}
						loadingLabel="Rescanning…"
						onClick={() => void doRescan()}
					>
						Rescan
					</LoadingButton>
				}
			/>

			<div className="harnesses-screen">
				{noActiveHarness && (
					<InfoBanner className="harnesses-no-active-banner">
						<strong>No active harness</strong> — synced skills won't reach any
						harness yet. Enable one of the installed harnesses below.
					</InfoBanner>
				)}
				<div className="harnesses-grid">
					{harnesses.map((h) => {
						const installed = h.installed;
						// `?? []` because a payload or fixture predating the field
						// (the store type marks it required and the Rust command
						// always sends it) must degrade to "nobody pins it" rather
						// than take the whole screen down on `undefined.length`.
						const pinned = h.used_by_projects ?? [];
						const pinnedSet = new Set(pinned);
						// A harness on the global switch reaches every registered
						// project, not just the ones that also pin it explicitly.
						const effective = h.on_globally
							? allProjectNames
							: [...pinned].sort();
						const { ordered, knownCount } = orderProjects(
							effective,
							activity,
							h.id,
						);
						const isExpanded = expandedUsers[h.id] ?? false;
						const visible =
							isExpanded || ordered.length <= USED_BY_VISIBLE
								? ordered
								: ordered.slice(0, USED_BY_VISIBLE);
						const overflowCount = ordered.length - USED_BY_VISIBLE;
						const usersListId = `harness-users-list-${h.id}`;
						return (
							<div
								key={h.id}
								className="stat-card harness-card"
								data-installed={installed || undefined}
								data-on-globally={h.on_globally || undefined}
							>
								<div className="harness-card-head">
									<HarnessGlyph id={h.id} label={h.label} size={32} decorative />
									<div className="harness-card-id">
										<div className="harness-card-name">{h.label}</div>
										<div className="harness-card-file">
											reads{" "}
											<span className="text-mono">{harnessFile(h.id)}</span>
										</div>
									</div>
									<div className="harness-card-state">
										<StatusBadge
											channel={installed ? "ok" : "neutral"}
											shape="pill"
											icon={installed ? "check" : "x"}
											title={installed ? "installed" : "not installed"}
											ariaLabel={installed ? "installed" : "not installed"}
										>
											{installed ? "installed" : "not installed"}
										</StatusBadge>
									</div>
								</div>

								<div className="harness-card-meta">
									{installed ? (
										<>
											{h.version && (
												<div className="harness-meta-row">
													<span>version</span>
													<span className="text-mono">v{h.version}</span>
												</div>
											)}
											{h.config_dir && (
												<div className="harness-meta-row">
													<span>config</span>
													<button
														type="button"
														className="harness-meta-open"
														title="Open in Finder"
														aria-label={`Open ${h.label} config folder in Finder`}
														onClick={() => void openConfigDir(h)}
													>
														<span className="text-mono">
															{shortenPath(h.config_dir)}
														</span>
														<Icon name="folder" size={12} />
													</button>
												</div>
											)}
											{h.path && h.path !== h.config_dir && (
												<div className="harness-meta-row">
													<span>binary</span>
													<span className="text-mono">{h.path}</span>
												</div>
											)}
											{!h.version && !h.config_dir && !h.path && (
												<div className="harness-meta-row">
													<span>status</span>
													<span className="text-mono">detected</span>
												</div>
											)}
										</>
									) : (
										<div className="harness-card-cta">
											<Icon name="warning" size={11} />
											<span>
												Install <strong>{h.label}</strong> on this machine to
												use it from Skill Tree.
											</span>
										</div>
									)}
								</div>

								<Toggle
									className="harness-card-toggle"
									variant="switch"
									checked={h.on_globally}
									disabled={(!installed && !h.on_globally) || mutating}
									ariaLabel={`Enable ${h.label} globally`}
									onChange={(checked) => void toggleGlobal(h, checked)}
									label={
										<span className="harness-toggle-copy">
											<span className="toggle-title">Enable globally</span>
											<span className="toggle-sub">
												Every project syncs its skills to {h.label}.
											</span>
										</span>
									}
								/>

								<div className="harness-card-users">
									<div className="harness-users-head">
										<span>Used by</span>
										<span className="text-mono text-dim">
											{effective.length}
										</span>
									</div>
									{effective.length === 0 ? (
										<div className="harness-users-empty">
											{/* With zero registered projects NO harness reaches
											    anything, and telling someone to flip a global
											    switch that is already on is the same class of lie
											    this card was fixed for. */}
											{allProjectNames.length === 0
												? "No projects registered yet."
												: installed
													? `No project uses ${h.label}. Turn on the global switch, or add it per project.`
													: `No projects use ${h.label} yet.`}
										</div>
									) : (
										<>
											{(() => {
												const hintParts: string[] = [];
												if (h.on_globally) {
													hintParts.push(
														"every project · via the global switch",
													);
													if (pinned.length > 0) {
														hintParts.push(`${pinned.length} pinned`);
													}
												}
												if (knownCount > 0) {
													hintParts.push("most recent first");
												}
												return (
													hintParts.length > 0 && (
														<div className="harness-users-hint text-mono">
															{hintParts.join(" · ")}
														</div>
													)
												);
											})()}
											<div className="harness-users-list" id={usersListId}>
												{visible.map((p) => {
													const isPinned = pinnedSet.has(p);
													const lastSession =
														activity[p]?.byHarness?.[h.id] ??
														activity[p]?.last;
													const baseTitle = isPinned
														? `${p} · pinned in this project's harnesses`
														: `${p} · via the global switch`;
													const title = lastSession
														? `${baseTitle} · last session ${relativeTimestamp(lastSession)}`
														: baseTitle;
													return (
														<button
															key={p}
															type="button"
															className="harness-user-chip"
															data-pinned={isPinned || undefined}
															title={title}
															onClick={() =>
																navigate(
																	`/project/${encodeURIComponent(p)}`,
																	fromNav({
																		label: "Harnesses",
																		path: "/harnesses",
																	}),
																)
															}
														>
															<span className="project-dot" />
															<span>{p}</span>
														</button>
													);
												})}
												{ordered.length > USED_BY_VISIBLE && (
													<button
														type="button"
														className="harness-user-chip harness-users-more"
														aria-expanded={isExpanded}
														aria-controls={usersListId}
														onClick={() =>
															setExpandedUsers((prev) => ({
																...prev,
																[h.id]: !isExpanded,
															}))
														}
													>
														{isExpanded
															? "Show less"
															: `+${overflowCount} more`}
													</button>
												)}
											</div>
										</>
									)}
								</div>

								<div className="harness-card-links">
									{(h.agents?.supported ?? h.id === "claude-code") && (
										<SubagentsLink
											harness={h}
											installed={installed}
											enabled={h.on_globally || pinned.length > 0}
											onOpen={() => navigate(`/harness/${h.id}`)}
										/>
									)}

									{h.global_doc && (
										<InstructionsLink
											harness={h}
											docRow={docStatusFor(docStatusRows, h.id)}
											onOpen={() => navigate(`/harness/${h.id}/doc`)}
										/>
									)}
								</div>
							</div>
						);
					})}
				</div>

				<div className="harnesses-files">
					<div className="harnesses-section-eyebrow">
						<Icon name="doc" size={12} />
						<span>Project root files</span>
					</div>
					<div className="harnesses-files-grid tile-row">
						{fileGroups.map(({ file, harnessIds }) => {
							const projectsWithFile = projectsByFile[file] ?? [];
							return (
								<div className="stat-card harness-file-card" key={file}>
									<div className="label">
										<Icon name="doc" size={12} />
										<span className="text-mono">{file}</span>
									</div>
									<div className="value">
										{projectsWithFile.length}
										<span className="unit">
											{projectsWithFile.length === 1 ? "project" : "projects"}
										</span>
									</div>
									<div className="harness-file-card-readers">
										{harnessIds.map((id) => (
											<span
												key={id}
												className="harness-inline-pill harness-inline-pill-icon-only"
												style={{
													["--harness-accent" as string]: harnessTint(id),
												}}
												title={labelOf.get(id) ?? id}
												aria-label={labelOf.get(id) ?? id}
											>
												<HarnessGlyph
													id={id}
													label={labelOf.get(id) ?? id}
													size={16}
													decorative
												/>
											</span>
										))}
									</div>
								</div>
							);
						})}
					</div>
					<div className="harnesses-files-explainer">
						<Icon name="link" size={12} />
						<span>
							When a project enables agents that read different files, Skill
							Tree keeps <strong>AGENTS.md as the one real root</strong> and
							derives CLAUDE.md from it — a symlink, or a file that imports{" "}
							<span className="text-mono">@AGENTS.md</span>. Edit AGENTS.md;
							CLAUDE.md follows. Set the strategy in Agent Docs.
						</span>
					</div>
				</div>
			</div>
		</>
	);
}

/**
 * "Sub-agents" jump row on an agent-capable harness card (per its `agents`
 * capability from `harness_list`). Rendered as one full-width button that IS
 * the destination — the label names where it goes, the hint carries the
 * live count. Shown only when the harness is installed; when installed but
 * not yet enabled (globally or by any project) it renders disabled with the
 * reason instead of disappearing. Hidden entirely when not installed — the
 * meta compartment above already carries the install line.
 */
function SubagentsLink({
	harness,
	installed,
	enabled,
	onOpen,
}: {
	harness: HarnessStatus;
	installed: boolean;
	enabled: boolean;
	onOpen: () => void;
}) {
	// Only fetch the count when the affordance will actually render.
	const ready = installed && enabled;
	const harnessId = (
		harness.id === "codex" ? "codex" : "claude-code"
	) as SubagentHarness;
	const { data } = useSubagentList("user", null, ready, harnessId);
	const count = data?.agents.length;

	if (!installed) return null;

	if (!enabled) {
		return (
			<div className="harness-card-configure">
				<button
					type="button"
					className="harness-card-link"
					disabled
					data-reason="not-enabled"
					title={`Enable ${harness.label} first`}
					aria-label={`Sub-agents — enable ${harness.label} first`}
				>
					<Icon name="cog" size={13} />
					<span className="harness-card-link-label">Sub-agents</span>
					<span className="harness-card-link-hint">
						enable {harness.label} first
					</span>
					<span className="stretch" />
					<span className="harness-card-link-arrow">
						<Icon name="arrow-right" size={12} />
					</span>
				</button>
			</div>
		);
	}
	return (
		<div className="harness-card-configure">
			<button type="button" className="harness-card-link" onClick={onOpen}>
				<Icon name="cog" size={13} />
				<span className="harness-card-link-label">Sub-agents</span>
				<span className="harness-card-link-hint">
					{count === undefined
						? "agents"
						: `${count} agent${count === 1 ? "" : "s"}`}
				</span>
				<span className="stretch" />
				<span className="harness-card-link-arrow">
					<Icon name="arrow-right" size={12} />
				</span>
			</button>
		</div>
	);
}

/**
 * "Global instructions" jump row: edit the harness's USER-GLOBAL instruction
 * doc (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …). Shown for every
 * harness that declares a global doc — even uninstalled ones, since the
 * file is just a dotfile.
 *
 * The hint is state-aware once `docRow` (from `hub harness doc status`) has
 * loaded — a doc can follow another harness's, or be the source others
 * follow, or dangle on a broken link. Before it loads, or for a plain
 * `standalone`/`external` file, the hint falls back to the bare filename
 * (plus "not created" for a truly missing one).
 */
function InstructionsLink({
	harness,
	docRow,
	onOpen,
}: {
	harness: HarnessStatus;
	docRow: GlobalDocStatusRow | undefined;
	onOpen: () => void;
}) {
	const path = harness.global_doc ?? "";
	const fileName = path.split(/[/\\]/).pop() || path;
	const exists = harness.global_doc_exists ?? false;

	let hint = fileName;
	let broken = false;
	switch (docRow?.state) {
		case "follows":
			hint = `${fileName} · follows ${harnessLabel(docRow.follows ?? "")}`;
			break;
		case "source":
			// One follower is NAMED — "shared with 1" makes the reader open the
			// card to learn the one fact the line was for. Two or more count.
			hint =
				docRow.followers.length === 1
					? `${fileName} · shared with ${harnessLabel(docRow.followers[0])}`
					: `${fileName} · shared with ${docRow.followers.length} harnesses`;
			break;
		case "broken":
			hint = `${fileName} · broken link`;
			broken = true;
			break;
		case "missing":
			hint = `${fileName} · not created`;
			break;
		default:
			hint = !exists ? `${fileName} · not created` : fileName;
	}

	return (
		<div className="harness-card-configure harness-card-instructions">
			<button type="button" className="harness-card-link" onClick={onOpen}>
				<Icon name="doc" size={13} />
				<span className="harness-card-link-label">Global instructions</span>
				<span className="harness-card-link-hint">
					{broken && (
						<StatusBadge channel="warn" shape="dot" ariaLabel="broken link" />
					)}
					{hint}
				</span>
				<span className="stretch" />
				<span className="harness-card-link-arrow">
					<Icon name="arrow-right" size={12} />
				</span>
			</button>
		</div>
	);
}
