import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { ConfirmDialog } from "@/components/Modal";
import { RestoreConsequences } from "@/components/backup/RestoreConsequences";
import { useRestoreApply, useRestorePreview } from "@/hooks/useBackup";
import {
	canApplyRestore,
	restoreBlockReason,
	restoreConsentText,
	typedConfirmationMet,
	BACKUP_SOURCE_PLACEHOLDER,
	PRODUCT_NAME,
	RESTORE_MODE_LABELS,
	RESTORE_MODES,
	type RestoreMode,
	type RestorePlan,
} from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * Restore, as a danger zone (design §5).
 *
 * The flow is deliberately three steps — source → **preview** → confirm — with
 * no way to skip the preview: `restore_preview` is a dry run (the CLI's default),
 * and the confirm dialog can only be opened from a plan that came back from it.
 * A restore rewrites `registry.yaml` wholesale and installs executable state, so
 * "click once and it happens" is not an acceptable shape for it.
 *
 * Two independent gates guard the apply:
 * - typing the literal word RESTORE (defeats muscle-memory clicking), and
 * - an explicit checkbox for `--accept-executable-state`, shown only when the
 *   plan actually installs hooks / permission rules / trust grants.
 *
 * The consent is bound to ONE previewed request, two ways over:
 * - editing the source or the mode discards the plan and both consent ticks, so
 *   the apply button is gone until the new inputs are previewed, and
 * - the apply is sent from `plan.requestedSource` / `plan.requestedMode`, never
 *   from the live form state. Either alone would close the reported hole; both
 *   together mean no future refactor of one can silently reopen it.
 */
export function RestoreDangerZone({
	revealOnMount,
	headingLevel = "h3",
}: {
	/** Scroll the card into view once it mounts. Set by surfaces that reveal it
	 *  behind a toggle, where the expanded content can land below the fold. */
	revealOnMount?: boolean;
	/** `"none"` when the host already names the section (the Backup screen's
	 *  disclosure row). Two identical headings ~80px apart read as two sections
	 *  once they stack at compact width. */
	headingLevel?: "h3" | "none";
} = {}) {
	const rootRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!revealOnMount) return;
		rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [revealOnMount]);

	const [source, setSource] = useState("");
	const [mode, setMode] = useState<RestoreMode>("merge");
	const [plan, setPlan] = useState<RestorePlan | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [acceptExec, setAcceptExec] = useState(false);
	const [trustKey, setTrustKey] = useState(false);

	const preview = useRestorePreview();
	const apply = useRestoreApply();
	const addToast = useAppStore((s) => s.addToast);

	const consents = { executableState: acceptExec, trustNewKey: trustKey };
	const gatesMet = canApplyRestore(plan, consents);
	const confirmReady = typedConfirmationMet(typed) && gatesMet;

	/** Any change to what would be restored invalidates the consent given for
	 *  what WAS previewed. Everything downstream of the preview resets. */
	function invalidatePreview() {
		setPlan(null);
		setConfirmOpen(false);
		setTyped("");
		setAcceptExec(false);
		setTrustKey(false);
	}

	async function runPreview() {
		invalidatePreview();
		try {
			const p = await preview.mutateAsync({ source: source.trim(), mode });
			setPlan(p);
			if (p.error) addToast("error", p.error);
		} catch (e) {
			addToast("error", `Couldn't read the snapshot — ${e}`);
		}
	}

	async function runApply() {
		if (!plan) return;
		try {
			const res = await apply.mutateAsync({
				// FROZEN: what the previewed plan was built from — not `source` /
				// `mode`, which the user may have edited since.
				source: plan.requestedSource,
				mode: plan.requestedMode,
				acceptExecutableState: acceptExec,
				trustNewKey: trustKey,
				force: false,
			});
			setConfirmOpen(false);
			setTyped("");
			setAcceptExec(false);
			setTrustKey(false);
			setPlan(res);
			addToast(
				res.error ? "error" : "success",
				res.error ?? "Restore applied — review, then run a sync",
			);
		} catch (e) {
			addToast("error", `Restore failed — ${e}`);
		}
	}

	return (
		<section className="restore-zone" data-testid="restore-danger-zone" ref={rootRef}>
			{headingLevel === "h3" && <h3>Restore from a snapshot</h3>}

			<p className="restore-zone-lede">
				Pulls a snapshot into {PRODUCT_NAME} on this machine. Preview first — the preview never
				writes anything. A restore materializes files but does <strong>not</strong> sync them
				into your harnesses; you review, then sync.
			</p>

			<div className="restore-controls">
				<div className="backup-field">
					<label htmlFor="restore-source">Snapshot repo URL or local directory</label>
					<input
						id="restore-source"
						value={source}
						spellCheck={false}
						placeholder={BACKUP_SOURCE_PLACEHOLDER}
						onChange={(e) => {
							setSource(e.target.value);
							invalidatePreview();
						}}
					/>
				</div>
				<div className="backup-field restore-mode-field">
					<label htmlFor="restore-mode">Mode</label>
					<select
						id="restore-mode"
						className="restore-select"
						value={mode}
						onChange={(e) => {
							setMode(e.target.value as RestoreMode);
							invalidatePreview();
						}}
					>
						{/* One shared source for both screens — see RESTORE_MODE_LABELS. */}
						{RESTORE_MODES.map((m) => (
							<option key={m} value={m}>
								{RESTORE_MODE_LABELS[m]}
							</option>
						))}
					</select>
				</div>
				<Button
					icon="eye"
					busy={preview.isPending}
					disabled={!source.trim()}
					disabledReason={!source.trim() ? "Enter a snapshot URL or directory first" : undefined}
					onClick={() => void runPreview()}
					data-testid="restore-preview-btn"
				>
					Preview
				</Button>
			</div>

			{plan && (
				<div className="restore-plan">
					<RestoreConsequences plan={plan} />

					{!plan.applied && (
						<div style={{ marginTop: 16 }}>
							<Button
								variant="danger"
								icon="warning"
								// `fatal` (bad digest, key mismatch, bad signature) has no
								// consent path at all — the dialog must not even open.
								disabled={plan.fatal || !!plan.error}
								disabledReason={plan.error ?? undefined}
								onClick={() => setConfirmOpen(true)}
								data-testid="restore-apply-btn"
							>
								Restore this snapshot…
							</Button>
						</div>
					)}
				</div>
			)}

			<ConfirmDialog
				open={confirmOpen}
				title="Restore from backup?"
				tone="danger"
				width={620}
				confirmLabel="Restore"
				confirmIcon="warning"
				busy={apply.isPending}
				confirmDisabled={!confirmReady}
				/* Executable-state consent, so the list IS the consent. It clipped
				   mid-item at the scroll edge — the tail of "Writes outside the data
				   home" and the whole "Code this app will import and execute" group —
				   while the destructive confirm sat live underneath it, and the typed
				   RESTORE field was itself below the fold. Approving what you have
				   not seen is not consent. */
				requireScrollToEnd
				scrollGateLabel="Read to the end of the list first"
				onClose={() => {
					setConfirmOpen(false);
					setTyped("");
				}}
				onConfirm={() => void runApply()}
				body={
					plan ? (
						<div>
							<RestoreConsequences plan={plan} />

							{plan.requiresTrustConsent && (
								<div
									style={{
										marginTop: 16,
										padding: 10,
										border: "1px solid var(--red)",
										borderRadius: 6,
									}}
								>
									<Toggle
										checked={trustKey}
										onChange={setTrustKey}
										ariaLabel="Trust and pin this signing key"
										label={
											<span style={{ fontSize: 12, color: "var(--fg-mid)" }}>
												I trust this snapshot's signing key
												{plan.trust.keyId ? ` (${plan.trust.keyId})` : ""} — pin it for this
												source.
											</span>
										}
									/>
								</div>
							)}

							{plan.requiresExecConsent && (
								<div
									style={{
										marginTop: 16,
										padding: 10,
										border: "1px solid var(--amber)",
										borderRadius: 6,
									}}
								>
									<Toggle
										checked={acceptExec}
										onChange={setAcceptExec}
										ariaLabel={plan.unverifiedReferences?.length ? "Accept unverified references and executable state" : "Accept executable state"}
										label={
											<span style={{ fontSize: 12, color: "var(--fg-mid)" }}>
												{restoreConsentText(plan)}
											</span>
										}
									/>
								</div>
							)}

							<div style={{ marginTop: 14 }}>
								<label
									htmlFor="restore-confirm-input"
									style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
								>
									Type <strong>RESTORE</strong> to confirm
								</label>
								<input
									id="restore-confirm-input"
									value={typed}
									autoComplete="off"
									spellCheck={false}
									onChange={(e) => setTyped(e.target.value)}
									style={{
										width: 200,
										padding: "7px 10px",
										fontFamily: "var(--font-mono)",
										fontSize: 12,
										background: "var(--bg-0)",
										border: "1px solid var(--bg-3)",
										borderRadius: 6,
										color: "var(--fg-strong)",
									}}
								/>
								{restoreBlockReason(plan, consents) && (
									<p
										data-testid="restore-block-reason"
										style={{ fontSize: 11.5, color: "var(--amber)", margin: "8px 0 0" }}
									>
										{restoreBlockReason(plan, consents)}
									</p>
								)}
							</div>
						</div>
					) : null
				}
			/>
		</section>
	);
}
