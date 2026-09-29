import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Toggle } from "@/components/Toggle";
import { InfoBanner } from "@/components/InfoBanner";
import { CredentialLadder } from "@/components/backup/CredentialLadder";
import { PatForm } from "@/components/backup/PatForm";
import { useBackupInit } from "@/hooks/useBackup";
import {
	backupRepoProblem,
	backupStages,
	describeCapturedCounts,
	BACKUP_REPO_NAME,
	BACKUP_REPO_PLACEHOLDER,
	GITHUB_NEW_REPO_URL,
	type BackupAuth,
	type BackupNowResult,
	type BackupStage,
	type BackupStatus,
} from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * Setting up a backup, as three explicit stages instead of parallel cards.
 *
 * The problem this replaces: the unconfigured screen showed a credential card, a
 * greyed "create repo" line, and a restore card — all at once, none of them
 * primary. A user whose credentials already worked had no visible way to *start*.
 * There was, in fact, no repo field on the screen at all: configuring a backup
 * outside the first-run wizard meant the CLI.
 *
 * The rules the stepper keeps:
 *
 * - **One `current` stage**, and **at most one violet primary per stage card**.
 *   `backupStages` guarantees the first; the second is what keeps a stage from
 *   offering two competing ways forward. Done stages collapse to a check + a
 *   summary; a stage with an unmet prerequisite shows what it will ask for and
 *   nothing more.
 * - **Nothing is locked.** A done stage reopens with `Change`, and a missing
 *   credential does not bar the repo stage — hub commits locally without one.
 *   That is not just a claim in this comment any more: an unblocked `todo`
 *   stage renders OPEN, with its controls live, alongside the current one. It
 *   used to collapse, so "You can still continue" appeared above nothing to
 *   continue with.
 * - **Every dead end has a verb.** Repo creation without `gh` is a real link to
 *   a pre-named `github.com/new`, not a grey sentence about a CLI.
 */
