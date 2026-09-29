import { Button } from "@/components/Button";
import { InfoBanner } from "@/components/InfoBanner";
import { recoveryFinishCounts, type RecoveryStatus } from "@/lib/recoveryContract";
import { recoveryErrorMessage, useRecoverySync } from "@/hooks/useRecovery";
import { useAppStore } from "@/store";

function Count({ n, label }: { n: number; label: string }) {
	return (
		<div className="recovery-finish-count">
			<span className="recovery-finish-count-n">{n}</span>
			<span className="recovery-finish-count-label">{label}</span>
		</div>
	);
}

/**
 * Stage 5: the one place recovery ever writes to harnesses. Local-only
 * (`--skip-backup --skip-remotes`, PLAN.md §7) — this never pushes the
 * backup or dispatches a remote, and `backup.pending_reconcile` stays exactly
 * as the earlier restore left it.
 */
export function RecoverySyncStep({
	status,
}: {
	status: RecoveryStatus;
}) {
	const sync = useRecoverySync();
	const addToast = useAppStore((s) => s.addToast);
	const result = sync.data ?? status.syncResult;
	const counts = recoveryFinishCounts(status);

	async function runSync() {
		try {
			await sync.mutateAsync();
		} catch (e) {
			addToast("error", `Sync failed — ${recoveryErrorMessage(e)}`);
		}
	}

	const projectFailures = Object.entries(result?.projectFailures ?? {});
	const projectNames = [
		...projectFailures.map(([name]) => name),
		...(result?.failedProjects ?? []).filter((name) => !projectFailures.some(([project]) => project === name)),
	];
	const hasDeliveryFailure = !!result && (
		!result.ok ||
		result.counts.failed > 0 ||
		result.globalFailures.length > 0 ||
		result.error !== null ||
		projectNames.length > 0
	);

	return (
		<div data-testid="recovery-sync-step">
			{status.backupPendingReconcile && (
				<InfoBanner icon="warning" className="recovery-step-lede">
					Backup pushes stay paused until you acknowledge the restore on the Backup screen — this
					sync does not change that.
				</InfoBanner>
			)}

			<Button
				icon="sync"
				busy={sync.isPending}
				onClick={() => void runSync()}
				data-testid="recovery-sync-run"
			>
				{result ? "Sync again" : "Sync now"}
			</Button>

			{result && (
				<section className="recovery-sync-result" data-testid="recovery-sync-result" aria-live="polite">
					<h3 className="backup-stage-title">Project delivery</h3>
					<p className="backup-stage-summary">
						What reached attached project directories in this sync.
					</p>
					{!status.syncCurrent && <p>Setup changed since this result. Run sync again before finishing.</p>}
					<div className="recovery-finish-counts" data-testid="recovery-delivery-counts">
						<Count n={result.counts.success} label="Synced" />
						<Count n={result.counts.skipped} label="Skipped" />
						<Count n={result.counts.failed} label="Failed" />
					</div>
					<p>
						{result.counts.success} synced · {result.counts.skipped} skipped ·{" "}
						{result.counts.failed} failed
					</p>
					{hasDeliveryFailure && (
						<InfoBanner icon="warning">
							Some delivery work needs attention. Use Sync again to retry the failed work; completed
							projects remain complete.
						</InfoBanner>
					)}
					{result.error && (
						<div role="alert">
							<InfoBanner icon="warning">{result.error}</InfoBanner>
						</div>
					)}
					{projectNames.length > 0 && (
						<div data-testid="recovery-project-failures">
							<h4>Project delivery details</h4>
							{projectNames.map((name) => {
								const details = result.projectFailures[name] ?? [];
								return (
									<div key={name} className="recovery-row-detail">
										<strong>{name}</strong>
										{details.length > 0 ? (
											<ul>
												{details.map((detail, index) => <li key={`${name}-${index}`}>{detail}</li>)}
											</ul>
										) : (
											<div>Delivery failed. Run Sync again to retry this project.</div>
										)}
									</div>
								);
							})}
						</div>
					)}
					{result.globalFailures.length > 0 && (
						<div data-testid="recovery-global-failures">
							<h4>Other sync issues</h4>
							<ul>
								{result.globalFailures.map((failure) => <li key={failure}>{failure}</li>)}
							</ul>
						</div>
					)}
				</section>
			)}

			<section data-testid="recovery-setup-readiness">
				<h3 className="backup-stage-title">Setup readiness</h3>
				<p className="backup-stage-summary">
					Sources, project attachments, and local-only skills reviewed during recovery.
				</p>
				<div className="recovery-finish-counts">
					<Count n={counts.ready} label="Ready" />
					<Count n={counts.skipped} label="Skipped" />
					<Count n={counts.failed} label="Needs attention" />
				</div>
			</section>
		</div>
	);
}
