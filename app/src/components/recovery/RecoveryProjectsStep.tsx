import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { InfoBanner } from "@/components/InfoBanner";
import { RecoveryRow, RecoveryRowEmpty } from "@/components/recovery/RecoveryRow";
import { RecoveryRepositoryPicker } from "@/components/recovery/RecoveryRepositoryPicker";
import { RecoveryAttachPicker } from "@/components/recovery/RecoveryAttachPicker";
import { recoveryErrorMessage, useRecoverySkipProject } from "@/hooks/useRecovery";
import type { RecoveryProjectRow, RecoveryStatus } from "@/lib/recoveryContract";
import { useAppStore } from "@/store";

/**
 * Stage 3: repository association and local attachment are two separate
 * decisions (PLAN.md's accepted decision #3) — this step never writes a sync
 * or a delivery on its own, only path/repository facts. A project with no
 * selection at all is left exactly where the plan requires: present, every
 * loadout setting intact, "No local directory attached".
 */
export function RecoveryProjectsStep({
	status,
	focusProject,
}: {
	status: RecoveryStatus;
	focusProject?: string | null;
}) {
	const [repoPickerFor, setRepoPickerFor] = useState<string | null>(null);
	const [attachPickerFor, setAttachPickerFor] = useState<RecoveryProjectRow | null>(null);
	const skipProject = useRecoverySkipProject();
	const addToast = useAppStore((s) => s.addToast);

	// `?project=NAME` deep link (Backup / a project's own "Attach directory"):
	// open whichever picker that project is ready for, once, the first time
	// its row is actually present in a loaded status.
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (focused || !focusProject) return;
		const row = status.projects.find((p) => p.name === focusProject);
		if (!row || row.attached) return;
		if (row.repository) setAttachPickerFor(row);
		else setRepoPickerFor(row.name);
		setFocused(true);
	}, [focused, focusProject, status.projects]);

	async function skip(row: RecoveryProjectRow) {
		try {
			await skipProject.mutateAsync({ project: row.name });
		} catch (e) {
			addToast("error", `Couldn't skip ${row.name} — ${recoveryErrorMessage(e)}`);
		}
	}

	return (
		<div data-testid="recovery-projects-step">
			<InfoBanner icon="folder" className="recovery-step-lede">
				Connecting a repository and attaching a local checkout are separate steps. Skipping keeps
				the project and its whole loadout in your library, marked "No local directory attached" —
				you can attach it later from the project or from Backup.
			</InfoBanner>

			<div className="recovery-rows">
				{status.projects.length === 0 && (
					<RecoveryRowEmpty>Every project resolved during restore.</RecoveryRowEmpty>
				)}
				{status.projects.map((row) => (
					<RecoveryRow
						key={row.name}
						status={row.attached ? "ready" : row.status}
						name={row.name}
						detail={row.attached ? "Attached" : <>
							<div>No local directory attached</div>
							{row.repository ? <div>Repository: {row.repository.url}</div> : <div>No repository on record</div>}
							{row.detail && <div>{row.status === "failed" ? "Failed: " : row.status === "interrupted" ? "Interrupted: " : ""}{row.detail}</div>}
						</>}
						path={row.attached ? row.path : null}
						testId={`recovery-project-row-${row.name}`}
						actions={
							row.attached ? null : (
								<>
									{row.repository ? (
										<Button
											size="sm"
											onClick={() => setAttachPickerFor(row)}
											data-testid={`recovery-project-attach-${row.name}`}
										>
											Attach directory…
										</Button>
									) : (
										<Button
											size="sm"
											onClick={() => setRepoPickerFor(row.name)}
											data-testid={`recovery-project-connect-${row.name}`}
										>
											Choose repository…
										</Button>
									)}
									{row.status !== "skipped" && (
										<Button
											size="sm"
											variant="ghost"
											busy={skipProject.isPending}
											onClick={() => void skip(row)}
											data-testid={`recovery-project-skip-${row.name}`}
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

			{repoPickerFor && (
				<RecoveryRepositoryPicker
					open
					project={repoPickerFor}
					onClose={() => setRepoPickerFor(null)}
				/>
			)}
			{attachPickerFor?.repository && (
				<RecoveryAttachPicker
					open
					project={attachPickerFor.name}
					repository={attachPickerFor.repository}
					onClose={() => setAttachPickerFor(null)}
				/>
			)}
		</div>
	);
}
