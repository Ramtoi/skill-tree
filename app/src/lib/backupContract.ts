/**
 * The one place the backup/restore **wire contract** is described.
 *
 * Everything here is written against the **real** JSON emitted by `backup.py` /
 * `restore.py` (captured from `hub backup status|auth|now --json` and
 * `hub restore --json` against a synthetic snapshot). The restore payload is
 * `_restore_public(plan)` in `hub.py` — the whole plan minus `resolved_registry`.
 *
 * The restore plan is a *structured* document, not a flat list of consequences:
 * losses live inside `registry.diff.sections`, executable state is three typed
 * arrays under one object, out-of-home writes are the `subagents` / `global_docs`
 * three-way verdicts, and quarantined projects are the `projects` entries with
 * `exists: false`. `toRestorePlan` is the single place that flattens all of it
 * into the shape components render — nothing upstream touches the raw payload.
 *
 * Two shapes of the payload exist and both must be handled:
 *
 * - the **full plan** (integrity passed), and
 * - a **truncated plan** when `fatal: true` — a bad tree digest or a hard trust
 *   refusal returns after `manifest` and nothing else is even inspected, so
 *   `registry` / `projects` / `executable_state` / `report` are simply absent.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Backup status (`hub backup status --json`) — M2, implemented
// ─────────────────────────────────────────────────────────────────────────────

export interface BackupLastCommit {
	sha: string;
	ts: string;
	subject: string;
}

export interface BackupStatusAuth {
	/** The user's configured preference: "auto" | "ssh" | "gh" | "pat". */
	configured: string;
	/** False when the `keyring` lib is missing OR no token is stored. */
	pat_available: boolean;
	/** Human reason for `pat_available: false` — surfaced verbatim, never guessed. */
	pat_detail: string;
	/** The gh account recorded at `init` time. */
	gh_login: string | null;
	/** The gh account active RIGHT NOW. */
	gh_active_login: string | null;
	/** True when the two disagree — pushing would use the wrong GitHub account. */
	gh_account_mismatch: boolean;
}

/** `drift` compares the local backup repo against its remote tip. */
export type BackupDrift = "in-sync" | "ahead" | "behind" | "diverged" | "unknown";

export interface BackupStatus {
	enabled: boolean;
	initialized: boolean;
	configured: boolean;
	dir: string;
	remote: string | null;
	repo: string | null;
	branch: string | null;
	auth: BackupStatusAuth;
	/** Consecutive failed pushes. ≥ PUSH_FAILURE_ALERT_THRESHOLD ⇒ StatusBar warns. */
	push_failures: number;
	last_push_error: string | null;
	/** Set by a restore: `backup now` refuses to PUSH until acknowledged. */
	pending_reconcile: boolean;
	/** When the restore that set it ran. Absent on payloads predating it. */
	pending_reconcile_at?: string | null;
	last_commit: BackupLastCommit | null;
	ahead: number | null;
	behind: number | null;
	drift: BackupDrift;
	manifest: unknown;
	warnings: string[];
	/**
	 * Optional refusal provenance. `backup status --json` did not carry these
	 * when the surface was written — the sync report's `global.backup` slot was
	 * the only source — but `backup.py` is growing them. Every one is read
	 * defensively through [`backupRefusal`] so the adapter tolerates whichever
	 * spelling lands (and none of them at all).
	 */
	error_kind?: string | null;
	error?: string | null;
	last_error?: string | null;
	last_error_kind?: string | null;
}

/**
 * An ISO-8601 UTC stamp as a relative, local phrase — with the exact instant
 * kept for the tooltip.
 *
 * `Last snapshot … 2026-08-04T09:12:44Z` is a log line, not product copy: it
 * makes the reader do timezone arithmetic to answer the only question they
 * actually have ("is this recent?"). The precise value still matters when
 * something is wrong, so it survives verbatim as the title.
 *
 * Returns the input unchanged when it cannot be parsed — a stamp in a shape
 * this does not expect is better shown raw than swallowed.
 */
