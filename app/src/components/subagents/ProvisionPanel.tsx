import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { Plaque } from "@/components/Plaque";
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
		<Plaque
			accent="amber"
			className="subagent-provision-panel"
			role="alertdialog"
			aria-label="Make skills available"
			eyebrow={many ? "Make these skills available?" : "Make this skill available?"}
			actions={
				error ? (
					// Dead stop (e.g. remote-quarantined skill) — no retry, only dismiss.
					<Button onClick={onCancel}>Close</Button>
				) : widen ? (
					// Second, distinct consequence: clearing a harness-affinity restriction.
					<>
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
					</>
				) : (
					<>
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
					</>
				)
			}
		>
			<p className="subagent-provision-sub">
				{harnessLabel(harness)} can only preload a skill that resolves in this
				agent's scope. Confirm to provision {many ? "them" : "it"}, then save.
			</p>

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

			{error && (
				<div className="subagent-provision-error" role="alert">
					<Icon name="warning" size={12} /> {error}
				</div>
			)}
			{!error && widen && (
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
			)}
		</Plaque>
	);
}
