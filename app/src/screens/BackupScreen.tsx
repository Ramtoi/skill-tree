import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { InfoBanner } from "@/components/InfoBanner";
import { ErrorCard } from "@/components/ErrorCard";
import { StatusBadge } from "@/components/StatusBadge";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { EmptyState } from "@/components/EmptyState";
import { RestoreDangerZone } from "@/components/backup/RestoreDangerZone";
import {
	useBackupAuth,
	useBackupLoginPat,
	useBackupLogoutPat,
	useBackupNow,
	useBackupSetEnabled,
	useBackupStatus,
} from "@/hooks/useBackup";
import {
	backupRefusal,
	backupWarning,
	driftFreshness,
	scrubTokens,
	summarizeBackupResult,
	PUSH_FAILURE_ALERT_THRESHOLD,
	type AuthRung,
	type BackupNowResult,
	type SyncReportBackupSlot,
} from "@/lib/backupContract";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useAppStore } from "@/store";

/** One card frame, so the four sections read as one system. */
function Card({
	title,
	right,
	children,
	tone,
}: {
	title: string;
	right?: React.ReactNode;
	children: React.ReactNode;
	tone?: "danger";
}) {
	return (
		<section
			className="backup-card"
			data-tone={tone}
			style={{
				border: `1px solid ${tone === "danger" ? "var(--red)" : "var(--bg-3)"}`,
				borderRadius: "var(--radius-lg, 10px)",
				background: "var(--bg-1)",
				padding: 16,
				marginBottom: 16,
			}}
		>
			<SectionHeader label={title} right={right} />
			<div style={{ marginTop: 12 }}>{children}</div>
		</section>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "minmax(90px, 140px) 1fr",
				gap: 12,
				padding: "5px 0",
				alignItems: "baseline",
			}}
		>
			<span style={{ fontSize: 12, color: "var(--fg-mute)" }}>{label}</span>
			<span style={{ fontSize: 12.5, color: "var(--fg-mid)", minWidth: 0 }}>{children}</span>
		</div>
	);
}

/** Identifiers (paths, URLs, shas, logins) render in mono — see COMPONENTS.md §Type. */
function Mono({ children }: { children: React.ReactNode }) {
	return (
		<span
			style={{
				fontFamily: "var(--font-mono)",
				color: "var(--fg-strong)",
				wordBreak: "break-all",
			}}
		>
			{children}
		</span>
	);
}

function Dim({ children }: { children: React.ReactNode }) {
	return <span style={{ color: "var(--fg-dim)" }}>{children}</span>;
}

/** One rung of the credential ladder. `detail` is rendered verbatim — it is the
 *  CLI's own reason string, and paraphrasing it would lose the actionable part
 *  (e.g. "the `keyring` package is not installed"). */
function LadderRung({ rung, chosen }: { rung: AuthRung; chosen: boolean }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "baseline",
				gap: 10,
				padding: "6px 0",
				borderBottom: "1px solid var(--bg-2)",
			}}
			data-testid={`auth-rung-${rung.method}`}
		>
			<StatusBadge
				channel={rung.available ? "ok" : "neutral"}
				shape="dot"
				ariaLabel={rung.available ? "available" : "unavailable"}
			/>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 12,
					width: 34,
					color: rung.available ? "var(--fg-strong)" : "var(--fg-dim)",
				}}
			>
				{rung.method}
			</span>
			<span style={{ fontSize: 12, color: "var(--fg-mid)", flex: 1, minWidth: 0 }}>
				{rung.detail}
			</span>
			{chosen && <Tag color="var(--violet)">used for push</Tag>}
		</div>
	);
}

