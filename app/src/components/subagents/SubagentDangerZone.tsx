import { Button } from "@/components/Button";
import { harnessLabel } from "@/components/harness/harnessRegistry";

export interface SubagentDangerZoneProps {
	disabled: boolean;
	confirmingDelete: boolean;
	deleteBoth: boolean;
	linked: boolean;
	linkedOthers: string[];
	onToggleDisabled: () => void;
	onConfirmDelete: () => void;
	onCancelDelete: () => void;
	onStartDelete: () => void;
	onDeleteBothChange: (v: boolean) => void;
}

export function SubagentDangerZone({
	disabled,
	confirmingDelete,
	deleteBoth,
	linked,
	linkedOthers,
	onToggleDisabled,
	onConfirmDelete,
	onCancelDelete,
	onStartDelete,
	onDeleteBothChange,
}: SubagentDangerZoneProps) {
	return (
		<div className="danger-zone">
			<h4>Danger zone</h4>
			<div className="subagent-danger-copy">
				Deleting removes the agent file (a backup is kept) and any
				disable rule. To turn it off reversibly, use Disable instead.
			</div>
			<div className="actions">
				<Button variant="soft" icon="power" onClick={onToggleDisabled}>
					{disabled ? "Enable" : "Disable"}
				</Button>
				{confirmingDelete ? (
					<>
						<Button variant="danger" icon="trash" onClick={onConfirmDelete}>
							Confirm delete
						</Button>
						<Button onClick={onCancelDelete}>Cancel</Button>
					</>
				) : (
					<Button variant="danger" icon="trash" onClick={onStartDelete}>
						Delete this agent
					</Button>
				)}
			</div>
			{confirmingDelete && linked && (
				<div
					className="subagent-delete-choice"
					role="radiogroup"
					aria-label="Linked delete scope"
				>
					<label className="subagent-radio">
						<input
							type="radio"
							name="delete-link-action"
							checked={!deleteBoth}
							onChange={() => onDeleteBothChange(false)}
						/>
						<span>
							Delete only this harness's file{" "}
							<span className="text-dim">(unlinks the twin)</span>
						</span>
					</label>
					<label className="subagent-radio">
						<input
							type="radio"
							name="delete-link-action"
							checked={deleteBoth}
							onChange={() => onDeleteBothChange(true)}
						/>
						<span>
							Delete both linked files{" "}
							<span className="text-dim">
								({linkedOthers.map(harnessLabel).join(", ") || "twin"}{" "}
								too)
							</span>
						</span>
					</label>
				</div>
			)}
		</div>
	);
}
