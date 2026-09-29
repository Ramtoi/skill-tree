import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { Icon } from "@/components/Icon";
import { InfoBanner } from "@/components/InfoBanner";
import { CredentialLadder } from "@/components/backup/CredentialLadder";
import { useBackupAuth, useBackupInit, useBackupNow } from "@/hooks/useBackup";
import {
	describeCapturedCounts,
	summarizeBackupResult,
	BACKUP_REPO_NAME,
	BACKUP_REPO_PLACEHOLDER,
	GITHUB_NEW_REPO_URL,
	PRODUCT_NAME,
} from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * The optional final step of a fresh setup (design §9): offer to back the new
 * library up, then get out of the way.
 *
 * Deliberately **skippable without consequence** — it is the last screen of a
 * first run, the user has not built anything worth losing yet, and a mandatory
 * GitHub-credential step here would be the worst possible first impression. The
 * screen is reachable forever after via `g ⇧b` / the palette, and the copy says so.
 *
 * Three sub-states, in the same order and with the same wording as the Backup
 * screen's journey: credential → repository → first snapshot. They are the same
 * three questions, so they must not be two different vocabularies.
 */
export function BootstrapBackupStep({
	onDone,
	onSkip,
}: {
	onDone: () => void;
	onSkip: () => void;
}) {
	const { data: auth, isLoading: authLoading } = useBackupAuth();
	const init = useBackupInit();
	const backupNow = useBackupNow();
	const addToast = useAppStore((s) => s.addToast);

	const [repo, setRepo] = useState("");
	const [create, setCreate] = useState(false);
	const [initialized, setInitialized] = useState(false);
	const [captured, setCaptured] = useState<string | null>(null);

	const canCreate = auth?.create_method === "gh";
	const hasCredential = !!auth?.method;

	async function runInit() {
		try {
			const res = await init.mutateAsync({ repo: repo.trim(), create: create && canCreate });
			setInitialized(true);
			for (const w of (res?.warnings as string[] | undefined) ?? []) {
				addToast("info", w);
			}
			addToast("success", "Backup repository configured");
		} catch (e) {
			addToast("error", `Couldn't configure the backup — ${e}`);
		}
	}

	async function runFirstPush() {
		try {
			const res = await backupNow.mutateAsync(undefined);
			setCaptured(
				describeCapturedCounts(res.counts) || "Everything in your library is captured.",
			);
			addToast(res.ok === false || res.error ? "error" : "success", summarizeBackupResult(res));
		} catch (e) {
			addToast("error", `Backup failed — ${e}`);
		}
	}

	return (
		<div data-testid="bootstrap-backup-step">
			<h1 style={{ fontSize: 22, margin: 0, color: "var(--fg-strong)" }}>Back up your library</h1>
			<p style={{ marginTop: 8, color: "var(--fg-mid)", lineHeight: 1.6, maxWidth: "62ch" }}>
				Optional, and you can do it later. {PRODUCT_NAME} snapshots your skills, bundles, MCP
				servers, snippets, and sub-agents into a private git repo you own, so you can bring
				them to another machine.
			</p>

			<ol className="backup-stages" style={{ marginTop: 26 }}>
				{/* ── 1. Credential ── */}
				<li
					className="backup-stage"
					data-state={hasCredential ? "done" : "current"}
					data-testid="bootstrap-stage-credential"
				>
					<div className="backup-stage-rail" aria-hidden="true">
						<span className="backup-stage-pip">
							{hasCredential ? <Icon name="check" size={13} /> : 1}
						</span>
					</div>
					<div className="backup-stage-body">
						<div className="backup-stage-head">
							<h3 className="backup-stage-title">Connect your GitHub account</h3>
						</div>
						<div className="backup-stage-content">
							{authLoading ? (
								<span className="backup-dim">Checking your credentials…</span>
							) : (
								<CredentialLadder auth={auth} compact />
							)}
							{!authLoading && !hasCredential && (
								<InfoBanner>
									No GitHub credential yet — you can still set the repository up. Snapshots
									will be committed on this machine and pushed once a credential works.
								</InfoBanner>
							)}
						</div>
					</div>
				</li>

				{/* ── 2. Repository ── */}
				<li
					className="backup-stage"
					data-state={initialized ? "done" : "current"}
					data-testid="bootstrap-stage-repository"
				>
					<div className="backup-stage-rail" aria-hidden="true">
						<span className="backup-stage-pip">
							{initialized ? <Icon name="check" size={13} /> : 2}
						</span>
					</div>
					<div className="backup-stage-body">
						<div className="backup-stage-head">
							<h3 className="backup-stage-title">Choose where snapshots go</h3>
						</div>
						<p className="backup-stage-summary">
							A private git repository, used by nothing else. Empty is perfect.
						</p>
						<div className="backup-stage-content">
							<div className="backup-field-row">
								<div className="backup-field">
									<label htmlFor="bootstrap-repo">Private repository</label>
									<input
										id="bootstrap-repo"
										value={repo}
										spellCheck={false}
										placeholder={BACKUP_REPO_PLACEHOLDER}
										onChange={(e) => setRepo(e.target.value)}
									/>
								</div>
								{/* Primary only while this is the stage in play — once a repo is
								    set, the one violet action moves down to the snapshot. */}
								<Button
									variant={initialized ? "ghost" : "primary"}
									icon="apply"
									busy={init.isPending}
									disabled={!repo.trim()}
									disabledReason={!repo.trim() ? "Enter owner/name first" : undefined}
									onClick={() => void runInit()}
									data-testid="bootstrap-backup-init"
								>
									{initialized ? "Reconfigure" : "Use this repository"}
								</Button>
							</div>
							{canCreate ? (
								<div data-testid="bootstrap-backup-create">
									{/* The app has ONE checkbox primitive (COMPONENTS.md §Toggle); a
									    raw input here would be the only unskinned box in the wizard. */}
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
								</div>
							) : (
								<div className="backup-hint-row" data-testid="bootstrap-manual-create">
									<span>
										Don't have one yet? Make it on GitHub — set visibility to{" "}
										<strong>Private</strong> and skip the README, then paste{" "}
										<code>owner/{BACKUP_REPO_NAME}</code> above.
									</span>
									<Button
										icon="arrow-right"
										onClick={() => void openUrl(GITHUB_NEW_REPO_URL)}
										data-testid="bootstrap-open-github-new"
									>
										Create it on GitHub
									</Button>
								</div>
							)}
						</div>
					</div>
				</li>

				{/* ── 3. First snapshot ── */}
				<li
					className="backup-stage"
					data-state={captured ? "done" : initialized ? "current" : "todo"}
					data-testid="bootstrap-stage-first-backup"
				>
					<div className="backup-stage-rail" aria-hidden="true">
						<span className="backup-stage-pip">
							{captured ? <Icon name="check" size={13} /> : 3}
						</span>
					</div>
					<div className="backup-stage-body">
						<div className="backup-stage-head">
							<h3 className="backup-stage-title">Take your first snapshot</h3>
						</div>
						{!initialized && (
							<p className="backup-stage-summary">
								Available once a repository is set above.
							</p>
						)}
						{initialized && (
							<div className="backup-stage-content">
								<Button
									variant="primary"
									size="lg"
									icon="sync"
									busy={backupNow.isPending}
									onClick={() => void runFirstPush()}
									data-testid="bootstrap-backup-push"
								>
									{captured ? "Back up again" : "Take the first snapshot"}
								</Button>
								{captured && (
									<div className="backup-celebrate" data-testid="bootstrap-backup-captured">
										<Icon name="check" size={14} tone="green" />
										<span>Snapshot taken. {captured}</span>
									</div>
								)}
							</div>
						)}
					</div>
				</li>
			</ol>

			<div style={{ marginTop: 32, display: "flex", gap: 12 }}>
				<Button onClick={onSkip} data-testid="bootstrap-backup-skip">
					Skip for now
				</Button>
				<Button variant="primary" onClick={onDone} data-testid="bootstrap-backup-done">
					Done
				</Button>
			</div>
		</div>
	);
}
