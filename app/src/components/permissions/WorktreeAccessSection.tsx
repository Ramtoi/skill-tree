import { Icon } from "../Icon";
import { SidePanelSection } from "../SidePanelSection";
import { StatePill } from "../StatePill";
import { Toggle } from "../Toggle";
import type {
	Capabilities,
	NormalizedPermissions,
	WorktreeAccessConfig,
	WorktreeAccessStatus,
	WorktreeHarnessStatus,
} from "@/types/permissions";

export interface WorktreeAccessSectionProps {
	draft: NormalizedPermissions;
	onChange: (next: NormalizedPermissions) => void;
	suggestion?: string;
	status?: WorktreeAccessStatus;
	installed: string[];
	capabilities: Capabilities;
	labels: Record<string, string>;
}

function statusLabel(row: WorktreeHarnessStatus): string {
	if (row.config_state === "not_installed") return "not installed";
	if (row.config_state === "unsupported") return "unsupported";
	if (row.config_state === "removed") return "removed";
	if (row.config_state === "failed") return "failed";
	if (row.config_state === "unmanaged") return "unmanaged";
	if (row.config_state === "borrowed") return "existing grant";
	return "configured";
}

function statusState(row: WorktreeHarnessStatus): "saved" | "info" | "unsaved" {
	if (row.config_state === "failed") return "unsaved";
	if (["unsupported", "not_installed", "removed", "unmanaged"].includes(row.config_state)) return "info";
	return "saved";
}

export function WorktreeAccessSection({
	draft,
	onChange,
	suggestion,
	status,
	installed,
	capabilities,
	labels,
}: WorktreeAccessSectionProps) {
	if (!draft || !capabilities) return null;
	const config: WorktreeAccessConfig = draft.worktree_access ?? {
		enabled: false,
		path: suggestion ?? "",
	};
	const rows = status?.harnesses ?? [];
	const update = (patch: Partial<WorktreeAccessConfig>) =>
		onChange({ ...draft, worktree_access: { ...config, ...patch } });
	const missingParent = status?.missing_parent ?? false;
	const hasFailure = rows.some((row) => row.config_state === "failed");
	return (
		<SidePanelSection
			id="worktree-access"
			title="Project worktrees"
			defaultOpen
			count={rows.length}
			summary={<span className="text-dim">{config.enabled ? "enabled" : "disabled"}</span>}
			headTitle="Allow session agents to work in this project's worktrees."
		>
			<div className="worktree-access" data-testid="worktree-access-section">
				<div className="worktree-access-toggle">
					<Toggle
						checked={config.enabled}
						onChange={(enabled) => update({ enabled })}
						variant="switch"
						ariaLabel="Allow agents to work in this project's worktrees"
						dataTestid="worktree-access-toggle"
					/>
					<span>
						<strong>Allow agents to work in this project's worktrees</strong>
						<span className="worktree-access-copy">
							All session agents share this directory. Task briefs allocate files.
							Existing approval settings stay in place.
						</span>
					</span>
				</div>
				<label className="worktree-access-path">
					<span>WORKTREE DIRECTORY</span>
					<input
						value={config.path}
						placeholder={suggestion ?? "~/Dev/worktrees/project"}
						aria-label="Worktree directory"
						onChange={(event) => update({ path: event.target.value })}
					/>
				</label>
				{!config.enabled && suggestion && !draft.worktree_access && (
					<div className="perm-side-hint">Suggested path: <code>{suggestion}</code></div>
				)}
				{missingParent && config.enabled && (
					<div className="perm-side-hint" role="status">
						Create this directory before starting a fresh session.
					</div>
				)}
				{hasFailure && (
					<div className="perm-side-hint" role="alert">Some harnesses did not receive this grant. Run Sync from the status bar to retry.</div>
				)}
				{!status && (
					<div className="perm-side-hint" role="status">Harness status is unavailable until the backend reloads. {installed.length} requested harness{installed.length === 1 ? "" : "es"} are awaiting status.</div>
				)}
				<div className="worktree-access-rows" aria-label="Worktree access by harness">
					{rows.map((row) => (
						<div className="worktree-access-row" key={row.harness} data-state={row.config_state}>
							<Icon name="permissions" size={13} />
							<span className="worktree-access-harness">{labels[row.harness] ?? row.harness}</span>
							<StatePill state={statusState(row)}>{statusLabel(row)}</StatePill>
							<span className="worktree-access-runtime"><strong>{row.runtime_state.replace(/_/g, " ")}</strong>{row.reason ? ` · ${row.reason}` : ""}</span>
						</div>
					))}
				</div>
				<details className="worktree-access-detail">
					<summary>Nested metadata can differ</summary>
					<p>
						The parent grant covers ordinary worktree files. Nested <code>.git</code>, <code>.codex</code>, and <code>.agents</code> paths can have separate protection.
						A parent grant can also allow writes to nested metadata. A session rooted in one worktree can protect that metadata. Task briefs allocate files, but they do not isolate agents.
					</p>
				</details>
			</div>
		</SidePanelSection>
	);
}
