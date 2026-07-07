import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import type { NeedsProvisioning, SubagentHarness } from "@/lib/subagents";

// ─── Attach-skill provisioning consequence prompt (D5) ────────────────────────
// Calm-but-explicit: a scope-widening action is never silent. Lists each skill
// with its human consequence sentence and a single confirm. A refusal replaces
// the confirm with either a distinct affinity-widen prompt (its OWN consequence)
// or a dead-stop explanation (remote quarantine) with no retry path. Shared by
// the agent editor and the skill-side "Attach to sub-agent…" flow.

export interface AffinityWidenState {
	skill: string;
	affinity: string[];
}

export function ProvisionPanel({
	items,
	harness,
	busy,
	error,
	widen,
	onConfirm,
	onCancel,
}: {
	items: NeedsProvisioning[];
	harness: SubagentHarness;
	busy: boolean;
	error: string | null;
	widen: AffinityWidenState | null;
	onConfirm: (widenSkill?: string) => void;
	onCancel: () => void;
}) {
	const many = items.length > 1;
	return (
		<div
			className="subagent-provision-panel"
			role="alertdialog"
			aria-label="Make skills available"
		>
			<div className="subagent-provision-head">
				<Icon name="globe" size={14} />
				<div>
					<div className="subagent-provision-title">
						{many ? "Make these skills available?" : "Make this skill available?"}
					</div>
					<div className="subagent-provision-sub">
						{harnessLabel(harness)} can only preload a skill that resolves in this
						agent's scope. Confirm to provision {many ? "them" : "it"}, then save.
					</div>
				</div>
			</div>

			<ul className="subagent-provision-list">
				{items.map((it) => (
					<li key={it.skill} className="subagent-provision-item">
						<span className="text-mono subagent-provision-skill">{it.skill}</span>
						<span className="subagent-provision-consequence">
							{it.consequence}
						</span>
					</li>
				))}
			</ul>

			{error ? (
				// Dead stop (e.g. remote-quarantined skill) — no retry, only dismiss.
				<>
					<div className="subagent-provision-error" role="alert">
						<Icon name="warning" size={12} /> {error}
					</div>
					<div className="subagent-provision-actions">
						<Button onClick={onCancel}>Close</Button>
					</div>
				</>
			) : widen ? (
				// Second, distinct consequence: clearing a harness-affinity restriction.
				<>
					<div className="subagent-provision-widen-note" role="alert">
						<Icon name="warning" size={12} />{" "}
						<span>
							<span className="text-mono">{widen.skill}</span> is restricted to{" "}
							{widen.affinity.length
								? widen.affinity.map(harnessLabel).join(", ")
								: "other harnesses"}
							, which excludes {harnessLabel(harness)}. Widening clears that
							restriction so the skill applies to every harness.
						</span>
					</div>
					<div className="subagent-provision-actions">
						<LoadingButton
							variant="primary"
							icon="check"
							loading={busy}
							loadingLabel="Widening…"
							onClick={() => onConfirm(widen.skill)}
						>
							Widen affinity &amp; continue
						</LoadingButton>
						<Button onClick={onCancel} disabled={busy}>
							Cancel
						</Button>
					</div>
				</>
			) : (
				<div className="subagent-provision-actions">
					<LoadingButton
						variant="primary"
						icon="check"
						loading={busy}
						loadingLabel="Provisioning…"
						onClick={() => onConfirm()}
					>
						Make available &amp; save
					</LoadingButton>
					<Button onClick={onCancel} disabled={busy}>
						Cancel
					</Button>
				</div>
			)}
		</div>
	);
}
