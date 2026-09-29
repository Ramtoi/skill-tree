import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Disclosure } from "@/components/Disclosure";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { Toggle } from "@/components/Toggle";
import { RestoreConsequences } from "@/components/backup/RestoreConsequences";
import { useRestoreApply, useRestorePreview } from "@/hooks/useBackup";
import { useRecoveryStart } from "@/hooks/useRecovery";
import {
	canApplyRestore,
	requiresTypedConfirmation,
	BACKUP_SOURCE_PLACEHOLDER,
	PRODUCT_NAME,
	RESTORE_MODE_LABELS,
	RESTORE_MODES,
	restoreBlockReason,
	scrubTokens,
	restoreConsentText,
	typedConfirmationMet,
	type RestoreMode,
	type RestorePlan,
} from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * First-run restore (design §9): source → dry-run preview → confirm → apply.
 *
 * This path **skips the import wizard entirely**. Scanning `~/.claude` for
 * loose skills to adopt makes sense when you are building a hub from scratch;
 * it is noise-and-conflict when you are about to lay down a complete one from a
 * snapshot. The restore is also the only thing that should touch the registry
 * here, so the two must never both run.
 *
 * Defaults to `merge` — the safe half of the pair. `replace` is the right answer
 * for a genuinely new machine and wrong (destructively so) for anyone who
 * clicked "restore" on a hub that already holds something, and a first run is
 * exactly where a user is least able to tell those apart. The plan names what
 * each mode costs; the default must not be the one that loses data.
 *
 * Consent is bound to one previewed request, the same way the Backup screen's
 * danger zone binds it: editing the source or the mode discards the plan and
 * every tick, and the apply is sent from the plan's frozen request. When the
 * plan shows real losses (or this machine is already populated) the typed-word
 * gate applies here too — a first-run wizard is not a reason to make a
 * destructive restore one click cheaper.
 */