export function relativeTimestamp(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return "";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const secs = Math.round((now - t) / 1000);
	if (secs < 0) return "just now"; // clock skew — never say "in 3 hours"
	if (secs < 45) return "just now";
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
	// Past a week "37 days ago" stops helping — a local date is more use.
	return new Date(t).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Matches `PUSH_FAILURE_ALERT_THRESHOLD` in backup.py — the point at which a
 *  fail-open miss stops being noise and becomes a StatusBar warning. */
export const PUSH_FAILURE_ALERT_THRESHOLD = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Auth ladder (`hub backup auth --json`) — M2, implemented
// ─────────────────────────────────────────────────────────────────────────────

export type AuthMethod = "ssh" | "gh" | "pat";

export interface AuthRung {
	method: AuthMethod;
	available: boolean;
	/** Why the rung is (un)available — the CLI's own reason string. The UI leads
	 *  with human phrasing and keeps this as the exact-detail line/tooltip, so an
	 *  actionable reason ("the `keyring` package is not installed") never gets
	 *  paraphrased away. */
	detail: string;
	user?: string | null;
	/** `pat` rung only: the keychain handle the token lives under. An internal
	 *  identifier — demoted to a tooltip, never spoken in a sentence. */
	ref?: string | null;
}

export interface BackupAuth {
	/** The rung that will actually be used to PUSH (null = no credential). */
	method: AuthMethod | null;
	configured: string;
	ladder: AuthRung[];
	/** Where the token lives, when one is stored. An INTERNAL identifier — the UI
	 *  demotes it to a tooltip and never puts it in a sentence. */
	pat_ref?: string | null;
	/** False when the optional `keyring` dependency isn't installed at all. */
	keyring_available: boolean;
	pat_available: boolean;
	pat_detail: string;
	gh_login: string | null;
	/** Only `gh` can CREATE a repo; null ⇒ the UI must show manual-create steps. */
	create_method: "gh" | null;
	/** `cmd_backup_auth` stamps this on every reply; unused by the UI. */
	ok?: boolean;
	/** Present only on a `--login-pat` / `--logout` reply. */
	stored?: boolean;
	deleted?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup result (`hub backup now --json`) — M2, implemented
// ─────────────────────────────────────────────────────────────────────────────

export interface BackupNowResult {
	ok: boolean;
	committed: boolean;
	pushed: boolean;
	dir?: string;
	/** "unchanged" when nothing moved since the last snapshot. */
	skipped?: string | null;
	commit?: string | null;
	push_attempted?: boolean;
	push_detail?: string | null;
	/** The credential rung actually used to push; null when none was needed. */
	auth?: string | null;
	conflict?: boolean;
	counts?: Record<string, number>;
	warnings?: string[];
	/** True when `--acknowledge-restore` actually cleared a pending reconcile. */
	acknowledged_restore?: boolean;
	error?: string | null;
	/** "secret_leak" / "prefix_leak" = a fail-CLOSED refusal to publish, which
	 *  is a very different event from an ordinary fail-open network miss. Only
	 *  ever present on the `{ok:false}` bail-out, never on a successful run. */
	error_kind?: string | null;
}

/** Credential prefixes, mirroring `commands/backup.rs::TOKEN_PREFIXES` (and the
 *  Python-side scanner). `github_pat_` FIRST so the longest prefix wins. */
const TOKEN_PREFIXES = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];

/**
 * Second line of defence: strip credential-shaped runs out of anything about to
 * be rendered.
 *
 * The Rust layer scrubs every byte it produces, so in practice this is a no-op —
 * which is exactly why it belongs here. A rejected `fetch`, a thrown
 * `TypeError` carrying a URL, or a future command that forgets the Rust helper
 * would otherwise put a live token into a toast, and a toast is
 * screen-recordable. Cheap, total, and never softens a real message: only the
 * token run is replaced.
 */
export function scrubTokens(input: unknown): string {
	const text = typeof input === "string" ? input : String(input ?? "");
	return text.replace(
		new RegExp(`(?:${TOKEN_PREFIXES.join("|")})[A-Za-z0-9_]+`, "g"),
		"***",
	);
}

/** One-line human summary of a `backup now` result, for the result toast.
 *  A refused publish is never softened into "nothing to do". */
export function summarizeBackupResult(r: BackupNowResult): string {
	if (r.error) {
		return r.error_kind === "secret_leak" || r.error_kind === "prefix_leak"
			? `Refused to publish — ${r.error}`
			: r.error;
	}
	if (r.pushed) return r.push_detail || "Snapshot pushed";
	if (r.conflict) return r.push_detail || "Remote moved — the next backup adopts it";
	if (r.committed) return "Snapshot committed locally (not pushed)";
	return "No changes since the last snapshot";
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived signals (staleness grammar + the StatusBar warning)
// ─────────────────────────────────────────────────────────────────────────────

/** The `global.backup` slot hub.py writes into every sync report. Additive to
 *  `SyncReportGlobal` (schema_version stays 1 — every reader tolerates extra
 *  keys), so the StatusBar can see a failed backup even when the app never
 *  polled `backup_status`. */
export interface SyncReportBackupSlot {
	ran: boolean;
	skipped: string | null;
	committed: boolean;
	pushed: boolean;
	conflict: boolean;
	error: string | null;
	error_kind: string | null;
	at: string | null;
}

/** The two `error_kind` values that mean hub fail-CLOSED and published nothing.
 *  Everything else is an ordinary fail-open miss. */
export const REFUSAL_ERROR_KINDS = new Set(["secret_leak", "prefix_leak"]);

export interface BackupRefusal {
	kind: string;
	/** The finding, in the CLI's own words. May be empty when only the kind is known. */
	detail: string;
	/** Which payload carried it — useful for tests and for wording the card. */
	origin: "sync-report" | "status";
}

/**
 * Did the last backup attempt REFUSE to publish?
 *
 * Two sources may carry the verdict and both are read: the sync report's
 * `global.backup` slot (the original and still the only guaranteed one) and —
 * additively — a top-level `error_kind` on `backup status --json`. The status
 * side is probed under several spellings on purpose: this adapter is the seam
 * against a Python surface that is still growing the field, and an unknown key
 * must degrade to "no refusal known", never to a crash or a false alarm.
 */
export function backupRefusal(
	status: BackupStatus | null | undefined,
	slot?: SyncReportBackupSlot | null,
): BackupRefusal | null {
	const candidates: Array<[unknown, unknown, BackupRefusal["origin"]]> = [
		[slot?.error_kind, slot?.error, "sync-report"],
		[status?.error_kind, status?.error ?? status?.last_error, "status"],
		[status?.last_error_kind, status?.last_error ?? status?.last_push_error, "status"],
	];
	for (const [kind, detail, origin] of candidates) {
		if (typeof kind === "string" && REFUSAL_ERROR_KINDS.has(kind)) {
			return { kind, detail: typeof detail === "string" ? detail : "", origin };
		}
	}
	return null;
}

export type BackupWarningLevel = "none" | "warn" | "danger";

export interface BackupWarning {
	level: BackupWarningLevel;
	label: string;
	/** Longer explanation for the chip's title attribute. */
	detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// backupHealth — the ONE state source behind every backup surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why the backup is in the state it is in. The screen branches on this, never
 * on the raw fields, so the header chip, the health card's "Cloud copy" row and
 * the StatusBar chip cannot disagree about what is true.
 */
export type BackupHealthCause =
	| "unconfigured"
	| "not-initialized"
	| "refused"
	| "paused"
	| "push-failures"
	| "drift"
	| "ok";

export interface BackupHealth {
	/** The `FreshnessBadge` channel. `error` = red, `stale` = neutral hollow
	 *  ring + pulse, `unknown` = dim hollow ring, `fresh` = green. */
	state: "fresh" | "stale" | "unknown" | "error";
	cause: BackupHealthCause;
	/** Compact form for the header chip. Deliberately NOT a prefix of `label`:
	 *  spelling the same sentence twice on one screen is how a reader learns to
	 *  stop reading either copy. */
	short: string;
	/** The full sentence. The health card owns these words. */
	label: string;
	/** The cause in the CLI's own words, for a title attribute / an error card. */
	detail: string;
}

/**
 * The one derivation of "how is this backup doing?".
 *
 * Precedence is the whole point, and it is ordered by how badly the user is
 * currently being lied to:
 *
 * 1. **Refused** — hub found credential-shaped material and published nothing.
 * 2. **Paused** — a restore set `pending_reconcile`; backups commit but do not
 *    push. Neutral, never green: nothing is reaching the cloud.
 * 3. **Failing** — ANY consecutive push failure. The screen used to read green
 *    "in sync with remote" beside an error card announcing four failed pushes,
 *    because drift and failures were two independent derivations. Failing
 *    pushes are the ERROR channel; the neutral hollow-ring `stale` grammar is
 *    reserved for a benign not-recently-pushed-with-no-errors state.
 * 4. **Drift** — only once none of the above applies is the local↔remote
 *    comparison meaningful.
 */
export function backupHealth(
	status: BackupStatus | null | undefined,
	slot?: SyncReportBackupSlot | null,
): BackupHealth {
	if (!status || !status.configured) {
		return {
			state: "unknown",
			cause: "unconfigured",
			short: "not set up",
			label: "not configured",
			detail: "",
		};
	}
	if (!status.initialized) {
		return {
			state: "unknown",
			cause: "not-initialized",
			short: "not set up",
			label: "not initialized",
			detail: "",
		};
	}

	const refusal = backupRefusal(status, slot);
	if (refusal) {
		return {
			state: "error",
			cause: "refused",
			short: "backup refused",
			label: "backup refused — nothing was published",
			detail:
				refusal.detail || `${PRODUCT_NAME} refused to publish the snapshot — review the finding`,
		};
	}

	if (status.pending_reconcile) {
		return {
			state: "unknown",
			cause: "paused",
			short: "paused",
			label: "paused — restore pending review",
			detail:
				"A restore set pending_reconcile: backups commit but do not push until you acknowledge it.",
		};
	}

	// > 0, not >= PUSH_FAILURE_ALERT_THRESHOLD. The threshold governs when the
	// StatusBar chip *appears* (an unread chip is a chip nobody trusts); it has
	// never governed what is TRUE. One failed push already means the cloud copy
	// is behind, so this surface must not paint it green.
	const failures = Number(status.push_failures || 0);
	if (failures > 0) {
		return {
			state: "error",
			cause: "push-failures",
			short: "backup failing",
			label: `backup failing · ${failures} failed push${failures === 1 ? "" : "es"}`,
			// "stale" is the neutral-channel word and is deliberately not reused
			// here, not even in prose — this is the error channel.
			detail:
				status.last_push_error ||
				"consecutive push failures — nothing has reached the cloud since",
		};
	}

	switch (status.drift) {
		case "in-sync":
			return {
				state: "fresh",
				cause: "ok",
				short: "backed up",
				label: "in sync with remote",
				detail: "",
			};
		case "ahead":
			return {
				state: "stale",
				cause: "drift",
				short: "not pushed",
				label: `ahead ${status.ahead ?? "?"} — not pushed`,
				detail: "",
			};
		case "behind":
			return {
				state: "stale",
				cause: "drift",
				short: "behind remote",
				label: `behind ${status.behind ?? "?"} — remote is newer`,
				detail: "",
			};
		case "diverged":
			return {
				state: "error",
				cause: "drift",
				short: "diverged",
				label: `diverged (ahead ${status.ahead ?? "?"}, behind ${status.behind ?? "?"})`,
				detail: "",
			};
		default:
			return {
				state: "unknown",
				cause: "drift",
				short: "local only",
				label: "no remote to compare",
				detail: "",
			};
	}
}

/**
 * The one derivation behind the StatusBar backup chip.
 *
 * Only two conditions surface (design §9): a run of consecutive push failures
 * (the cloud copy is silently stale — fail-open must not mean fail-silent), and
 * `pending_reconcile` (a restore happened and `backup now` is refusing to push
 * until the user acknowledges it). A refused publish (`secret_leak` /
 * `prefix_leak`) from the last sync's tail pass is escalated to `danger`
 * because it means hub found credential-shaped material in the tree.
 *
 * Everything else — backup disabled, never configured, an ordinary "nothing
 * changed" run — is deliberately silent. A chip that is always on is a chip
 * nobody reads.
 */
export function backupWarning(
	status: BackupStatus | null | undefined,
	slot?: SyncReportBackupSlot | null,
): BackupWarning {
	const none: BackupWarning = { level: "none", label: "", detail: "" };
	if (!status || !status.configured) return none;

	// A pass hub skipped because there is nothing set up is not a stale backup.
	// The slot is authoritative about the last run, so this outranks whatever
	// counters a half-configured status still carries — an alarm about a backup
	// the user never asked for is noise, and a chip nobody trusts is a chip
	// nobody reads.
	if (slot?.skipped === "not-configured") return none;

	// Same derivation as the screen — the chip only decides whether the state is
	// loud enough to interrupt, never what the state IS or what it is called.
	const health = backupHealth(status, slot);

	if (health.cause === "refused") {
		return { level: "danger", label: "backup refused", detail: health.detail };
	}

	if (health.cause === "paused") {
		return { level: "warn", label: "backup paused — restore pending", detail: health.detail };
	}

	if (
		health.cause === "push-failures" &&
		Number(status.push_failures || 0) >= PUSH_FAILURE_ALERT_THRESHOLD
	) {
		return { level: "danger", label: health.label, detail: health.detail };
	}

	return none;
}

// `driftFreshness` used to live here — a SECOND exported freshness derivation
// reading only `status.drift`. It is deleted, not deprecated: keeping it would
// leave the exact shape of this bug lying around (two functions that answer
// "how fresh is the backup?" and are free to disagree), and `backupHealth`
// subsumes it entirely. Its drift branch is the same mapping, one layer down.

// ─────────────────────────────────────────────────────────────────────────────
// The guided setup journey
// ─────────────────────────────────────────────────────────────────────────────
//
// Setting a backup up is three things in order — a credential, a repository, a
// first snapshot — and the screen used to show them as three co-equal cards with
// no primary action anywhere. A user with working credentials had no visible
// next step. The stage model below is the one derivation behind the stepper, so
// "what do I do now" has exactly one answer at any moment.

/** User-facing product name. The CLI stays `hub`; the app is Skill Tree. */
export const PRODUCT_NAME = "Skill Tree";

/** Suggested repo name, used for the placeholder AND the pre-filled
 *  `github.com/new` link, so the two can never drift apart. */
export const BACKUP_REPO_NAME = "skill-tree-backup";
/**
 * `owner/name` placeholder for the repo field.
 *
 * The `e.g. ` prefix is load-bearing: a bare `me/skill-tree-backup` in a text
 * input reads as a value that is already filled in — people tabbed past it and
 * then wondered why the button was dead.
 */
export const BACKUP_REPO_PLACEHOLDER = `e.g. me/${BACKUP_REPO_NAME}`;
/** Clone-URL placeholder for the restore source field — same reasoning. */
export const BACKUP_SOURCE_PLACEHOLDER = `e.g. git@github.com:me/${BACKUP_REPO_NAME}.git`;

/**
 * Why this repo string is not usable yet, or `null` when it is.
 *
 * Mirrors `backup.normalize_repo` + `create_github_repo`'s `owner/name` check,
 * so the CLI's refusal is never how the user finds out. A clone URL is called
 * out by name because it is the mistake people actually make here.
 */
export function backupRepoProblem(value: string): string | null {
	let v = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
	if (!v) return "Enter owner/name first";
	if (/^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/i.test(v))
		return "Use owner/name, not a clone URL";
	if (v.toLowerCase().endsWith(".git")) v = v.slice(0, -4);
	if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(v))
		return "Use owner/name — two parts, one slash";
	return null;
}

/** The exact command that repoints `gh` at the account this backup was set up
 *  with. Built in ONE place so it is copyable verbatim and can never lose the
 *  space that JSX interpolation kept eating. */
export function ghAuthSwitchCommand(login: string): string {
	return `gh auth switch --user ${login}`;
}

/** "Create it in your browser" — name pre-filled so the user only picks Private. */
export const GITHUB_NEW_REPO_URL = `https://github.com/new?name=${BACKUP_REPO_NAME}`;
/** GitHub's own SSH-key walkthrough — the fix for a dead `ssh` rung. */
export const GITHUB_SSH_DOCS_URL =
	"https://docs.github.com/en/authentication/connecting-to-github-with-ssh";
/** Fine-grained token page. Scope guidance lives in the copy next to it. */
export const GITHUB_PAT_NEW_URL = "https://github.com/settings/personal-access-tokens/new";

/** Install command for the OPTIONAL `gh` rung. Offered as copyable text — the
 *  app never runs a package manager on the user's behalf. */
export const GH_INSTALL_COMMAND = "brew install gh";
/** …and the sign-in that follows it. */
export const GH_LOGIN_COMMAND = "gh auth login";

export type BackupStageId = "credential" | "repository" | "first-backup";

/** `done` — satisfied; `current` — the one thing to do now; `todo` — later. */
export type BackupStageState = "done" | "current" | "todo";

export interface BackupStage {
	id: BackupStageId;
	/** 1-based, for the numbered pip. */
	n: number;
	/** A question or an instruction, never a bare noun — see DESIGN.md §Empty states. */
	title: string;
	state: BackupStageState;
	/** One line: what this stage achieved (done) or will achieve (current/todo). */
	summary: string;
	/**
	 * True when a REQUIRED earlier stage is unsatisfied, so this one genuinely
	 * cannot be acted on yet.
	 *
	 * Only `first-backup` is ever blocked (there is nowhere to push until a repo
	 * is named). The credential stage is optional — hub commits locally without
	 * one — so `repository` is never blocked, and the UI must keep its field and
	 * its two buttons usable while stage 1 is still red. Collapsing it was what
	 * turned "no credential works" into a screen with a banner saying "you can
	 * still continue" and nothing to continue with.
	 */
	blocked: boolean;
}

/**
 * Derive the three-stage journey from the two payloads the screen already has.
 *
 * Exactly one stage is `current`: the first unsatisfied one. Everything before
 * it is `done`, everything after is `todo`. That invariant is what lets the UI
 * promise "one violet primary action on screen" — the primary lives on the
 * current stage and nowhere else.
 *
 * A missing credential does NOT block the repository stage: hub happily commits
 * snapshots locally without one, and refusing to let someone configure a repo
 * because `ssh -T` failed would be a worse dead end than the one being fixed.
 * It is `current` when unsatisfied, but the later stages stay reachable.
 */
export function backupStages(
	status: BackupStatus | null | undefined,
	auth: BackupAuth | null | undefined,
): BackupStage[] {
	const hasCredential = !!auth?.method;
	// `configured` is hub's own word for "a repo is set"; `remote` is what makes
	// snapshots leave the machine. Either counts as the stage being answered —
	// a deliberately local-only backup is a legitimate configuration.
	const hasRepo = !!status?.configured;
	const hasSnapshot = !!status?.last_commit;

	const satisfied: Record<BackupStageId, boolean> = {
		credential: hasCredential,
		repository: hasRepo,
		"first-backup": hasSnapshot,
	};

	const specs: Array<{ id: BackupStageId; title: string; done: string; todo: string }> = [
		{
			id: "credential",
			title: "Connect your GitHub account",
			done: auth?.method
				? `Ready to push over ${authMethodLabel(auth.method).toLowerCase()}`
				: "Ready to push",
			todo: "Snapshots need one way to reach GitHub — an SSH key, a token, or the gh CLI.",
		},
		{
			id: "repository",
			title: "Choose where snapshots go",
			done: status?.repo || status?.remote || "A private repository is configured",
			todo: "A private git repository, used by nothing else. Empty is perfect.",
		},
		{
			id: "first-backup",
			title: "Take your first snapshot",
			done: status?.last_commit?.subject || "First snapshot taken",
			todo: `${PRODUCT_NAME} captures your skills, bundles, MCP servers, snippets, and sub-agents.`,
		},
	];

	const currentIndex = specs.findIndex((s) => !satisfied[s.id]);
	return specs.map((spec, i) => {
		const state: BackupStageState = satisfied[spec.id]
			? "done"
			: i === currentIndex
				? "current"
				: "todo";
		return {
			id: spec.id,
			n: i + 1,
			title: spec.title,
			state,
			summary: state === "done" ? spec.done : spec.todo,
			// Prerequisites, not position: only the snapshot stage has one, and it
			// is the repo — never the credential.
			blocked: spec.id === "first-backup" && !hasRepo,
		};
	});
}

/** The stage the user should act on, or null once every stage is satisfied. */
export function currentBackupStage(stages: BackupStage[]): BackupStage | null {
	return stages.find((s) => s.state === "current") ?? null;
}

/** Human name for a credential rung. The wire values (`ssh`/`gh`/`pat`) are
 *  identifiers and keep their mono treatment; this is the prose half. */
export function authMethodLabel(method: AuthMethod): string {
	switch (method) {
		case "ssh":
			return "SSH key";
		case "gh":
			return "GitHub CLI";
		case "pat":
			return "Access token";
	}
}

/** What a rung's `fix` offers: a link out, a command to copy, or an in-app form. */
export type RungFixKind = "link" | "command" | "in-app";

export interface RungFix {
	kind: RungFixKind;
	/** Imperative, sentence case: "Add an SSH key to your GitHub account". */
	label: string;
	/** `link` only. */
	url?: string;
	/** `command` only — copyable, rendered in mono. Never auto-run. */
	command?: string;
}

export interface RungGuidance {
	method: AuthMethod;
	label: string;
	/** Prose status line. The CLI's `detail` stays available as exact detail. */
	human: string;
	/**
	 * True when this rung is not needed for the user to succeed — i.e. some
	 * OTHER rung can already push. An optional dead rung is an enhancement to
	 * offer, not a failure to report; that distinction is the whole fix for
	 * "gh CLI not installed" reading as a dead end.
	 */
	optional: boolean;
	/**
	 * The ONE rung to fix first, when nothing can push at all.
	 *
	 * With no working credential every rung is unavailable and none is optional,
	 * so all three rendered identically: three broken rows, three ghost
	 * remedies, no primary — a shape that reads as three equally-required
	 * chores. SSH is the rung the ladder itself calls the push credential, so it
	 * carries the recommendation and the one emphasised button; the other two
	 * stay ghost alternatives.
	 *
	 * Never true while something already works: then "optional" is the honest
	 * word and `chosen` marks the row that matters.
	 */
	recommended: boolean;
	/** Concrete next action when the rung is unavailable. */
	fix?: RungFix;
}

/**
 * Turn one probe result into something a person can act on.
 *
 * The contract: an unavailable rung ALWAYS carries a `fix`. The old screen
 * rendered `gh CLI not installed` in grey with nothing next to it and the
 * greyed line "needs an authenticated gh CLI" underneath — a statement of fact
 * with no verb in sight.
 */
export function rungGuidance(
	rung: AuthRung,
	opts: { anyRungWorks: boolean; keyringAvailable?: boolean } = { anyRungWorks: false },
): RungGuidance {
	const label = authMethodLabel(rung.method);
	const optional = opts.anyRungWorks && !rung.available;
	// Nothing can push ⇒ exactly one rung is the recommended way out.
	const recommended = !opts.anyRungWorks && !rung.available && rung.method === "ssh";

	if (rung.available) {
		const human =
			rung.method === "ssh"
				? `Signed in to GitHub${rung.user ? ` as ${rung.user}` : ""}`
				: rung.method === "gh"
					? `Signed in${rung.user ? ` as ${rung.user}` : ""} — can create the repo for you`
					: "Token stored in your macOS keychain";
		return { method: rung.method, label, human, optional: false, recommended: false };
	}

	switch (rung.method) {
		case "ssh":
			return {
				method: rung.method,
				label,
				human: optional
					? "Not set up — optional, another credential already works"
					: "No SSH key that GitHub accepts — the usual way to push",
				optional,
				recommended,
				fix: {
					kind: "link",
					label: "Add an SSH key to your GitHub account",
					url: GITHUB_SSH_DOCS_URL,
				},
			};
		case "gh":
			return {
				method: rung.method,
				label,
				human: optional
					? "Optional — enables one-click repo creation"
					: "Not installed or not signed in",
				optional,
				recommended: false,
				fix: { kind: "command", label: "Install it, then sign in", command: GH_INSTALL_COMMAND },
			};
		case "pat":
			return {
				method: rung.method,
				label,
				human:
					opts.keyringAvailable === false
						? "Token storage is unavailable on this machine"
						: optional
							? "Optional — a fallback when SSH isn't available"
							: "No token stored yet",
				optional,
				recommended: false,
				// A missing `keyring` library is a different problem from "no token
				// stored", and the in-app form cannot fix it — offering the form
				// would be the dead end all over again.
				fix:
					opts.keyringAvailable === false
						? undefined
						: { kind: "in-app", label: "Store a token" },
			};
	}
}

/** Every rung, in ladder order, already resolved to guidance. */
export function credentialGuidance(auth: BackupAuth | null | undefined): RungGuidance[] {
	const ladder = auth?.ladder ?? [];
	const anyRungWorks = ladder.some((r) => r.available);
	return ladder.map((r) =>
		rungGuidance(r, { anyRungWorks, keyringAvailable: auth?.keyring_available }),
	);
}

/** What the first snapshot actually captured, for the celebration line.
 *  Empty when the run changed nothing (or the CLI sent no counts). */
export function describeCapturedCounts(counts?: Record<string, number> | null): string {
	if (!counts) return "";
	const order = ["skills", "mcp_servers", "snippets", "connectors", "subagents", "state_files"];
	const names: Record<string, string> = {
		skills: "skill",
		mcp_servers: "MCP server",
		snippets: "snippet",
		connectors: "connector",
		subagents: "sub-agent",
		state_files: "state file",
	};
	const parts: string[] = [];
	for (const key of order) {
		const n = Number(counts[key] ?? 0);
		if (!n) continue;
		parts.push(`${n} ${names[key]}${n === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

// The restore-plan contract lives in restoreContract.ts (wave 24); re-exported
// here so every existing `@/lib/backupContract` import keeps resolving.
export * from "./restoreContract";
