import { useState } from "react";

import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { InfoBanner } from "@/components/InfoBanner";
import { RestoreConsequences } from "@/components/backup/RestoreConsequences";
import { useRestoreApply, useRestorePreview } from "@/hooks/useBackup";
import {
	canApplyRestore,
	requiresTypedConfirmation,
	restoreBlockReason,
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

	const preview = useRestorePreview();
	const apply = useRestoreApply();
	const addToast = useAppStore((s) => s.addToast);

	const consents = { executableState: acceptExec, trustNewKey: trustKey };
	const needsExecConsent = plan?.requiresExecConsent ?? false;
	const needsTyped = requiresTypedConfirmation(plan);
	const typedMet = !needsTyped || typedConfirmationMet(typed);
	const canApply = canApplyRestore(plan, consents) && typedMet;

	/** Any edit to what would be restored invalidates the consent given for what
	 *  WAS previewed. */
	function invalidatePreview() {
		setPlan(null);
		setAcceptExec(false);
		setTrustKey(false);
		setTyped("");
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
				// FROZEN: the previewed request, not the live form.
				source: plan.requestedSource,
				mode: plan.requestedMode,
				acceptExecutableState: acceptExec,
				trustNewKey: trustKey,
				force: false,
			});
			if (res.error) {
				setPlan(res);
				addToast("error", res.error);
				return;
			}
			addToast("success", "Restored from backup");
			onRestored();
		} catch (e) {
			addToast("error", `Restore failed — ${e}`);
		}
	}

	return (
		<div data-testid="bootstrap-restore-step">
			<h1 style={{ fontSize: 22, margin: 0, color: "var(--fg-strong)" }}>Restore from backup</h1>
			<p style={{ marginTop: 8, color: "var(--fg-mid)", lineHeight: 1.5 }}>
				Point Skill Tree at a snapshot repo and it will lay down your registry, skills, MCP
				servers, snippets, connectors, and sub-agents. Nothing is written until you review the
				preview below.
			</p>

			<div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
				<div style={{ flex: "1 1 340px", minWidth: 220 }}>
					<label
						htmlFor="bootstrap-restore-source"
						style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
					>
						Snapshot repo URL or local directory
					</label>
					<input
						id="bootstrap-restore-source"
						value={source}
						spellCheck={false}
						placeholder="git@github.com:me/skill-hub-backup.git"
						onChange={(e) => {
							setSource(e.target.value);
							invalidatePreview();
						}}
						style={{
							width: "100%",
							padding: "8px 10px",
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
						htmlFor="bootstrap-restore-mode"
						style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
					>
						Mode
					</label>
					<select
						id="bootstrap-restore-mode"
						value={mode}
						onChange={(e) => {
							setMode(e.target.value as RestoreMode);
							invalidatePreview();
						}}
						style={{
							padding: "8px 10px",
							fontSize: 12,
							background: "var(--bg-0)",
							border: "1px solid var(--bg-3)",
							borderRadius: 6,
							color: "var(--fg-strong)",
						}}
					>
						<option value="merge">merge — keep what's here</option>
						<option value="replace">replace — new machine</option>
					</select>
				</div>
				<Button
					icon="eye"
					busy={preview.isPending}
					disabled={!source.trim()}
					disabledReason={!source.trim() ? "Enter a snapshot URL or directory first" : undefined}
					onClick={() => void runPreview()}
					data-testid="bootstrap-restore-preview"
				>
					Preview
				</Button>
			</div>

			<InfoBanner style={{ marginTop: 16 }}>
				Restoring skips the import step — the snapshot already carries your whole hub, so
				there is nothing to adopt from other agents.
			</InfoBanner>

			{plan && (
				<div
					style={{
						marginTop: 20,
						padding: 14,
						borderRadius: 8,
						background: "var(--bg-1)",
						border: "1px solid var(--bg-3)",
					}}
				>
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
										{plan.trust.keyId ? ` (${plan.trust.keyId})` : ""} — pin it for this source.
									</span>
								}
							/>
						</div>
					)}

					{needsExecConsent && (
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

					{/* The same typed gate the Backup screen's danger zone uses, shown
					    only when this restore can actually destroy something. */}
					{needsTyped && (
						<div style={{ marginTop: 16 }} data-testid="bootstrap-restore-typed-gate">
							<label
								htmlFor="bootstrap-restore-confirm-input"
								style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
							>
								Type <strong>RESTORE</strong> to confirm
								{plan.targetPopulated ? " — this machine already holds hub content" : ""}
							</label>
							<input
								id="bootstrap-restore-confirm-input"
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
						</div>
					)}
				</div>
			)}

			<div style={{ marginTop: 24, display: "flex", gap: 12 }}>
				<Button onClick={onBack} disabled={apply.isPending}>
					Back
				</Button>
				<Button
					variant="danger"
					icon="warning"
					busy={apply.isPending}
					disabled={!canApply}
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
		</div>
	);
}
