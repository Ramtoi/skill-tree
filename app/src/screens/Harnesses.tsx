import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { Icon } from "@/components/Icon";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import {
	HARNESS_IDENTITY,
	harnessFile,
	harnessTint,
	type RootFile,
} from "@/components/harness/harnessRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useRegistry } from "@/hooks/useRegistry";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import type { HarnessStatus } from "@/store";

export function Harnesses() {
	const harnesses = useHarnesses();
	const { data: registry } = useRegistry();
	const navigate = useNavigate();
	const toast = useToast();
	const rescan = useAppStore((s) => s.rescanHarnesses);
	const setMutating = useAppStore((s) => s.setMutating);
	const mutating = useAppStore((s) => s.mutating);
	const [scanning, setScanning] = useState(false);

	const total = harnesses.length;
	const installedCount = harnesses.filter((h) => h.installed).length;

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
			await rescan();
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			const list = useAppStore.getState().harnesses;
			const inst = list.filter((h) => h.installed).length;
			toast.push({
				kind: "success",
				title: "Harness scan complete",
				body: `${inst} installed · ${list.length - inst} missing`,
			});
		} finally {
			setScanning(false);
		}
	}

	async function toggleGlobal(h: HarnessStatus, enabled: boolean) {
		setMutating(true);
		try {
			await invoke("harness_set_global", { id: h.id, enabled });
			await rescan();
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.push({
				kind: "info",
				title: `Global ${h.label}`,
				body: enabled
					? "Every capable project picks this up."
					: "No longer applied to every project.",
			});
		} catch (err) {
			toast.error("Failed", String(err));
		} finally {
			setMutating(false);
		}
	}

	const labelOf = useMemo(
		() => new Map(harnesses.map((h) => [h.id, h.label])),
		[harnesses],
	);

	return (
		<>
			<ScreenHeader
				leading={<Icon name="plug" size={14} />}
				title="Harnesses"
				meta={
					<Tag size="sm">
						{installedCount}/{total} installed
					</Tag>
				}
				subline="Coding agents this machine can talk to · skills sync to the root file each one reads"
				primary={
					<Button
						variant="primary"
						icon="refresh"
						disabled={scanning}
						onClick={() => void doRescan()}
					>
						{scanning ? "Rescanning…" : "Rescan"}
					</Button>
				}
			/>

			<div className="harnesses-screen">
				<div className="harnesses-grid">
					{harnesses.map((h) => {
						const installed = h.installed;
						const users = h.used_by_projects;
						return (
							<div
								key={h.id}
								className="harness-card"
								data-installed={installed || undefined}
								style={{
									["--harness-accent" as string]: harnessTint(h.id),
								}}
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
										<span
											className="harness-card-pill"
											data-tone={installed ? "ok" : "missing"}
										>
											<span className="dot" />
											{installed ? "installed" : "not installed"}
										</span>
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
											{h.path && (
												<div className="harness-meta-row">
													<span>path</span>
													<span className="text-mono harness-meta-path">
														{h.path}
													</span>
												</div>
											)}
											{!h.version && !h.path && (
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
												Install <strong>{h.label}</strong> locally to use it
												from Skill Tree.
											</span>
										</div>
									)}
								</div>

								<label
									className="harness-card-toggle"
									data-disabled={!installed || undefined}
								>
									<input
										type="checkbox"
										checked={h.on_globally}
										disabled={!installed || mutating}
										onChange={(e) =>
											void toggleGlobal(h, e.currentTarget.checked)
										}
									/>
									<span>
										<span className="toggle-title">Enable globally</span>
										<span className="toggle-sub">
											Every project that supports {harnessFile(h.id)} picks
											this up automatically.
										</span>
									</span>
								</label>

								<div className="harness-card-users">
									<div className="harness-users-head">
										<span>Used by</span>
										<span className="text-mono text-dim">{users.length}</span>
									</div>
									{users.length === 0 ? (
										<div className="harness-users-empty">
											No projects use {h.label} yet.
										</div>
									) : (
										<div className="harness-users-list">
											{users.map((p) => (
												<button
													key={p}
													type="button"
													className="harness-user-chip"
													onClick={() =>
														navigate(`/project/${encodeURIComponent(p)}`)
													}
												>
													<span className="project-dot" />
													<span>{p}</span>
												</button>
											))}
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>

				<div className="harnesses-files">
					<div className="harnesses-section-eyebrow">
						<Icon name="doc" size={12} />
						<span>Root files that agents read</span>
					</div>
					<div className="harnesses-files-grid">
						{fileGroups.map(({ file, harnessIds }) => {
							const projectsWithFile = projectsByFile[file] ?? [];
							return (
								<div className="harness-file-card" key={file}>
									<div className="harness-file-card-head">
										<Icon name="doc" size={14} />
										<span className="text-mono harness-file-card-name">
											{file}
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
									<div className="harness-file-card-foot">
										<span className="text-dim text-mono">
											required by {projectsWithFile.length} project
											{projectsWithFile.length === 1 ? "" : "s"}
										</span>
									</div>
								</div>
							);
						})}
					</div>
					<div className="harnesses-files-explainer">
						<Icon name="link" size={12} />
						<span>
							When a project enables agents that read different files, Skill
							Tree makes <strong>AGENTS.md the one real root</strong> and
							derives CLAUDE.md from it — a symlink, or a file that imports
							<span className="text-mono"> @AGENTS.md</span>. You edit
							AGENTS.md; CLAUDE.md follows. Choose the strategy in Agent Docs.
						</span>
					</div>
				</div>
			</div>
		</>
	);
}