export function BootstrapRestoreStep({
	onBack,
	onRestored,
}: {
	onBack: () => void;
	onRestored: () => void;
}) {
	const [source, setSource] = useState("");
	const [mode, setMode] = useState<RestoreMode>("merge");
	const [plan, setPlan] = useState<RestorePlan | null>(null);
	const [acceptExec, setAcceptExec] = useState(false);
	const [trustKey, setTrustKey] = useState(false);
	const [typed, setTyped] = useState("");
	const [failure, setFailure] = useState<{ phase: "preview" | "restore"; detail: string } | null>(null);

	const preview = useRestorePreview();
	const apply = useRestoreApply();
	const recoveryStart = useRecoveryStart();
	const navigate = useNavigate();
	const addToast = useAppStore((s) => s.addToast);

	const busy = preview.isPending || apply.isPending;
	const consents = { executableState: acceptExec, trustNewKey: trustKey };
	const needsExecConsent = plan?.requiresExecConsent ?? false;
	const needsTyped = requiresTypedConfirmation(plan);
	const typedMet = !needsTyped || typedConfirmationMet(typed);
	const canApply = canApplyRestore(plan, consents) && typedMet;

	/** The one reason the visible actions are inert right now, in the order the
	 *  user meets them: no source at all ⇒ nothing can run; source but no plan ⇒
	 *  preview first; plan present ⇒ whichever consent gate is still shut. */
	const blockerHint = failure ? null : !source.trim()
		? "Enter a snapshot repo URL or a local directory above — Preview and Restore stay off until then."
		: !canApply
			? (restoreBlockReason(plan, consents) ??
				(typedMet ? null : "Type RESTORE to confirm"))
			: null;

	/** Any edit to what would be restored invalidates the consent given for what
	 *  WAS previewed. */
	function invalidatePreview() {
		setFailure(null);
		setPlan(null);
		setAcceptExec(false);
		setTrustKey(false);
		setTyped("");
	}

	async function runPreview() {
		invalidatePreview();
		try {
			const p = await preview.mutateAsync({ source: source.trim(), mode });
			if (p.error && !p.fatal) {
				setFailure({ phase: "preview", detail: scrubTokens(p.error) });
			} else {
				setPlan(p);
			}
		} catch (e) {
			setFailure({ phase: "preview", detail: scrubTokens(e) });
		}
	}

	async function runApply() {
		if (!plan || busy || !canApply) return;
		setFailure(null);
		try {
			const res = await apply.mutateAsync({
				// FROZEN: the previewed request, not the live form.
				source: plan.requestedSource,
				mode: plan.requestedMode,
				acceptExecutableState: acceptExec,
				trustNewKey: trustKey,
				force: false,
			});
			if (res.error) {
				invalidatePreview();
				setFailure({ phase: "restore", detail: scrubTokens(res.error) });
				return;
			}
			addToast("success", "Restored from backup — finish setup on this machine");
			// F2: the library is restored, but sources, project checkouts and
			// local-only skills still need attention. `onRestored` flips the
			// bootstrap gate (so the routed shell mounts); `recovery start`
			// seeds the persisted journey ONCE, right as "library applied" is
			// reached, and the navigate lands the now-routed app on it instead
			// of a bare Library the user has to know to leave again.
			try {
				await recoveryStart.mutateAsync(undefined);
			} catch {
				// Non-fatal: `/recovery` reads status fresh and can resume even
				// without a freshly-seeded operation id.
			}
			navigate("/recovery");
			onRestored();
		} catch (e) {
			invalidatePreview();
			setFailure({ phase: "restore", detail: scrubTokens(e) });
		}
	}

	return (
		<div data-testid="bootstrap-restore-step">
			<h1 className="im-bootstrap-restore-step-1">Restore from backup</h1>
			{/* Six domain nouns used to land before the user had met one. The
			    sentence now says what happens in plain terms; the preview below
			    enumerates the exact artifacts, which is where that detail belongs. */}
			<p className="im-bootstrap-restore-step-2">
				Load your library from a backup repository or local folder. Review the preview before restoring.
				GitHub links use the authentication available on this machine.
			</p>

			<div className="im-bootstrap-restore-step-3">
				<div className="im-bootstrap-restore-step-4">
					<label
						htmlFor="bootstrap-restore-source"
						className="im-bootstrap-restore-step-5"
					>
						Snapshot repo URL or local directory
					</label>
					<input
						id="bootstrap-restore-source"
						value={source}
						spellCheck={false}
						disabled={busy}
						placeholder={BACKUP_SOURCE_PLACEHOLDER}
						onChange={(e) => {
							setSource(e.target.value);
							invalidatePreview();
						}}
						className="im-bootstrap-restore-step-6"
					/>
				</div>
				<Button
					icon="eye"
					busy={preview.isPending}
					disabled={!source.trim() || busy}
					disabledReason={!source.trim() ? "Enter a snapshot URL or directory first" : undefined}
					onClick={() => void runPreview()}
					data-testid="bootstrap-restore-preview"
				>
					Preview
				</Button>
			</div>

			{failure && (
				<div className="im-bootstrap-restore-step-14" data-testid="bootstrap-restore-error" role="alert">
					<strong>{failure.phase === "preview" ? "Couldn't load your backup" : "Restore did not finish"}</strong>
					<p>
						{failure.phase === "preview"
							? (/host key verification failed|permission denied.*publickey/i).test(failure.detail)
								? "Your library has not changed. The SSH connection failed. Check your GitHub sign-in or SSH setup, then try Preview again."
								: "Your library has not changed. Check that this machine can access the backup, then try Preview again."
							: "Preview the backup again before retrying. Review the details below for any changes already made."}
					</p>
					<Disclosure summary="Technical details">
						<p style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{failure.detail}</p>
					</Disclosure>
				</div>
			)}

			{/* MODE AS TWO VISIBLE CHOICES, not a dropdown. This picks between a
			    non-destructive and a destructive write, and a <select> hid
			    `replace`'s consequence behind a click while truncating `merge`'s
			    inside an <option>. Both consequences are now on screen at once,
			    read verbatim from the one shared contract — the first-run fork and
			    the Backup screen cannot describe the same irreversible write in
			    opposite terms. ("merge — keep what's here" was FALSE:
			    `restore.py::merge_registry` lets the backup overwrite every
			    conflicting key.) */}
			<fieldset
				className="im-bootstrap-restore-step-7"
				data-testid="bootstrap-restore-mode"
				disabled={busy}
			>
				<legend
					className="im-bootstrap-restore-step-8"
				>
					Mode
				</legend>
				<div
					className="im-bootstrap-restore-step-9"
				>
					{RESTORE_MODES.map((m) => {
						const full = RESTORE_MODE_LABELS[m];
						const split = full.indexOf(" — ");
						const head = split === -1 ? full : full.slice(0, split);
						const consequence = split === -1 ? "" : full.slice(split + 3);
						const active = mode === m;
						return (
							<label
								key={m}
								data-testid={`bootstrap-restore-mode-${m}`}
								data-active={active || undefined}
								style={{
									display: "grid",
									gridTemplateColumns: "auto 1fr",
									gap: 10,
									alignItems: "start",
									padding: "10px 12px",
									borderRadius: 8,
									cursor: "pointer",
									border: `1px solid ${active ? "var(--ctx)" : "var(--bg-3)"}`,
									background: "var(--bg-1)",
								}}
							>
								<input
									type="radio"
									name="bootstrap-restore-mode"
									value={m}
									checked={active}
									aria-label={full}
									// Without an accent the UA paints its own blue, which reads
									// INVERTED on this dark ground (solid white = unselected).
									className="im-bootstrap-restore-step-10"
									onChange={() => {
										setMode(m);
										invalidatePreview();
									}}
								/>
								<span>
									<span
										className="im-bootstrap-restore-step-11"
									>
										{head}
									</span>
									{consequence && (
										<span
											className="im-bootstrap-restore-step-12"
										>
											{consequence}
										</span>
									)}
								</span>
							</label>
						);
					})}
				</div>
			</fieldset>



			{plan && (
				<div
					className="im-bootstrap-restore-step-14"
				>
					<RestoreConsequences plan={plan} compact />

					{plan.requiresTrustConsent && (
						<div
							className="im-bootstrap-restore-step-15"
						>
							<Toggle
								checked={trustKey}
								onChange={setTrustKey}
								ariaLabel="Trust and pin this signing key"
								label={
									<span className="im-bootstrap-restore-step-16">
										I trust this signing key
										{plan.trust.keyId ? ` (${plan.trust.keyId})` : ""}. Remember it for this backup.
									</span>
								}
							/>
						</div>
					)}

					{needsExecConsent && (
						<div
							className="im-bootstrap-restore-step-17"
						>
							<Toggle
								checked={acceptExec}
								onChange={setAcceptExec}
								ariaLabel={plan.unverifiedReferences?.length ? "Accept unverified references and executable state" : "Accept executable state"}
								label={
									<span className="im-bootstrap-restore-step-18">
										{restoreConsentText(plan)}
									</span>
								}
							/>
						</div>
					)}

					{/* The same typed gate the Backup screen's danger zone uses, shown
					    only when this restore can actually destroy something. */}
					{needsTyped && (
						<div className="im-bootstrap-restore-step-19" data-testid="bootstrap-restore-typed-gate">
							<label
								htmlFor="bootstrap-restore-confirm-input"
								className="im-bootstrap-restore-step-20"
							>
								Type <strong>RESTORE</strong> to confirm
								{plan.targetPopulated ? ` — ${PRODUCT_NAME} on this machine already has content` : ""}
							</label>
							<input
								id="bootstrap-restore-confirm-input"
								value={typed}
								autoComplete="off"
								spellCheck={false}
								onChange={(e) => setTyped(e.target.value)}
								className="im-bootstrap-restore-step-21"
							/>
						</div>
					)}
				</div>
			)}

			<div className="im-bootstrap-restore-step-22">
				<BackButton title="Back to setup" onClick={onBack} disabled={apply.isPending}>
					Back
				</BackButton>
				{/* Disabled until a plan exists — `canApplyRestore(null)` is false, and
				    `restoreBlockReason(null)` says "Preview the snapshot first". What
				    was wrong was the WEIGHT, not the logic: a `danger` button at full
				    red beside a correctly-dimmed `Preview` contradicted the screen's
				    own promise that nothing is written until the preview is reviewed.
				    The Button primitive now drops an inert danger out of the red
				    channel entirely, so the ranking finally reads. */}
				<Button
					variant="danger"
					icon="warning"
					busy={apply.isPending}
					disabled={!canApply || busy}
					disabledReason={
						restoreBlockReason(plan, consents) ??
						(typedMet ? undefined : "Type RESTORE to confirm")
					}
					onClick={() => void runApply()}
					data-testid="bootstrap-restore-apply"
				>
					Restore
				</Button>
			</div>

			{/* Both buttons start dead, and a `disabledReason` title only pays out
			    on hover. Name the current blocker in the open — the first-run user
			    who cannot tell why nothing is clickable is exactly the one who
			    will not think to hover a disabled control. */}
			{blockerHint && (
				<p
					data-testid="bootstrap-restore-blocker"
					className="im-bootstrap-restore-step-23"
				>
					{blockerHint}
				</p>
			)}
		</div>
	);
}
