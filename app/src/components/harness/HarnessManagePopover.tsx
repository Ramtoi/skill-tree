import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	setAgentDocsStrategy,
	useAgentDocsStrategy,
} from "@/hooks/useAgentDocs";
import { queryClient } from "@/lib/queryClient";
import type { AgentDocRootStrategy } from "@/types/agentDocs";
import { HarnessGlyph } from "./HarnessGlyph";
import { harnessTint, harnessFile } from "./harnessRegistry";

export interface HarnessManagePopoverProps {
	projectName: string;
	globalHarnesses: string[];
	projectHarnesses: string[];
	onClose: () => void;
}

/**
 * The full per-project harness manager. Toggling an agent mutates the
 * project-level list; globally-enabled agents are shown on but locked (managed
 * on the global Harnesses screen).
 */
export function HarnessManagePopover({
	projectName,
	globalHarnesses,
	projectHarnesses,
	onClose,
}: HarnessManagePopoverProps) {
	const harnesses = useHarnesses();
	const toast = useToast();
	const setMutating = useAppStore((s) => s.setMutating);
	const mutating = useAppStore((s) => s.mutating);
	const strategyInfo = useAgentDocsStrategy(projectName);

	async function changeStrategy(value: AgentDocRootStrategy) {
		try {
			await setAgentDocsStrategy({ projectName, value });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agent-docs-strategy"] }),
				queryClient.invalidateQueries({ queryKey: ["agent-docs-root-status"] }),
				queryClient.invalidateQueries({ queryKey: ["agent-docs"] }),
				queryClient.invalidateQueries({ queryKey: ["registry"] }),
			]);
			toast.push({
				kind: "success",
				title: `${projectName}: strategy → ${value}`,
				body: "Use Fix layout to re-derive CLAUDE.md.",
			});
		} catch (err) {
			toast.error("Could not change strategy", String(err));
		}
	}

	async function clearStrategyOverride() {
		try {
			await setAgentDocsStrategy({ projectName, clear: true });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agent-docs-strategy"] }),
				queryClient.invalidateQueries({ queryKey: ["agent-docs-root-status"] }),
				queryClient.invalidateQueries({ queryKey: ["agent-docs"] }),
				queryClient.invalidateQueries({ queryKey: ["registry"] }),
			]);
			toast.push({
				kind: "info",
				title: `${projectName}: override cleared`,
				body: "Project now inherits the global strategy.",
			});
		} catch (err) {
			toast.error("Could not clear override", String(err));
		}
	}

	const globalSet = useMemo(() => new Set(globalHarnesses), [globalHarnesses]);
	const projectSet = useMemo(
		() => new Set(projectHarnesses),
		[projectHarnesses],
	);

	async function persist(next: string[]) {
		setMutating(true);
		try {
			await invoke("project_set_harnesses", {
				project: projectName,
				harnesses: next,
			});
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
		} catch (err) {
			toast.error("Update failed", String(err));
		} finally {
			setMutating(false);
		}
	}

	async function toggle(id: string, installed: boolean, label: string) {
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
		await persist(next);
	}

	return (
		<div
			className="harness-popover"
			role="dialog"
			aria-label={`Harnesses for ${projectName}`}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="harness-popover-head">
				<div className="harness-popover-title">
					Harnesses for <span className="text-mono">{projectName}</span>
				</div>
				<button
					className="harness-popover-close"
					type="button"
					aria-label="Close"
					onClick={onClose}
				>
					<Icon name="x" size={11} />
				</button>
			</div>
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
							disabled={mutating}
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
								{isOn ? <Icon name="check" size={12} /> : null}
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
		</div>
	);
}
