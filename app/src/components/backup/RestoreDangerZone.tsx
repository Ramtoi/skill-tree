import { useState } from "react";

import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { ConfirmDialog } from "@/components/Modal";
import { RestoreConsequences } from "@/components/backup/RestoreConsequences";
import { useRestoreApply, useRestorePreview } from "@/hooks/useBackup";
import {
	canApplyRestore,
	restoreBlockReason,
	typedConfirmationMet,
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
export function RestoreDangerZone() {
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
		<section
			data-testid="restore-danger-zone"
			style={{
				border: "1px solid var(--red)",
				borderRadius: "var(--radius-lg, 10px)",
				background: "var(--bg-1)",
				padding: 16,
			}}
		>
			<SectionHeader label="Restore from a snapshot" />

			<p style={{ fontSize: 12.5, color: "var(--fg-mid)", lineHeight: 1.55, margin: "10px 0 14px" }}>
				Pulls a snapshot into this machine's hub. Preview first — the preview never writes
				anything. Restore materializes files but does <strong>not</strong> sync them into your
				agents; you review, then sync.
			</p>

			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
				<div style={{ flex: "1 1 320px", minWidth: 220 }}>
					<label
						htmlFor="restore-source"
						style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
					>
						Snapshot repo URL or local directory
					</label>
					<input
						id="restore-source"
						value={source}
						spellCheck={false}
						placeholder="git@github.com:me/skill-hub-backup.git"
						onChange={(e) => {
							setSource(e.target.value);
							invalidatePreview();
						}}
						style={{
							width: "100%",
							padding: "7px 10px",
							fontFamily: "var(--font-mono)",
							fontSize: 12,
							background: "var(--bg-0)",
							border: "1px solid var(--bg-3)",
							borderRadius: 6,
							color: "var(--fg-strong)",
						}}
					/>
				</div>
				<div>
					<label
						htmlFor="restore-mode"
						style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
					>
						Mode
					</label>
					<select
						id="restore-mode"
						value={mode}
						onChange={(e) => {
							setMode(e.target.value as RestoreMode);
							invalidatePreview();
						}}
						style={{
							padding: "7px 10px",
							fontSize: 12,
							background: "var(--bg-0)",
							border: "1px solid var(--bg-3)",
							borderRadius: 6,
							color: "var(--fg-strong)",
						}}
					>
						<option value="merge">merge — union, backup wins conflicts</option>
						<option value="replace">replace — wholesale, for a new machine</option>
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
				<div
					style={{
						marginTop: 16,
						padding: 14,
						borderRadius: 8,
						background: "var(--bg-2)",
					}}
				>
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
										ariaLabel="Accept executable state"
										label={
											<span style={{ fontSize: 12, color: "var(--fg-mid)" }}>
												I accept the {plan.executableState.length} executable item
												{plan.executableState.length === 1 ? "" : "s"} above —{" "}
												{plan.executableState.some((e) => e.code)
													? "hooks, permission rules, and restored connector / MCP code will run on this machine."
													: "hooks and permission rules will run on this machine."}
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