export function BackupScreen() {
	const { data: status, isLoading, error, refetch } = useBackupStatus();
	const { data: auth, isLoading: authLoading } = useBackupAuth();
	const addToast = useAppStore((s) => s.addToast);

	const backupNow = useBackupNow();
	const setEnabled = useBackupSetEnabled();
	const loginPat = useBackupLoginPat();
	const logoutPat = useBackupLogoutPat();

	// PAT input is COMPONENT-LOCAL and cleared the instant it is submitted. It
	// never reaches the Zustand store, a react-query cache entry, a toast, or a
	// log line — the token's only journey is: this field → Tauri arg → child
	// stdin. (The Rust side additionally scrubs token patterns from any output.)
	const [pat, setPat] = useState("");
	const [patOpen, setPatOpen] = useState(false);

	const [lastResult, setLastResult] = useState<BackupNowResult | null>(null);

	// The SAME slot the StatusBar chip escalates on. Reading only `status` here
	// is how "backup refused" became a dead end: the chip shouted about a
	// refusal the screen it linked to had no idea about. One source, both places.
	const { data: syncEnvelope } = useSyncReport();
	const backupSlot = (
		syncEnvelope?.report?.global as unknown as { backup?: SyncReportBackupSlot } | undefined
	)?.backup;

	const warning = useMemo(() => backupWarning(status, backupSlot), [status, backupSlot]);
	const refusal = useMemo(() => backupRefusal(status, backupSlot), [status, backupSlot]);
	const drift = useMemo(() => driftFreshness(status), [status]);
	const configured = !!status?.configured;

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

	async function submitPat(e: React.FormEvent) {
		e.preventDefault();
		const token = pat;
		// Clear FIRST so the value is gone from component state even if the
		// await below throws.
		setPat("");
		setPatOpen(false);
		try {
			await loginPat.mutateAsync(token);
			addToast("success", "Token stored in the OS keychain");
		} catch (err) {
			// The Rust layer scrubs its own output; this is the belt to that
			// braces — a rejection from anywhere else must not print a token.
			addToast("error", `Couldn't store the token — ${scrubTokens(err)}`);
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
	//    against an unconfigured hub would just error).
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
			addToast("success", next ? "Backup enabled" : "Backup disabled");
		} catch (e) {
			addToast("error", `Couldn't change backup state — ${e}`);
		}
	}

	if (error) {
		return (
			<div className="screen">
				<ScreenHeader title="Backup" />
				<div style={{ padding: 24 }}>
					<ErrorCard
						title="Cannot read backup status"
						description={String(error)}
						actions={<Button onClick={() => void refetch()}>Retry</Button>}
					/>
				</div>
			</div>
		);
	}

	const patAvailable = auth?.pat_available ?? status?.auth?.pat_available ?? false;

	return (
		<div className="screen" data-testid="backup-screen">
			<ScreenHeader
				title="Backup"
				subline="Snapshot your hub to a private git repo, and restore it on another machine."
				state={
					configured ? (
						<FreshnessBadge state={drift.state} label={drift.label} />
					) : undefined
				}
				primary={
					configured ? (
						<Button
							variant="primary"
							icon="sync"
							busy={backupNow.isPending}
							onClick={() => void runBackupNow()}
						>
							Back up now
						</Button>
					) : undefined
				}
			/>

			<div className="screen-body" style={{ padding: 24, overflow: "auto" }}>
				{isLoading && <Dim>Loading backup status…</Dim>}

				{/* ── pending_reconcile: the one banner that blocks pushes ── */}
				{status?.pending_reconcile && (
					<div
						role="alert"
						data-testid="pending-reconcile-banner"
						style={{
							border: "1px solid var(--amber)",
							borderRadius: "var(--radius-lg, 10px)",
							background: "var(--bg-1)",
							padding: 14,
							marginBottom: 16,
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								color: "var(--amber)",
								fontSize: 13,
								fontWeight: 600,
							}}
						>
							<Icon name="warning" size={14} />
							Restore pending reconcile
						</div>
						<p style={{ margin: "8px 0 12px", fontSize: 12.5, color: "var(--fg-mid)", lineHeight: 1.5 }}>
							A restore ran on this machine, so backups will <strong>commit but not
							push</strong> — this stops a half-restored state from overwriting the good
							snapshot in the cloud. Review your skills, projects, and permissions, then
							acknowledge to resume pushing.
						</p>
						{/* `--acknowledge-restore` is what actually clears
						    `pending_reconcile`; without the flag this button was a
						    plain backup that left the banner (and the block) in place. */}
						<Button
							icon="apply"
							busy={backupNow.isPending}
							onClick={() => void runBackupNow({ acknowledgeRestore: true })}
							data-testid="acknowledge-restore"
						>
							Acknowledge &amp; back up
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
					<div style={{ marginBottom: 16 }} data-testid="backup-refused">
						<ErrorCard
							title="Backup refused — nothing was published"
							description={
								<>
									Hub found{" "}
									{refusal.kind === "prefix_leak"
										? "a machine-specific path prefix"
										: "credential-shaped material"}{" "}
									in the snapshot and stopped before pushing. The local repo is
									untouched and the remote still holds the last good snapshot.
									{refusal.detail ? (
										<div
											style={{
												marginTop: 8,
												fontFamily: "var(--font-mono)",
												color: "var(--fg-strong)",
												wordBreak: "break-all",
											}}
										>
											{scrubTokens(refusal.detail)}
										</div>
									) : null}
								</>
							}
							cmd={<span style={{ fontFamily: "var(--font-mono)" }}>hub backup now</span>}
							fix={[
								<>
									Run <code>hub backup now</code> in a terminal — it prints every finding
									with its file, line, and sha256.
								</>,
								<>
									Remove the secret (or scrub the path) and back up again — this is the
									right answer almost always.
								</>,
								<>
									If the finding is a false positive, acknowledge that exact blob:{" "}
									<code>hub backup now --allow-secret &lt;sha&gt;</code>. It is recorded in
									the registry, so it stays acknowledged.
								</>,
							]}
						/>
					</div>
				)}

				{warning.level !== "none" && !status?.pending_reconcile && !refusal && (
					<div style={{ marginBottom: 16 }}>
						<ErrorCard
							title={warning.label}
							description={warning.detail}
							actions={
								<Button busy={backupNow.isPending} onClick={() => void runBackupNow()}>
									Retry backup
								</Button>
							}
						/>
					</div>
				)}

				{!configured && !isLoading && (
					<EmptyState
						icon="source"
						title="Backup isn't set up yet"
						description="Point Skill Tree at a private git repo and it will snapshot your registry, skills, MCP servers, snippets, connectors, and sub-agents after every sync."
					/>
				)}

				{/* ── Repo card ── */}
				{configured && (
					<Card
						title="Repository"
						right={
							<label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
								<Toggle
									checked={!!status?.enabled}
									onChange={(v) => void toggleEnabled(v)}
									variant="switch"
									size="sm"
									ariaLabel="Automatic backup after each sync"
									disabled={setEnabled.isPending}
								/>
								<span style={{ color: "var(--fg-mid)" }}>
									{status?.enabled ? "Backs up after each sync" : "Automatic backup off"}
								</span>
							</label>
						}
					>
						<Row label="Local repo">
							<Mono>{status?.dir}</Mono>
						</Row>
						<Row label="Remote">
							{status?.remote ? <Mono>{status.remote}</Mono> : <Dim>none — snapshots stay local</Dim>}
						</Row>
						<Row label="Branch">
							{status?.branch ? <Mono>{status.branch}</Mono> : <Dim>—</Dim>}
						</Row>
						<Row label="Last snapshot">
							{status?.last_commit ? (
								<>
									<Mono>{status.last_commit.sha.slice(0, 12)}</Mono>{" "}
									<span>{status.last_commit.subject}</span>{" "}
									<Dim>· {status.last_commit.ts}</Dim>
								</>
							) : (
								<Dim>no snapshot committed yet</Dim>
							)}
						</Row>
						<Row label="Drift">
							<FreshnessBadge state={drift.state} label={drift.label} />
						</Row>
						{typeof status?.push_failures === "number" && status.push_failures > 0 && (
							<Row label="Push failures">
								{/* Amber is provenance/severity, never staleness. A run of
								    failures below the alert threshold is a neutral count;
								    at the threshold it is a real error, so it uses the
								    status channel's red — same grammar as the chip. */}
								<span
									style={{
										color:
											status.push_failures >= PUSH_FAILURE_ALERT_THRESHOLD
												? "var(--red)"
												: "var(--fg-mid)",
									}}
								>
									<span style={{ fontFamily: "var(--font-mono)" }}>
										{status.push_failures}
									</span>{" "}
									consecutive
								</span>
								{status.last_push_error && <Dim> · {status.last_push_error}</Dim>}
							</Row>
						)}

						{lastResult && (
							<div
								data-testid="backup-result"
								style={{
									marginTop: 12,
									padding: 10,
									borderRadius: 6,
									background: "var(--bg-2)",
									fontSize: 12,
									color: "var(--fg-mid)",
								}}
							>
								{summarizeBackupResult(lastResult)}
							</div>
						)}

						{(status?.warnings ?? []).map((w) => (
							<InfoBanner key={w} style={{ marginTop: 10 }}>
								{w}
							</InfoBanner>
						))}
					</Card>
				)}

				{/* ── Auth card ── */}
				<Card
					title="GitHub credential"
					right={
						auth?.method ? (
							<Tag color="var(--green)">{auth.method}</Tag>
						) : (
							<Tag color="var(--amber)" kind="outline">
								none
							</Tag>
						)
					}
				>
					{authLoading && <Dim>Checking credentials…</Dim>}

					{status?.auth?.gh_account_mismatch && (
						<div
							role="alert"
							data-testid="gh-account-mismatch"
							style={{
								marginBottom: 12,
								padding: 10,
								borderRadius: 6,
								border: "1px solid var(--amber)",
								fontSize: 12,
								color: "var(--fg-mid)",
								lineHeight: 1.5,
							}}
						>
							<strong style={{ color: "var(--amber)" }}>Wrong GitHub account active.</strong>{" "}
							This backup was configured as <Mono>{status.auth.gh_login}</Mono> but{" "}
							<code>gh</code> is currently signed in as{" "}
							<Mono>{status.auth.gh_active_login}</Mono>. Run{" "}
							<Mono>gh auth switch --user {status.auth.gh_login}</Mono> before creating repos.
						</div>
					)}

					{auth?.ladder?.length ? (
						<div style={{ marginBottom: 12 }}>
							{auth.ladder.map((rung) => (
								<LadderRung key={rung.method} rung={rung} chosen={rung.method === auth.method} />
							))}
						</div>
					) : null}

					{auth && !auth.method && (
						<InfoBanner style={{ marginBottom: 12 }}>
							No usable credential — snapshots will commit locally but never reach GitHub.
							Set up an SSH key, sign in with <code>gh</code>, or store a token below.
						</InfoBanner>
					)}

					{/* Degraded PAT rung: `keyring` missing is a DIFFERENT problem from
					    "no token stored", and the CLI's own reason string says which. */}
					{auth && !auth.keyring_available && (
						<InfoBanner icon="warning" style={{ marginBottom: 12 }}>
							<span data-testid="pat-unavailable">
								Token storage is unavailable: {auth.pat_detail || "the keyring package is not installed"}.
								Use an SSH key or <code>gh</code> instead.
							</span>
						</InfoBanner>
					)}

					{auth?.create_method === null && (
						<Row label="Create repo">
							<Dim>
								needs an authenticated <code>gh</code> CLI — create the repo in your browser,
								then point this screen at it
							</Dim>
						</Row>
					)}

					<div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
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
										addToast("success", "Token removed from the keychain");
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

					{patOpen && (
						<form onSubmit={submitPat} style={{ marginTop: 12 }} data-testid="pat-form">
							<label
								htmlFor="pat-input"
								style={{ fontSize: 12, color: "var(--fg-mute)", display: "block", marginBottom: 6 }}
							>
								Personal access token — fine-grained, single repo, Contents: Read &amp; Write
							</label>
							<input
								id="pat-input"
								type="password"
								value={pat}
								autoComplete="off"
								spellCheck={false}
								placeholder="github_pat_…"
								onChange={(e) => setPat(e.target.value)}
								style={{
									width: "100%",
									maxWidth: 460,
									padding: "7px 10px",
									fontFamily: "var(--font-mono)",
									fontSize: 12,
									background: "var(--bg-0)",
									border: "1px solid var(--bg-3)",
									borderRadius: 6,
									color: "var(--fg-strong)",
								}}
							/>
							<p style={{ fontSize: 11, color: "var(--fg-dim)", margin: "6px 0 10px", lineHeight: 1.5 }}>
								The token goes straight to the OS keychain over standard input — it is never
								written to a file, a command line, or this app's state.
							</p>
							<div style={{ display: "flex", gap: 8 }}>
								<Button
									type="submit"
									variant="primary"
									busy={loginPat.isPending}
									disabled={!pat.trim()}
									disabledReason={!pat.trim() ? "Paste a token first" : undefined}
								>
									Store token
								</Button>
								<Button
									onClick={() => {
										setPat("");
										setPatOpen(false);
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					)}
				</Card>

				{/* ── Restore danger zone ── */}
				<RestoreDangerZone />
			</div>
		</div>
	);
}
