import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { Icon } from "@/components/Icon";
import { InfoBanner } from "@/components/InfoBanner";
import { ErrorCard } from "@/components/ErrorCard";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { BackupSetupJourney } from "@/components/backup/BackupSetupJourney";
import { CredentialLadder } from "@/components/backup/CredentialLadder";
import { PatForm } from "@/components/backup/PatForm";
import { RestoreDangerZone } from "@/components/backup/RestoreDangerZone";
import {
	useBackupAuth,
	useBackupLogoutPat,
	useBackupNow,
	useBackupSetEnabled,
	useBackupStatus,
} from "@/hooks/useBackup";
import { CommandChip } from "@/components/backup/CommandChip";
import {
	backupHealth,
	backupRefusal,
	backupWarning,
	ghAuthSwitchCommand,
	scrubTokens,
	summarizeBackupResult,
	PRODUCT_NAME,
	relativeTimestamp,
	RESTORE_MODE_HINT,
	type BackupNowResult,
	type SyncReportBackupSlot,
} from "@/lib/backupContract";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useRecoveryStatus } from "@/hooks/useRecovery";
import { useAppStore } from "@/store";

/**
 * The container width at which `.main-header-right .btn .btn-label` is hidden
 * (App.css, `@container appmain (max-width: 480px)`). Kept as a named constant
 * because the compact primary's whole job is to appear exactly when the header
 * primary loses its word — if the two numbers drift, the screen either shows two
 * labelled primaries or none.
 */
const HEADER_LABEL_SHED_PX = 480;

/** One card frame, so every section reads as one system. */
function Card({
	title,
	lede,
	right,
	children,
	tone,
	testId,
}: {
	title: string;
	/** A sentence explaining what the section is for. Sections that only need a
	 *  label are the exception here, not the rule — see DESIGN.md §Empty states. */
	lede?: React.ReactNode;
	right?: React.ReactNode;
	children: React.ReactNode;
	tone?: "danger";
	testId?: string;
}) {
	return (
		<section className="backup-card" data-tone={tone} data-testid={testId}>
			<div className="backup-card-head">
				<div className="backup-card-heading">
					<h3>{title}</h3>
					{lede && <p>{lede}</p>}
				</div>
				{right && <div className="backup-card-right">{right}</div>}
			</div>
			<div className="backup-card-body">{children}</div>
		</section>
	);
}

/**
 * A section the user opens when they want it.
 *
 * Progressive disclosure is the whole point of the configured layout: once a
 * backup works, credential management and restore are maintenance, not the job.
 * They stay one click away instead of competing with "is my backup healthy?".
 */
function Disclosure({
	title,
	hint,
	testId,
	openWhen,
	children,
}: {
	title: string;
	hint?: React.ReactNode;
	testId: string;
	/**
	 * Opens the section for as long as this is true AND the user has not touched
	 * the control. NOT a `defaultOpen`: the signals that justify auto-opening (a
	 * gh-account mismatch, no working credential) arrive with an async query, so
	 * a value read once at mount is `false` on every direct load — and the
	 * section would quietly hide a real problem. Derived-until-touched instead,
	 * so the user's own toggle wins from the moment they make one.
	 */
	openWhen?: boolean;
	children: React.ReactNode;
}) {
	const [userSet, setUserSet] = useState<boolean | null>(null);
	const open = userSet ?? !!openWhen;
	return (
		<section className="backup-disclosure" data-open={open ? "true" : "false"}>
			<button
				type="button"
				className="backup-disclosure-head"
				aria-expanded={open}
				onClick={() => setUserSet(!open)}
				data-testid={testId}
			>
				<Icon name={open ? "chevron-down" : "chevron-right"} size={13} />
				<span className="backup-disclosure-title">{title}</span>
				{hint && <span className="backup-disclosure-hint">{hint}</span>}
			</button>
			{open && <div className="backup-disclosure-body">{children}</div>}
		</section>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="backup-row">
			<span className="backup-row-label">{label}</span>
			<span className="backup-row-value">{children}</span>
		</div>
	);
}

