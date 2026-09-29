import { useMemo, useState } from "react";
import { invoke } from "@/lib/ipc";

import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/loading";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	setAgentDocsStrategy,
	publishAgentDocsNow,
	setAgentDocsPublish,
	useAgentDocsPublish,
	useAgentDocsStrategy,
} from "@/hooks/useAgentDocs";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import type { AgentDocRootStrategy } from "@/types/agentDocs";
import { HarnessGlyph } from "./HarnessGlyph";
import { harnessTint, harnessFile } from "./harnessRegistry";

export interface HarnessManagePopoverProps {
	open: boolean;
	projectName: string;
	projectPath: string;
	globalHarnesses: string[];
	projectHarnesses: string[];
	onClose: () => void;
}

/**
 * The full per-project harness manager dialog. Toggling an agent mutates the
 * project-level list; globally-enabled agents are shown on but locked (managed
 * on the global Harnesses screen).
 */
function HarnessManageContent({
	projectName,
	projectPath,
	globalHarnesses,
	projectHarnesses,
}: Omit<HarnessManagePopoverProps, "open" | "onClose">) {
	const harnesses = useHarnesses();
	const toast = useToast();
	const strategyInfo = useAgentDocsStrategy(projectName);
	const publishInfo = useAgentDocsPublish(projectName);
	const [publishSettingBusy, setPublishSettingBusy] = useState(false);
	const [publishNowBusy, setPublishNowBusy] = useState(false);
	// Per-harness in-flight set — only the toggled row disables; siblings stay
	// interactive (the StatusBar global indicator carries the ambient signal).
	const [pending, setPending] = useState<Set<string>>(() => new Set());

	async function changePublishOnSave(enabled: boolean) {
		setPublishSettingBusy(true);
		try {
			await setAgentDocsPublish(projectName, enabled);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.publishAll() }),
				invalidateRegistry(queryClient),
			]);
			toast.push({
				kind: enabled ? "success" : "info",
				title: enabled ? "Publish on save is on" : "Publish on save is off",
				body: enabled
					? "Root Agent Docs will publish to origin/main after each save."
					: "Future saves will stay local.",
			});
		} catch (err) {
			toast.error("Couldn't change publish on save", String(err));
		} finally {
			setPublishSettingBusy(false);
		}
	}

	async function publishNow() {
		setPublishNowBusy(true);
		try {
			const result = await publishAgentDocsNow(projectPath);
			toast.push({
				kind: result.published ? "success" : "info",
				title: result.published ? "Agent Docs published" : "Nothing published",
				body: result.message,
			});
		} catch (err) {
			toast.error("Couldn't publish Agent Docs", String(err));
		} finally {
			setPublishNowBusy(false);
		}
	}

	async function changeStrategy(value: AgentDocRootStrategy) {
		try {
			await setAgentDocsStrategy({ projectName, value });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.strategyAll() }),
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.rootStatusAll() }),
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.all() }),
				invalidateRegistry(queryClient),
			]);
			toast.push({
				kind: "success",
				title: `${projectName}: strategy → ${value}`,
				body: "Use Fix layout to re-derive CLAUDE.md.",
			});
		} catch (err) {
			toast.error("Couldn't change strategy", String(err));
		}
	}

	async function clearStrategyOverride() {
		try {
			await setAgentDocsStrategy({ projectName, clear: true });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.strategyAll() }),
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.rootStatusAll() }),
				queryClient.invalidateQueries({ queryKey: qk.agentDocs.all() }),
				invalidateRegistry(queryClient),
			]);
			toast.push({
				kind: "info",
				title: `${projectName}: override cleared`,
				body: "Project now inherits the global strategy.",
			});
		} catch (err) {
			toast.error("Couldn't clear override", String(err));
		}
	}

	const globalSet = useMemo(() => new Set(globalHarnesses), [globalHarnesses]);
	const projectSet = useMemo(
		() => new Set(projectHarnesses),
		[projectHarnesses],
	);

	async function persist(id: string, next: string[]) {
		setPending((p) => new Set(p).add(id));
		try {
			await invoke("project_set_harnesses", {
				project: projectName,
				harnesses: next,
			});
			await invalidateRegistry(queryClient);
		} catch (err) {
			toast.error("Couldn't update harnesses", String(err));
		} finally {
			setPending((p) => {
				const n = new Set(p);
				n.delete(id);
				return n;
			});
		}
	}

	async function toggle(id: string, installed: boolean, label: string) {
		if (pending.has(id)) return;
		if (!installed) {
			toast.push({
				kind: "error",
				title: `${label} not installed`,
				body: "Install it locally, then come back here.",
			});
			return;
		}
		if (globalSet.has(id) && !projectSet.has(id)) {
			toast.push({
				kind: "info",
				title: `${label} is enabled globally`,
				body: "Manage it on the Harnesses screen.",
			});
			return;
		}
		const next = projectSet.has(id)
			? projectHarnesses.filter((h) => h !== id)
			: [...projectHarnesses, id];
		await persist(id, next);
	}

	return (
		<div className="harness-popover">
				<div className="harness-popover-hint">
					Skills sync into the root file each agent reads.
				</div>
				<div className="harness-popover-list">
					{harnesses.map((h) => {
						const viaGlobal = globalSet.has(h.id) && !projectSet.has(h.id);
						const isOn = globalSet.has(h.id) || projectSet.has(h.id);
						return (
							<button
								type="button"
								key={h.id}
								className="harness-popover-row"
								data-on={isOn || undefined}
								data-disabled={!h.installed || undefined}
								data-pending={pending.has(h.id) || undefined}
								disabled={pending.has(h.id)}
								aria-busy={pending.has(h.id) || undefined}
								style={{ ["--harness-accent" as string]: harnessTint(h.id) }}
								onClick={() => void toggle(h.id, h.installed, h.label)}
							>
								<HarnessGlyph id={h.id} label={h.label} size={20} decorative />
								<span className="harness-popover-name">
									<span>{h.label}</span>
									<span className="harness-popover-sub">
										reads <span className="text-mono">{harnessFile(h.id)}</span>
										{viaGlobal
											? " · via global"
											: h.installed
												? h.version
													? ` · v${h.version}`
													: ""
												: " · not installed"}
									</span>
								</span>
								<span className="harness-popover-check">
									{pending.has(h.id) ? (
										<Spinner size={12} color="currentColor" />
									) : isOn ? (
										<Icon name="check" size={12} />
									) : null}
								</span>
							</button>
						);
					})}
				</div>
				<div className="harness-popover-strategy">
					<div className="harness-popover-strategy-title">
						Root derivation strategy
					</div>
					<div className="harness-popover-strategy-row">
						<select
							value={
								strategyInfo.data?.override_value ??
								strategyInfo.data?.global ??
								"symlink"
							}
							onChange={(e) =>
								void changeStrategy(
									e.currentTarget.value as AgentDocRootStrategy,
								)
							}
							aria-label="Root derivation strategy"
							title={
								"symlink — CLAUDE.md is a symlink → AGENTS.md (one real file plus a link)\n" +
								"import — CLAUDE.md is a regular file whose body is @AGENTS.md (commits two real files; portable on Windows)"
							}
						>
							<option value="symlink">symlink</option>
							<option value="import">import</option>
						</select>
						{strategyInfo.data?.override_value ? (
							<button
								type="button"
								className="harness-popover-strategy-clear"
								onClick={() => void clearStrategyOverride()}
								title="Clear the per-project override and inherit the global strategy."
							>
								Clear override
							</button>
						) : (
							<span className="harness-popover-strategy-inherit">
								inherits global · {strategyInfo.data?.global ?? "symlink"}
							</span>
						)}
					</div>
				</div>
			<div className="harness-popover-publish">
				<div className="harness-popover-publish-copy">
					<span className="harness-popover-strategy-title">Publish on save</span>
					<span>Commit root Agent Docs and push them to origin/main.</span>
				</div>
				<Toggle
					variant="switch"
					size="sm"
					checked={publishInfo.data?.enabled ?? false}
					disabled={publishInfo.isLoading || publishSettingBusy}
					onChange={(enabled) => void changePublishOnSave(enabled)}
					ariaLabel="Publish root Agent Docs to origin main after each save"
					dataTestid="agent-docs-publish-toggle"
				/>
				{publishInfo.data?.enabled && (
					<Button
						variant="soft"
						size="sm"
						busy={publishNowBusy}
						onClick={() => void publishNow()}
						className="harness-popover-publish-now"
					>
						Publish now
					</Button>
				)}
			</div>
		</div>
	);
}

export function HarnessManagePopover({
	open,
	projectName,
	projectPath,
	globalHarnesses,
	projectHarnesses,
	onClose,
}: HarnessManagePopoverProps) {
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={
				<>
					Harnesses for <span className="text-mono">{projectName}</span>
				</>
			}
			aria-label={`Harnesses for ${projectName}`}
			width={560}
			className="harness-manager-modal"
		>
			<HarnessManageContent
				projectName={projectName}
				projectPath={projectPath}
				globalHarnesses={globalHarnesses}
				projectHarnesses={projectHarnesses}
			/>
		</Modal>
	);
}