export function BackupSetupJourney({
	status,
	auth,
	authLoading,
	onFirstBackup,
	firstBackupBusy,
	lastResult,
}: {
	status: BackupStatus | null | undefined;
	auth: BackupAuth | null | undefined;
	authLoading?: boolean;
	/** Runs `backup now`. Owned by the screen so its result feeds the header too. */
	onFirstBackup: () => void;
	firstBackupBusy: boolean;
	lastResult: BackupNowResult | null;
}) {
	const stages = backupStages(status, auth);
	const init = useBackupInit();
	const addToast = useAppStore((s) => s.addToast);

	const [repo, setRepo] = useState("");
	const [touchedRepo, setTouchedRepo] = useState(false);
	const repoProblem = backupRepoProblem(repo);
	const [create, setCreate] = useState(false);
	const [patOpen, setPatOpen] = useState(false);
	/** Stages the user re-opened by hand. Never auto-collapses the current one. */
	const [opened, setOpened] = useState<Record<string, boolean>>({});

	const canCreate = auth?.create_method === "gh";

	async function runInit() {
		try {
			const res = await init.mutateAsync({ repo: repo.trim(), create: create && canCreate });
			for (const w of (res?.warnings as string[] | undefined) ?? []) addToast("info", w);
			addToast("success", "Backup repository configured");
		} catch (e) {
			addToast("error", `Couldn't configure the backup — ${e}`);
		}
	}

	/**
	 * Open when it is the live stage, when the user opened it, or when it is
	 * simply NOT BLOCKED.
	 *
	 * That last clause is the fix for the worst state on this screen: with no
	 * working credential, stage 1 was `current` and stage 2 collapsed to a title
	 * — so the banner promising "You can still continue" sat above nothing the
	 * user could continue with. The repo stage never depended on a credential
	 * (hub commits locally without one); it was collapsed only because it
	 * happened to be second in a list.
	 */
	function isOpen(stage: BackupStage) {
		if (stage.state === "current") return true;
		// A DONE stage still collapses to its summary — it is answered, and
		// re-opening it is the explicit `Change` button. Only a not-yet-done stage
		// with no unmet prerequisite stays open alongside the current one.
		if (stage.state === "todo" && !stage.blocked) return true;
		return opened[stage.id] === true;
	}

	return (
		<div className="backup-journey" data-testid="backup-journey">
			<ol className="backup-stages">
				{stages.map((stage) => (
					<li
						key={stage.id}
						className="backup-stage"
						data-stage={stage.id}
						data-state={stage.state}
						data-open={isOpen(stage) ? "true" : "false"}
						data-testid={`backup-stage-${stage.id}`}
					>
						<div className="backup-stage-rail" aria-hidden="true">
							<span className="backup-stage-pip">
								{stage.state === "done" ? <Icon name="check" size={13} /> : stage.n}
							</span>
						</div>

						<div className="backup-stage-body">
							<div className="backup-stage-head">
								{/* The pip is decoration (`aria-hidden`), so the stage's state
								    reaches assistive tech as a word instead of a colour. */}
								<h3 className="backup-stage-title">
									<span className="backup-stage-state">
										{stage.state === "done"
											? "Done: "
											: stage.state === "current"
												? "Do this next: "
												: stage.blocked
													? "Later: "
													: "Ready when you are: "}
									</span>
									{stage.title}
								</h3>
								{stage.state === "done" && (
									<Button
										size="sm"
										onClick={() =>
											setOpened((o) => ({ ...o, [stage.id]: !o[stage.id] }))
										}
										data-testid={`backup-stage-change-${stage.id}`}
									>
										{opened[stage.id] ? "Hide" : "Change"}
									</Button>
								)}
							</div>
							<p className="backup-stage-summary">{stage.summary}</p>

							{isOpen(stage) && (
								<div className="backup-stage-content">
									{stage.id === "credential" && (
										<>
											{authLoading ? (
												<p className="backup-dim">Checking your credentials…</p>
											) : (
												<CredentialLadder
													auth={auth}
													onStoreToken={
														auth?.keyring_available === false
															? undefined
															: () => setPatOpen(true)
													}
												/>
											)}
											{patOpen && <PatForm onClose={() => setPatOpen(false)} />}
											{!authLoading && !auth?.method && (
												<InfoBanner>
													You can still continue — snapshots will be committed on this
													machine and pushed as soon as a credential works.
												</InfoBanner>
											)}
										</>
									)}

									{stage.id === "repository" && (
										<>
											<div className="backup-field-row">
												<div className="backup-field">
													<label htmlFor="backup-repo">Private repository</label>
													<input
														id="backup-repo"
														value={repo}
														spellCheck={false}
														placeholder={BACKUP_REPO_PLACEHOLDER}
														aria-invalid={touchedRepo && !!repoProblem}
														aria-describedby={
															touchedRepo && repoProblem ? "backup-repo-problem" : undefined
														}
														onChange={(e) => {
															setRepo(e.target.value);
															setTouchedRepo(true);
														}}
														data-testid="backup-repo-input"
													/>
													{touchedRepo && repo.trim() && repoProblem && (
														<p className="backup-field-problem" id="backup-repo-problem">
															{repoProblem}
														</p>
													)}
												</div>
												{/* Validated here, not by the CLI's refusal: the field takes
												    `owner/name`, and pasting a clone URL (the mistake people
												    actually make) used to arm the primary and fail on submit. */}
												<Button
													variant="primary"
													icon="apply"
													busy={init.isPending}
													disabled={!!repoProblem}
													disabledReason={repoProblem ?? undefined}
													onClick={() => void runInit()}
													data-testid="backup-init"
												>
													Use this repository
												</Button>
											</div>

											{canCreate ? (
												<Toggle
													checked={create}
													onChange={setCreate}
													ariaLabel="Create it on GitHub for me (private)"
													label={
														<span className="backup-toggle-label">
															Create it on GitHub for me — private, empty
														</span>
													}
												/>
											) : (
												<div className="backup-hint-row" data-testid="backup-manual-create">
													<span>
														Don't have one yet? Make it on GitHub — set visibility to{" "}
														<strong>Private</strong> and skip the README, then paste{" "}
														<code>owner/{BACKUP_REPO_NAME}</code> above.
													</span>
													<Button
														icon="arrow-right"
														onClick={() => void openUrl(GITHUB_NEW_REPO_URL)}
														data-testid="backup-open-github-new"
													>
														Create it on GitHub
													</Button>
												</div>
											)}
										</>
									)}

									{stage.id === "first-backup" && (
										<>
											<Button
												variant="primary"
												size="lg"
												icon="sync"
												busy={firstBackupBusy}
												onClick={onFirstBackup}
												data-testid="backup-first-run"
											>
												Take the first snapshot
											</Button>
											{lastResult && !lastResult.error && (
												<div className="backup-celebrate" data-testid="backup-celebrate">
													<Icon name="check" size={14} tone="green" />
													<span>
														{lastResult.pushed
															? "Snapshot pushed to GitHub."
															: "Snapshot committed on this machine."}{" "}
														{describeCapturedCounts(lastResult.counts) ||
															"Everything in your library is captured."}
													</span>
												</div>
											)}
										</>
									)}
								</div>
							)}
						</div>
					</li>
				))}
			</ol>
		</div>
	);
}