/** Identifiers (paths, URLs, shas, logins) render in mono — see COMPONENTS.md §Type. */
function Mono({ children }: { children: React.ReactNode }) {
	return <span className="backup-mono">{children}</span>;
}

function Dim({ children }: { children: React.ReactNode }) {
	return <span className="backup-dim">{children}</span>;
}

export function BackupScreen() {
	const { data: status, isLoading, error, refetch } = useBackupStatus();
	const { data: auth, isLoading: authLoading } = useBackupAuth();
	const { data: recoveryStatus } = useRecoveryStatus();
	const navigate = useNavigate();
	const addToast = useAppStore((s) => s.addToast);

	const backupNow = useBackupNow();
	const setEnabled = useBackupSetEnabled();
	const logoutPat = useBackupLogoutPat();

	const [patOpen, setPatOpen] = useState(false);
	/**
	 * True once the screen is narrow enough that the header strips button labels
	 * (`@container appmain (max-width: 480px)` in App.css). Measured rather than
	 * declared in CSS alone, because the compact twin of the primary must not
	 * merely be *invisible* at wide widths — a second "Back up now" sitting in
	 * the DOM is a second button to a screen reader, and `aria-hidden` on a
	 * focusable control trades one defect for another. One button exists at a
	 * time. jsdom has no layout, so `width` stays 0 and this stays false.
	 */
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		// Measure the SAME element the container query resolves against
		// (`.app-main` carries `container-name: appmain`), not this screen's body —
		// the body sits inside it behind padding, so measuring it would put the JS
		// threshold and the CSS one at different real widths and open a band where
		// neither primary carries a label.
		const el = bodyRef.current?.closest(".app-main") as HTMLElement | null;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = (w: number) => setCompact(w > 0 && w <= HEADER_LABEL_SHED_PX);
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) measure(entry.contentRect.width);
		});
		ro.observe(el);
		measure(el.getBoundingClientRect().width);
		return () => ro.disconnect();
	}, []);
	const [lastResult, setLastResult] = useState<BackupNowResult | null>(null);
	/** Unconfigured only: the restore fork, hidden until asked for so it never
	 *  competes with the setup journey for the eye. */
	const [restoreInstead, setRestoreInstead] = useState(false);

	// The SAME slot the StatusBar chip escalates on. Reading only `status` here
	// is how "backup refused" became a dead end: the chip shouted about a
	// refusal the screen it linked to had no idea about. One source, both places.
	const { data: syncEnvelope } = useSyncReport();
	const backupSlot = (
		syncEnvelope?.report?.global as unknown as { backup?: SyncReportBackupSlot } | undefined
	)?.backup;

	const warning = useMemo(() => backupWarning(status, backupSlot), [status, backupSlot]);
	const refusal = useMemo(() => backupRefusal(status, backupSlot), [status, backupSlot]);
	/**
	 * THE state source for this screen. The header chip, the health card's
	 * "Cloud copy" row and the StatusBar chip all read this one value — which is
	 * how the screen stopped showing a green "in sync with remote" beside an
	 * error card announcing four failed pushes.
	 */
	const health = useMemo(() => backupHealth(status, backupSlot), [status, backupSlot]);
	const configured = !!status?.configured;
	/** A restore is pending review: pushes are blocked until it's acknowledged. */
	const paused = health.cause === "paused";
	/** An error card is already on screen owning the primary action. */
	const alerting = !!refusal || (warning.level !== "none" && !paused);
	/**
	 * The journey runs until a snapshot actually exists — not merely until a repo
	 * is named. `backup init` succeeding flips `configured`, and if that alone
	 * swapped in the maintenance layout the third stage ("take your first
	 * snapshot") would vanish the instant it became reachable, leaving the user
	 * one step short with no visible primary. One condition, one layout.
	 */
	const setupComplete = configured && !!status?.last_commit;

	async function runBackupNow(vars?: { acknowledgeRestore?: boolean }) {
		try {
			const res = await backupNow.mutateAsync(vars);
			setLastResult(res);
			// One-way action: a pushed snapshot cannot be un-pushed, so this
			// reports rather than offering an undo (unlike the equip flows).
			addToast(res.ok === false || res.error ? "error" : "success", summarizeBackupResult(res));
		} catch (e) {
			addToast("error", `Backup failed — ${scrubTokens(e)}`);
		}
	}

	// ── The palette's "Back up now" ──────────────────────────────────────────
	//
	// The request is carried in the navigation's `state`, not in the URL, and is
	// consumed exactly once. Three properties, each of which the previous
	// param-only + mount-ref version got wrong:
	//
	// 1. A push is never fired by a URL. `?now=1` is stripped IMMEDIATELY —
	//    before the status guard, before anything can await — and never triggers
	//    a run by itself, so a reload, a bookmark, or a shared link cannot make
	//    the app publish a snapshot unattended.
	// 2. Re-invoking the palette while already on /backup runs again: the effect
	//    keys off `location.key`, which a fresh push changes, rather than a
	//    mount-once ref that only ever fires on the first visit.
	// 3. The consumed request survives a slow `backup_status`: it is parked in
	//    state and fired by a second effect once the status resolves (firing
	//    against an unconfigured setup would just error).
	const [searchParams, setSearchParams] = useSearchParams();
	const location = useLocation();
	const [pendingRun, setPendingRun] = useState(false);

	useEffect(() => {
		const requested =
			(location.state as { backupNow?: boolean } | null | undefined)?.backupNow === true;
		if (searchParams.get("now") === "1" || requested) {
			// Strip the param AND the state: history state survives a reload in a
			// real browser, so leaving it would re-arm this on every refresh.
			setSearchParams({}, { replace: true, state: null });
		}
		if (requested) setPendingRun(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [location.key]);

	useEffect(() => {
		if (!pendingRun || !status) return;
		setPendingRun(false);
		if (status.configured) void runBackupNow();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingRun, status]);

	async function toggleEnabled(next: boolean) {
		try {
			await setEnabled.mutateAsync(next);
			addToast("success", next ? "Automatic backup on" : "Automatic backup off");
		} catch (e) {
			addToast("error", `Couldn't change the backup setting — ${e}`);
		}
	}

	/**
	 * THE screen's one primary action, in two renderings.
	 *
	 * `compact` is the same button with `data-testid` suffixed and full width,
	 * shown only under the container width at which the header strips every
	 * button label (`@container appmain (max-width: 480px)`). At 520px the header
	 * primary collapses to a bare ⚡ glyph while the card below it says "then use
	 * **Acknowledge & back up** above" — copy naming a control that no longer
	 * carries a name. The action stays reachable AND labelled instead.
	 *
	 * One builder rather than two call sites so the two can never drift into
	 * offering different verbs, or into one of them forgetting `busy`.
	 */
	function headerPrimary(compact = false) {
		if (!setupComplete) return undefined;
		const suffix = compact ? "-compact" : "";
		if (paused) {
			/* While a restore is pending, plain "Back up now" cannot push — only
			   `--acknowledge-restore` can. The working action takes the header's
			   one violet slot; the ghost is demoted into the banner that explains
			   why it is off. */
			return (
				<Button
					variant="primary"
					icon="apply"
					size={compact ? "lg" : "md"}
					busy={backupNow.isPending}
					onClick={() => void runBackupNow({ acknowledgeRestore: true })}
					data-testid={`acknowledge-restore${suffix}`}
				>
					Acknowledge &amp; back up
				</Button>
			);
		}
		/* Demoted while an error card OR the inline token form is on screen: each
		   of those owns the single primary ("Retry backup", "Store token"), and
		   two violet buttons split the eye at exactly the moment there is one
		   thing to do. With the PAT form open the header verb is also simply wrong
		   for the task in hand — the user is storing a credential, not publishing
		   a snapshot. */
		return (
			<Button
				variant={alerting || patOpen ? "ghost" : "primary"}
				icon="sync"
				size={compact ? "lg" : "md"}
				busy={backupNow.isPending}
				onClick={() => void runBackupNow()}
				data-testid={`backup-now${suffix}`}
			>
				Back up now
			</Button>
		);
	}

	if (error) {
		return (
			<>
				<ScreenHeader
					icon="save"
					title="Backup"
					subline="Couldn't read the backup status"
				/>
				<div className="main-body backup-screen-body">
					<ErrorCard
						title="Cannot read backup status"
						description={String(error)}
						actions={<Button onClick={() => void refetch()}>Retry</Button>}
					/>
				</div>
			</>
		);
	}

	const patAvailable = auth?.pat_available ?? status?.auth?.pat_available ?? false;

	const credentialSection = (
		<>
			{/* Scoped to what it actually affects. `gh` is only ever used to CREATE
			    the repo — pushing goes over whichever rung `auth.method` resolved
			    to — so this is a warning about one future action, not an
			    explanation for a failing push. Pairing it with push failures sent
			    people to switch accounts over a rejected credential. */}
			{status?.auth?.gh_account_mismatch && (
				<div role="alert" className="backup-alert" data-testid="gh-account-mismatch">
					<strong>Wrong GitHub account for creating repos.</strong> This backup was set up as{" "}
					<Mono>{status.auth.gh_login}</Mono> but <code>gh</code> is signed in as{" "}
					<Mono>{status.auth.gh_active_login}</Mono>. Pushing is unaffected — only repo
					creation would use the wrong account. Switch first:
					<div className="backup-alert-cmd">
						<CommandChip command={ghAuthSwitchCommand(status.auth.gh_login ?? "")} />
					</div>
				</div>
			)}

			{authLoading && <Dim>Checking your credentials…</Dim>}

			<CredentialLadder
				auth={auth}
				compact
				onStoreToken={auth?.keyring_available === false ? undefined : () => setPatOpen(true)}
			/>

			{auth && !auth.method && (
				<InfoBanner>
					No credential works yet — snapshots are committed on this machine but never reach
					GitHub. Fix any one of the rows above and pushing resumes.
				</InfoBanner>
			)}

			{/* PRODUCT TERMS, not a stack trace. This read "Token storage is
			    unavailable: the `keyring` package is not installed. Use an SSH key
			    or `gh` instead." — literal backticks sitting in sans prose, a
			    Python package name offered as the explanation, and a bare `gh` as
			    the remedy. None of those three names anything the user can act on.
			    The exact reason is not lost: it is the row's own detail line and
			    stays one hover away on the `pat` rung, where it belongs. */}
			{auth && !auth.keyring_available && (
				<InfoBanner>
					<span data-testid="pat-unavailable">
						This machine can't store a token securely, so {PRODUCT_NAME} won't offer to keep
						one. Push with an SSH key or the GitHub CLI instead — both are set up in the
						rows above.
					</span>
				</InfoBanner>
			)}

			<div className="backup-actions">
				{auth?.keyring_available !== false && !patOpen && (
					<Button icon="pin" onClick={() => setPatOpen(true)} data-testid="open-pat-form">
						{patAvailable ? "Replace token" : "Store a token"}
					</Button>
				)}
				{patAvailable && (
					<Button
						icon="trash"
						busy={logoutPat.isPending}
						onClick={async () => {
							try {
								await logoutPat.mutateAsync();
								addToast("success", "Token removed from your keychain");
							} catch (e) {
								addToast("error", `Couldn't remove the token — ${e}`);
							}
						}}
						data-testid="logout-pat"
					>
						Remove token
					</Button>
				)}
			</div>

			{patOpen && <PatForm onClose={() => setPatOpen(false)} />}
		</>
	);

	return (
		<>
			<ScreenHeader
				icon="save"
				title="Backup"
				/* STATE-NEUTRAL. "Your library is snapshotted to a private git repo"
				   asserts the remote copy is current — printed above an error card
				   reporting four rejected pushes, or beside a paused chip, it is the
				   screen contradicting itself in its own subtitle. The health chip and
				   the Cloud-copy row own whether the claim currently holds; this line
				   only says what the feature is for. */
				subline={
					setupComplete
						? `Snapshots of your ${PRODUCT_NAME} library, kept in a private git repo you own.`
						: `Snapshot your ${PRODUCT_NAME} library to a private git repo, and restore it on another machine.`
				}
				state={
					setupComplete ? (
						// COMPACT on purpose: the health card owns the full sentence
						// ("in sync with remote"). Spelling it twice on one screen taught
						// people to read neither copy — and made the two surfaces able to
						// disagree. Same `health`, shorter words.
						<FreshnessBadge
							state={health.state}
							label={health.short}
							title={health.label}
						/>
					) : undefined
				}
					/* At compact width the header can only render a bare glyph with no
				   accessible name, so the labelled twin in the body takes over
				   entirely rather than sitting beside a mute duplicate. */
				primary={compact ? undefined : headerPrimary()}
			/>

			<div
				className="main-body backup-screen-body"
				data-testid="backup-screen"
				ref={bodyRef}
			>
				{isLoading && <Dim>Loading backup status…</Dim>}

				{/* The labelled twin of the header primary — see `headerPrimary`.
				    Rendered only when the header has actually shed its labels, so
				    there is never a duplicate button in the accessibility tree. */}
				{setupComplete && compact && (
					<div className="backup-compact-action" data-testid="backup-compact-action">
						{headerPrimary(true)}
					</div>
				)}

				{/* ── pending_reconcile: the one banner that blocks pushes ── */}
				{status?.pending_reconcile && (
					<div role="alert" className="backup-banner" data-testid="pending-reconcile-banner">
						<div className="backup-banner-head">
							<Icon name="warning" size={14} />
							Restore pending review
						</div>
						<p>
							A restore ran on this machine, so backups will <strong>commit but not push</strong>{" "}
							— this stops a half-restored state from overwriting the good snapshot in the
							cloud. Review your skills, projects, and permissions, then use{" "}
							<strong>Acknowledge &amp; back up</strong> above to resume pushing.
						</p>
						{/* The ghost of the action that no longer works, kept VISIBLE and
						    inert rather than silently removed: "Back up now" is what the
						    user's hand reaches for, and a button that vanished is a
						    question ("did I break something?") the disabled one answers.
						    `--acknowledge-restore` is the only thing that clears
						    `pending_reconcile`, and it lives in the header slot. */}
						<div className="backup-banner-inert">
							<Button
								icon="sync"
								disabled
								disabledReason="Paused — a restore is pending review. Acknowledge it to resume pushing."
								data-testid="backup-now-paused"
							>
								Back up now
							</Button>
							{/* The reason, ON the row rather than only in a tooltip. A
							    disabled control whose explanation needs a hover is a
							    control that explains nothing on a touch screen, in a
							    screenshot, or to anyone who does not think to hover. */}
							<span className="backup-banner-inert-why">
								Paused until the restore is acknowledged.
							</span>
						</div>
					</div>
				)}

				{/* ── Unfinished recovery reopen ── A restore applied but sources,
				    project checkouts, or local-only skills still need attention
				    (F2). This must stay reachable after the user leaves the
				    onboarding wizard — Backup is the other place a "restore" verb
				    already lives. */}
				{recoveryStatus && (recoveryStatus.needsRecovery ||
					(!!recoveryStatus.restoredFrom && (
						recoveryStatus.projects.some((row) => !row.attached) ||
						recoveryStatus.sources.some((row) => !row.healthy) || recoveryStatus.localSources.some((row) => row.status !== "ready")
					))) && (
					<div role="status" className="backup-banner" data-testid="recovery-reopen-banner">
						<div className="backup-banner-head">
							<Icon name="sync" size={14} />
							Finish setup from your last restore
						</div>
						<p>
							The library restored, but skill sources, project checkouts, or local-only skills
							still need attention.
						</p>
						<Button
							icon="sync"
							onClick={() => navigate("/recovery")}
							data-testid="recovery-reopen-btn"
						>
							Finish setup
						</Button>
					</div>
				)}

				{/* ── A REFUSED publish is not a failed one ──
				    Hub found credential-shaped material and fail-CLOSED: nothing
				    was pushed, and "Retry backup" would refuse again, identically.
				    The only way forward is to look at the finding and either fix it
				    or acknowledge that specific blob by digest — so this card says
				    what was refused and hands over the two commands that do it. */}
				{refusal && (
					<div className="backup-alert-card" data-testid="backup-refused">
						<ErrorCard
							title="Backup refused — nothing was published"
							description={
								<>
									{PRODUCT_NAME} found{" "}
									{refusal.kind === "prefix_leak"
										? "a machine-specific path prefix"
										: "credential-shaped material"}{" "}
									in the snapshot and stopped before pushing. The local repo is untouched and
									the remote still holds the last good snapshot.
									{refusal.detail ? (
										<div className="backup-refusal-detail">{scrubTokens(refusal.detail)}</div>
									) : null}
								</>
							}
							cmd={<span style={{ fontFamily: "var(--font-mono)" }}>hub backup now</span>}
							fix={[
								<>
									Run <code>hub backup now</code> in a terminal — it prints every finding with
									its file, line, and sha256.
								</>,
								<>
									Remove the secret (or scrub the path) and back up again — this is the right
									answer almost always.
								</>,
								<>
									If the finding is a false positive, acknowledge that exact blob:{" "}
									<code>hub backup now --allow-secret &lt;sha&gt;</code>. It is recorded in the
									registry, so it stays acknowledged.
								</>,
							]}
						/>
					</div>
				)}

				{/* Anchored at the TOP of the body flow. `ErrorCard`'s default frame is
				    `margin: 80px auto; max-width: 540px` — a full-screen failure
				    surface. Used as a banner above live content it left ~150px of
				    dead space between the header and the only thing that mattered,
				    with the health card pushed below the fold. */}
				{alerting && !refusal && (
					<div className="backup-alert-card">
						<ErrorCard
							title={warning.label}
							description={warning.detail}
							// A rejected push is a CREDENTIAL problem, so the remedy is the
							// credential ladder — not the `gh auth switch` command, which
							// only ever affects repo creation.
							fix={
								health.cause === "push-failures"
									? [
											<>
												Check the credential this machine pushes with — open{" "}
												<strong>How this machine signs in to GitHub</strong> below.
											</>,
											<>
												A rejected push means the SSH key or stored token GitHub sees is
												wrong or expired. Add a working SSH key, or store a fresh
												fine-grained token.
											</>,
											<>Then retry — a successful push resets the failure count.</>,
										]
									: undefined
							}
							actions={
								<Button
									variant="primary"
									icon="sync"
									busy={backupNow.isPending}
									onClick={() => void runBackupNow()}
									data-testid="backup-retry"
								>
									Retry backup
								</Button>
							}
						/>
					</div>
				)}

				{/* ══ NOT YET BACKED UP: the guided journey ═════════════════════ */}
				{!setupComplete && !isLoading && (
					<>
						<div className="backup-lede" data-testid="backup-setup-lede">
							<h2>Let's get your library backed up</h2>
							<p>
								Three steps. {PRODUCT_NAME} snapshots your registry, skills, MCP servers,
								snippets, connectors, and sub-agents into a private git repo you own — then
								keeps it current after every sync.
							</p>
						</div>

						<BackupSetupJourney
							status={status}
							auth={auth}
							authLoading={authLoading}
							onFirstBackup={() => void runBackupNow()}
							firstBackupBusy={backupNow.isPending}
							lastResult={lastResult}
						/>

						{/* The wizard's fork, which this screen never offered: someone
						    arriving on a fresh machine wants to PULL, not push. Only
						    while nothing is configured — once a repo is named, restore
						    is maintenance and belongs behind the disclosure. */}
						{!configured && (
							<div className="backup-fork" data-testid="backup-restore-fork">
								<div className="backup-fork-copy">
									<h3>Already have a backup from another machine?</h3>
									<p>Restore it instead — it lays your whole library down here.</p>
								</div>
								<Button
									icon="fetch"
									onClick={() => setRestoreInstead((v) => !v)}
									data-testid="backup-restore-fork-toggle"
								>
									{restoreInstead ? "Hide restore" : "Restore a backup"}
								</Button>
							</div>
						)}

						{/* Expanding a card BELOW the fold moves nothing into view on its
						    own — the user clicks "Restore a backup" and, at 768px and
						    under, watches the page not change. */}
						{!configured && restoreInstead && <RestoreDangerZone revealOnMount />}
					</>
				)}

				{/* ══ BACKED UP: health first, maintenance behind disclosure ══ */}
				{setupComplete && (
					<>
						<Card
							title="Backup health"
							lede="Where your snapshots go, and how current the copy on GitHub is."
							testId="backup-health"
							right={
								<label className="backup-auto-toggle">
									<Toggle
										checked={!!status?.enabled}
										onChange={(v) => void toggleEnabled(v)}
										variant="switch"
										size="sm"
										ariaLabel="Automatic backup after each sync"
										disabled={setEnabled.isPending}
									/>
									<span>
										{status?.enabled ? "Backs up after each sync" : "Automatic backup off"}
									</span>
								</label>
							}
						>
							<Row label="Last snapshot">
								{status?.last_commit ? (
									<>
										<span>{status.last_commit.subject}</span>{" "}
										<Dim>
											· <Mono>{status.last_commit.sha.slice(0, 12)}</Mono> ·{" "}
											{/* Relative + local; the exact UTC instant stays on the
											    tooltip, where it is useful for a diagnosis rather
											    than in the way of "is this recent?". */}
											<span title={status.last_commit.ts}>
												{relativeTimestamp(status.last_commit.ts)}
											</span>
										</Dim>
									</>
								) : (
									<Dim>no snapshot committed yet</Dim>
								)}
							</Row>
							{/* The full sentence lives HERE (the header chip is the short
							    form of the same `health`) — one surface owns the words. */}
							<Row label="Cloud copy">
								<FreshnessBadge state={health.state} label={health.label} />
							</Row>
							<Row label="Repository">
								{status?.remote ? (
									<Mono>{status.remote}</Mono>
								) : (
									<Dim>none — snapshots stay on this machine</Dim>
								)}
							</Row>
							<Row label="Branch">
								{status?.branch ? <Mono>{status.branch}</Mono> : <Dim>—</Dim>}
							</Row>
							{/* "Local clone" invited the reading that this is a checkout of
							    the remote you could throw away. It is the working copy the
							    snapshots are BUILT in — and its path is whatever `backup.dir`
							    says, not a fixed default. */}
							<Row label="Local working copy">
								<Mono>{status?.dir}</Mono>
							</Row>
							{typeof status?.push_failures === "number" && status.push_failures > 0 && (
								<Row label="Push failures">
									{/* Red, at any count: `backupHealth` puts a single failed push
									    in the ERROR channel, so a neutral count here would be the
									    same green/red disagreement one row up. */}
									<span style={{ color: "var(--red)" }}>
										<Mono>{status.push_failures}</Mono> consecutive
									</span>
									{status.last_push_error && <Dim> · {status.last_push_error}</Dim>}
								</Row>
							)}

							{lastResult && (
								<div className="backup-result" data-testid="backup-result">
									{summarizeBackupResult(lastResult)}
								</div>
							)}

							{/* `InfoBanner` is the BLUE informational channel. A warning that
							    restates a fact the error card and the push-failures row above
							    already own is the same fact told a fourth time, in the wrong
							    colour. `backup.py` no longer emits that one; anything left
							    here is genuinely new information. */}
							{(status?.warnings ?? []).map((w) => (
								<InfoBanner key={w}>{w}</InfoBanner>
							))}
						</Card>

						<Disclosure
							title="How this machine signs in to GitHub"
							hint={
								auth?.method ? (
									<>
										via <span className="hint-mono">{auth.method}</span>
									</>
								) : (
									"no credential"
								)
							}
							testId="backup-credential-disclosure"
							openWhen={!!status?.auth?.gh_account_mismatch || (!!auth && !auth.method)}
						>
							{credentialSection}
						</Disclosure>

						{/* Mode-neutral, and drawn from the same constant as the mode
						    picker inside — see RESTORE_MODE_HINT. */}
						<Disclosure
							title="Restore from a snapshot"
							hint={RESTORE_MODE_HINT}
							testId="backup-restore-disclosure"
						>
							{/* The disclosure row IS the heading. The card repeating
							    "Restore from a snapshot" ~80px lower read as two sections at
							    520px, where the two titles stack. */}
							<RestoreDangerZone headingLevel="none" />
						</Disclosure>
					</>
				)}
			</div>
		</>
	);
}
