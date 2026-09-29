import { Button } from "@/components/Button";
import { InfoBanner } from "@/components/InfoBanner";
import { RecoveryRow, RecoveryRowEmpty } from "@/components/recovery/RecoveryRow";
import { recoveryErrorMessage, useRecoveryRestoreSource, useRecoverySkipSource } from "@/hooks/useRecovery";
import type { RecoverySourceRow, RecoveryStatus } from "@/lib/recoveryContract";
import { useAppStore } from "@/store";

/**
 * Stage 2: recover each Git skill-source cache independently (F2/F4, A9). A
 * retry here never redoes the snapshot import — it only re-runs
 * `restore_source` for the one cache that failed, and the row is not marked
 * `ready` until the skills that source owns actually resolve to a path.
 */
export function RecoverySourcesStep({ status }: { status: RecoveryStatus }) {
	const restoreSource = useRecoveryRestoreSource();
	const skipSource = useRecoverySkipSource();
	const addToast = useAppStore((s) => s.addToast);

	const rows = status.sources;
	// Batch recovery respects saved skips and deferrals; those rows still have
	// an explicit Recover action when the user wants to resume them.
	const outstanding = rows.filter((r) => ["pending", "failed", "running", "interrupted"].includes(r.status));

	async function recoverOne(row: RecoverySourceRow) {
		try {
			await restoreSource.mutateAsync(row.id);
		} catch (e) {
			addToast("error", `Couldn't recover ${row.id} — ${recoveryErrorMessage(e)}`);
		}
	}

	async function recoverAll() {
		try {
			await restoreSource.mutateAsync("all");
		} catch (e) {
			addToast("error", `Couldn't recover every source — ${recoveryErrorMessage(e)}`);
		}
	}

	async function skip(row: RecoverySourceRow) {
		try {
			await skipSource.mutateAsync(row.id);
		} catch (e) {
			addToast("error", `Couldn't skip ${row.id} — ${recoveryErrorMessage(e)}`);
		}
	}

	return (
		<div data-testid="recovery-sources-step">
			<InfoBanner icon="source" className="recovery-step-lede">
				Git-cloned skill sources don't travel in a backup snapshot — each one clones fresh here.
				Skipping keeps the skills it owns registered; they equip again once you recover it later.
			</InfoBanner>

			{outstanding.length > 1 && (
				<div style={{ marginBottom: 12 }}>
					<Button
						icon="sync"
						busy={restoreSource.isPending}
						onClick={() => void recoverAll()}
						data-testid="recovery-sources-recover-all"
					>
						Recover all ({outstanding.length})
					</Button>
				</div>
			)}

			<div className="recovery-rows">
				{rows.length === 0 && <RecoveryRowEmpty>No skill sources need recovery.</RecoveryRowEmpty>}
				{rows.map((row) => (
					<RecoveryRow
						key={row.id}
						status={row.status}
						name={row.id}
						detail={row.detail ?? (row.healthy ? undefined : row.url)}
						path={row.status === "ready" ? row.cache : null}
						testId={`recovery-source-row-${row.id}`}
						actions={
							row.status === "ready" ? null : row.status === "skipped" ? (
								<Button
									size="sm"
									variant="ghost"
									busy={restoreSource.isPending}
									onClick={() => void recoverOne(row)}
								>
									Recover
								</Button>
							) : (
								<>
									<Button
										size="sm"
										busy={restoreSource.isPending}
										onClick={() => void recoverOne(row)}
										data-testid={`recovery-source-recover-${row.id}`}
									>
										{row.status === "failed" || row.status === "interrupted" ? "Retry" : "Recover"}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										busy={skipSource.isPending}
										onClick={() => void skip(row)}
										data-testid={`recovery-source-skip-${row.id}`}
									>
										Skip for now
									</Button>
								</>
							)
						}
					/>
				))}
			</div>
		</div>
	);
}
