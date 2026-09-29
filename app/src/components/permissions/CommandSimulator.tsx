import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { HarnessGlyph } from "../harness/HarnessGlyph";
import { harnessLabel } from "../harness/harnessRegistry";
import { evaluateDecisionForHarness } from "@/lib/permissionDecision";
import type {
	NormalizedPermissions,
	PermissionFeature,
	RuleKind,
} from "@/types/permissions";

/**
 * "Test a command" simulator (§03). The user types a concrete shell command;
 * we predict the verdict live PER installed harness via
 * `evaluateDecisionForHarness` against the CURRENT in-memory draft. Each harness
 * filters the draft to the rules it can actually express (capability + Bash-only
 * caveat + affinity) before scoring, so when a control applies on one harness
 * but not another the verdicts diverge — and that divergence is the whole point:
 * it's visible at a glance. Pills are colored by kind — allow=green, ask=amber,
 * deny=red. Empty input renders nothing. Models Bash rules only (backend parity).
 *
 * Lives in the permissions side panel — `PermissionsSidePanel.tsx` mounts one
 * copy per view inside a `SidePanelSection id="simulate"`.
 */
export const SIM_PILL: Record<RuleKind, { label: string; accent: string }> = {
	allow: { label: "ALLOW", accent: "var(--green)" },
	ask: { label: "ASK", accent: "var(--amber)" },
	deny: { label: "DENY", accent: "var(--red)" },
};

export function CommandSimulator({
	draft,
	installed,
	capabilities,
	harnessLabels,
	command,
	onCommandChange,
}: {
	draft: NormalizedPermissions;
	installed: string[];
	capabilities: Record<string, PermissionFeature[]>;
	harnessLabels: Record<string, string>;
	/** Lifted into `PermissionsSidePanel` (one `useState`) so a typed command
	 *  survives a harness-tab switch and a section collapse/reopen — this
	 *  component used to own it locally, remounting (and losing it) on either. */
	command: string;
	onCommandChange: (next: string) => void;
}) {
	const trimmed = command.trim();
	const verdicts = trimmed
		? installed.map((id) => ({
				id,
				kind: evaluateDecisionForHarness(draft, trimmed, id, capabilities),
			}))
		: [];
	return (
		<div className="perm-sim" data-testid="command-simulator">
			<div className="perm-sim-input">
				<Icon name="search" size={12} />
				<input
					aria-label="Test a command"
					value={command}
					onChange={(e) => onCommandChange(e.target.value)}
					placeholder="Test a command…"
					spellCheck={false}
				/>
			</div>
			{verdicts.length > 0 && (
				<div className="perm-sim-harnesses" role="status">
					{verdicts.map(({ id, kind }) => {
						const meta = SIM_PILL[kind];
						const label = harnessLabels[id] ?? harnessLabel(id);
						return (
							<span
								key={id}
								className="perm-sim-harness"
								title={`${label} → ${meta.label}`}
							>
								<HarnessGlyph id={id} label={label} size={14} decorative />
								<span
									className="perm-sim-verdict"
									data-verdict={kind}
									data-harness={id}
									style={{ "--accent": meta.accent } as CSSProperties}
								>
									{meta.label}
								</span>
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
}
