import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import { StatusBadge } from "@/components/StatusBadge";
import { CommandChip } from "@/components/backup/CommandChip";
import {
	credentialGuidance,
	GH_LOGIN_COMMAND,
	type AuthMethod,
	type AuthRung,
	type BackupAuth,
	type RungFix,
} from "@/lib/backupContract";

/** The tooltip: the CLI's exact reason, plus — for the token rung only — the
 *  keychain handle it lives under. That handle is real and occasionally needed
 *  (`security find-generic-password …`); it just has no business being in a
 *  sentence the user reads. */
function exactDetail(method: AuthMethod, rung?: AuthRung): string | undefined {
	const parts = [rung?.detail];
	if (method === "pat" && rung?.ref) parts.push(rung.ref);
	const joined = parts.filter(Boolean).join(" · ");
	return joined || undefined;
}

/**
 * The credential ladder, as three actionable rows rather than three verdicts.
 *
 * What changed and why: the old rows printed the CLI's reason string in grey and
 * stopped there — `gh CLI not installed` with nothing beside it, under a greyed
 * "needs an authenticated gh CLI" line. Every unavailable rung now carries a
 * concrete verb (`rungGuidance`), and a rung that is dead while ANOTHER rung
 * already pushes is labelled **optional** instead of reading as a failure.
 *
 * The app never runs a package manager: `brew install gh` is offered as copyable
 * text, not as a button that executes it. Installing software on someone's
 * machine from a GUI is a different consent from anything else this app asks
 * for, and a silent `brew` invocation could touch far more than `gh`.
 *
 * The CLI's own `detail` is not discarded — it becomes the row's `title`, so the
 * exact reason ("the `keyring` package is not installed") is one hover away
 * while the sentence people read stays human.
 */
export function CredentialLadder({
	auth,
	onStoreToken,
	compact,
}: {
	auth: BackupAuth | null | undefined;
	/** Opens the in-app PAT form. Omitted ⇒ the `pat` rung offers no in-app fix. */
	onStoreToken?: () => void;
	/** Drops the fix rows for rungs that are merely optional (used on the
	 *  configured screen, where the ladder is reference material, not a task). */
	compact?: boolean;
}) {
	const guidance = credentialGuidance(auth);
	const byMethod = new Map((auth?.ladder ?? []).map((r) => [r.method, r]));

	/** `primary` is granted to at most ONE rung — see RungGuidance.recommended. */
	function renderFix(method: AuthMethod, fix: RungFix, primary: boolean) {
		if (fix.kind === "link") {
			return (
				<Button
					size="sm"
					variant={primary ? "primary" : "ghost"}
					icon="arrow-right"
					onClick={() => void openUrl(fix.url ?? "")}
					data-testid={`rung-fix-${method}`}
				>
					{fix.label}
				</Button>
			);
		}
		if (fix.kind === "command") {
			return (
				<CommandChip
					command={fix.command ?? ""}
					label={fix.label}
					testId={`rung-fix-${method}`}
					after={
						/* A second CommandChip, not a bare <code>: the two rendered
						   identically but only the first had a copy button, so the one
						   the user is more likely to fumble typing was the one they had
						   to type. Same component, same affordance. */
						method === "gh" ? (
							<CommandChip
								command={GH_LOGIN_COMMAND}
								label="then"
								testId={`rung-fix-${method}-login`}
							/>
						) : undefined
					}
				/>
			);
		}
		return (
			<Button
				size="sm"
				variant={primary ? "primary" : "ghost"}
				icon="pin"
				onClick={onStoreToken}
				data-testid={`rung-fix-${method}`}
			>
				{fix.label}
			</Button>
		);
	}

	return (
		<div className="cred-ladder">
			{guidance.map((g) => {
				const rung = byMethod.get(g.method);
				const chosen = auth?.method === g.method;
				// An in-app fix without a handler is a button that does nothing.
				const fix = g.fix?.kind === "in-app" && !onStoreToken ? undefined : g.fix;
				const showFix = !!fix && !(compact && g.optional);
				return (
					<div
						key={g.method}
						className="cred-rung"
						data-testid={`auth-rung-${g.method}`}
						data-available={rung?.available ? "true" : "false"}
						data-optional={g.optional ? "true" : undefined}
					>
						<StatusBadge
							channel={rung?.available ? "ok" : "neutral"}
							shape="dot"
							ariaLabel={rung?.available ? "available" : "unavailable"}
						/>
						<div className="cred-rung-main">
							<div className="cred-rung-head">
								<span className="cred-rung-label">{g.label}</span>
								<span className="cred-rung-method">{g.method}</span>
								{/* Violet is the BRAND channel — active/primary/focus — and this
								    is not a control. "The rung we push over" is a fact about a
								    row, so it renders as a neutral outline tag; the green dot to
								    its left already carries the ok/status half. */}
								{chosen && <Tag kind="outline">used for push</Tag>}
								{g.optional && <Tag kind="outline">optional</Tag>}
								{/* When nothing can push, "used for push" and "optional" are
								    both untrue of every row and all three badges vanish —
								    leaving three broken rungs reading as three equally-required
								    things. This is the badge that IS true in that state, and it
								    is the one that ranks them. */}
								{g.recommended && <Tag kind="outline">start here</Tag>}
							</div>
							{/* The CLI's exact words stay reachable as the tooltip — and for
							    the token rung, so does the keychain handle it lives under.
							    That identifier is real and occasionally needed (`security
							    find-generic-password`), it just has no business being in a
							    sentence the user reads. */}
							<div className="cred-rung-human" title={exactDetail(g.method, rung)}>
								{g.human}
							</div>
							{showFix && (
								<div className="cred-rung-fix">
									{renderFix(g.method, fix, g.recommended)}
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
