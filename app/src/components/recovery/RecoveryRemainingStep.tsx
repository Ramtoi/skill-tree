import { Button } from "@/components/Button";
import { InfoBanner } from "@/components/InfoBanner";
import { RecoveryRow, RecoveryRowEmpty } from "@/components/recovery/RecoveryRow";
import { invoke } from "@/lib/ipc";
import {
	recoveryErrorMessage,
	useRecoverySetLocalSource,
	useRecoverySkipLocalSource,
} from "@/hooks/useRecovery";
import type { RecoveryLocalSourceRow, RecoveryStatus } from "@/lib/recoveryContract";
import { useAppStore } from "@/store";

/**
 * Stage 4: local-only skill sources (F4) — a hand-authored `.claude/skills/…`
 * directory that isn't a Git cache, so nothing here can be cloned. The only
 * two honest options are "point at where it actually is" or "skip it, keep
 * the equipment". Never a guessed replacement.
 */
export function RecoveryRemainingStep({ status }: { status: RecoveryStatus }) {
	const setLocalSource = useRecoverySetLocalSource();
	const skipLocalSource = useRecoverySkipLocalSource();
	const addToast = useAppStore((s) => s.addToast);

	const rows = status.localSources;

	async function chooseSource(row: RecoveryLocalSourceRow) {
		try {
			const chosen = await invoke<string | null>("pick_directory");
			if (!chosen) return;
			await setLocalSource.mutateAsync({ skill: row.skill, path: chosen });
		} catch (e) {
			addToast("error", `Couldn't set the source for ${row.skill} — ${recoveryErrorMessage(e)}`);
		}
	}

	async function skip(row: RecoveryLocalSourceRow) {
		try {
			await skipLocalSource.mutateAsync({ skill: row.skill });
		} catch (e) {
			addToast("error", `Couldn't skip ${row.skill} — ${recoveryErrorMessage(e)}`);
		}
	}

	return (
		<div data-testid="recovery-remaining-step">
			<InfoBanner icon="folder" className="recovery-step-lede">
				These skills point at a folder this machine doesn't have — not a Git source, so there is
				nothing to clone. Choose the folder it lives in now, or skip and keep the skill equipped
				as-is.
			</InfoBanner>

			<div className="recovery-rows">
				{rows.length === 0 && (
					<RecoveryRowEmpty>No local-only skill sources need attention.</RecoveryRowEmpty>
				)}
				{rows.map((row) => (
					<RecoveryRow
						key={row.skill}
						status={row.status}
						name={row.skill}
						detail={row.detail}
						path={row.status === "ready" ? row.path : row.missingPath}
						testId={`recovery-local-source-row-${row.skill}`}
						actions={
							row.status === "ready" ? null : (
								<>
									<Button
										size="sm"
										busy={setLocalSource.isPending}
										onClick={() => void chooseSource(row)}
										data-testid={`recovery-local-source-choose-${row.skill}`}
									>
										Choose source…
									</Button>
									{row.status !== "skipped" && (
										<Button
											size="sm"
											variant="ghost"
											busy={skipLocalSource.isPending}
											onClick={() => void skip(row)}
											data-testid={`recovery-local-source-skip-${row.skill}`}
										>
											Skip for now
										</Button>
									)}
								</>
							)
						}
					/>
				))}
			</div>
		</div>
	);
}
