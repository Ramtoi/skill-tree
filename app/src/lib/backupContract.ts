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
	/** Why the rung is (un)available — shown verbatim; never re-worded in the UI. */
	detail: string;
	user?: string | null;
}

export interface BackupAuth {
	/** The rung that will actually be used to PUSH (null = no credential). */
	method: AuthMethod | null;
	configured: string;
	ladder: AuthRung[];
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

	const refusal = backupRefusal(status, slot);
	if (refusal) {
		return {
			level: "danger",
			label: "backup refused",
			detail: refusal.detail || "hub refused to publish the snapshot — review the finding",
		};
	}

	if (status.pending_reconcile) {
		return {
			level: "warn",
			label: "backup paused — restore pending",
			detail:
				"A restore set pending_reconcile: backups won't push until you acknowledge it.",
		};
	}

	const failures = Number(status.push_failures || 0);
	if (failures >= PUSH_FAILURE_ALERT_THRESHOLD) {
		return {
			level: "danger",
			label: `backup stale · ${failures} failed pushes`,
			detail: status.last_push_error || "consecutive push failures — the cloud copy is stale",
		};
	}

	return none;
}

/** Drift → the shared freshness grammar, so the repo card and the StatusBar
 *  can never disagree about what "in sync" means. */
export function driftFreshness(status: BackupStatus | null | undefined): {
	state: "fresh" | "stale" | "unknown" | "error";
	label: string;
} {
	if (!status || !status.configured) return { state: "unknown", label: "not configured" };
	if (!status.initialized) return { state: "unknown", label: "not initialized" };
	switch (status.drift) {
		case "in-sync":
			return { state: "fresh", label: "in sync with remote" };
		case "ahead":
			return { state: "stale", label: `ahead ${status.ahead ?? "?"} — not pushed` };
		case "behind":
			return { state: "stale", label: `behind ${status.behind ?? "?"} — remote is newer` };
		case "diverged":
			return {
				state: "error",
				label: `diverged (ahead ${status.ahead ?? "?"}, behind ${status.behind ?? "?"})`,
			};
		default:
			return { state: "unknown", label: "no remote to compare" };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore plan (`hub restore … --json`) — implemented (`restore.py::build_plan`)
// ─────────────────────────────────────────────────────────────────────────────

export type RestoreMode = "replace" | "merge";

/**
 * `integrity.trust.state` — the four-way verdict `restore.py::classify_trust`
 * folds a signature verdict and the pin store into.
 *
 * Two of them are **hard** (`hard: true`): no CLI flag overrides them and the
 * UI must offer no consent path — a pinned source signed by a different key is
 * exactly the substitution attack the pin exists to catch. The `unverified-*`
 * three are consent-gated and cleared by `--trust-new-key`, which also pins.
 */
export type RestoreTrustState =
	| "verified"
	| "unverified-new-key"
	| "unverified-unsigned"
	| "unverified-unavailable"
	| "key-mismatch"
	| "invalid-signature"
	| "unknown";

export interface RestoreTrust {
	state: RestoreTrustState;
	/** True only when the snapshot may proceed as-is (verified, or consented). */
	ok: boolean;
	/** True ⇒ refusal. Never render a checkbox for it. */
	hard: boolean;
	/** The CLI's own sentence. Shown verbatim; never re-worded. */
	detail: string;
	keyId: string | null;
	pinnedKeyId: string | null;
	/** `pinned_key_ids` — a source may hold more than one pinned signer (key
	 *  rotation). Falls back to the single `pinned_key_id` when absent, so the
	 *  older payload and the newer one both read the same way. */
	pinnedKeyIds: string[];
}

/** One file the restore writes OUTSIDE the data home (a harness agent dir or a
 *  global harness doc). `action` is `restore.py::_three_way`'s verdict. */
export interface RestoreOutOfHomeTarget {
	/** Absolute path actually written — the `.from-backup` sibling for `sibling`. */
	path: string;
	/** "sub-agent" | "global doc" */
	kind: string;
	/** write | sibling | overwrite */
	action: string;
	detail: string;
}

/** A single piece of executable state the restore would install. Enumerated
 *  verbatim in the confirm dialog — a hook command is arbitrary code that will
 *  run on this machine, so it is shown as-is, never summarized. */
export interface RestoreExecutableItem {
	/** "hook" | "permission" | "trust" | "connector" | "mcp-server" | anything
	 *  a later wave adds — rendered, not switched on. */
	kind: string;
	label: string;
	/** For a hook: the command string, verbatim. For a code dir: its section. */
	detail: string;
	/** Hook script path that doesn't exist on this machine (design §5). */
	broken?: boolean;
	/**
	 * True for a restored **code directory** — a connector or an MCP server that
	 * hub itself will import and execute, as opposed to a command it hands to a
	 * harness. Rendered as its own group: "a Python module this app imports" is
	 * a different thing to consent to than "a hook command your agent runs".
	 */
	code?: boolean;
	/** Code dirs only: `new` | `overwrite`. `identical` never reaches here. */
	action?: string;
	/** Code dirs only: the files the directory carries. */
	files?: string[];
}

export interface RestoreLostEntry {
	kind: string;
	name: string;
	detail?: string;
}

export interface RestoreConflict {
	kind: string;
	name: string;
	/** Which side wins under the chosen mode (backup wins on `merge`). */
	resolution?: string;
}

export interface RestoreUnresolvedProject {
	name: string;
	path: string;
}

/** The normalized plan every consumer reads. */
export interface RestorePlan {
	/** The CLI's own verdict: false whenever ANY gate is unmet — including the
	 *  consent gates the UI exists to satisfy. Never gate the apply button on
	 *  this; use `fatal` / `error` / the `requires*Consent` flags. */
	ok: boolean;
	/**
	 * `fatal: true` ⇒ the snapshot itself cannot be trusted (truncated tree, bad
	 * signature, key mismatch). The plan is truncated after `manifest` and there
	 * is **no** consent path — the UI must refuse, not offer a checkbox.
	 */
	fatal: boolean;
	/** A hard, unfixable-from-the-UI refusal, ready to render. Consent-gated
	 *  errors are deliberately NOT folded in here — they are the flags below. */
	error: string | null;
	/** Every message the CLI listed, consent-gated ones included. */
	errors: string[];
	source: string;
	mode: RestoreMode | null;
	/**
	 * The inputs this plan was PREVIEWED with, frozen at request time.
	 *
	 * Load-bearing: the apply must be sent with the source/mode the user was
	 * shown consequences for, never with whatever the form holds at click time.
	 * Reading them back off the plan closes the window where a form edit and a
	 * stale dialog disagree — a restore is destructive, so "the dialog said A,
	 * the CLI got B" is not a survivable class of bug. `mode` above is what the
	 * CLI *echoed*; these are what we *asked for* (identical in practice, but a
	 * missing echo must not silently un-freeze the request).
	 */
	requestedSource: string;
	requestedMode: RestoreMode | null;
	/** `integrity.trust` — drives the unverified banner and the trust checkbox. */
	trust: RestoreTrust;
	/** `integrity.ok` — tree digest AND trust. False on any consent-gated state. */
	integrityOk: boolean;
	/** `integrity.tree_digest.ok` — false ⇒ the snapshot is incomplete/tampered. */
	treeDigestOk: boolean;
	/** `--trust-new-key` is required and CAN be given (never true when `hard`). */
	requiresTrustConsent: boolean;
	/** `executable_state.requires_consent` — `--accept-executable-state` needed. */
	requiresExecConsent: boolean;
	/** `registry.target_populated` — this machine already holds hub content. */
	targetPopulated: boolean;
	/** `registry.mode_required` — populated target and no `--mode` was passed. */
	modeRequired: boolean;
	/** Registry entries the TARGET machine loses by restoring. The headline
	 *  consequence — enumerated first in the confirm dialog. */
	lostEntries: RestoreLostEntry[];
	conflicts: RestoreConflict[];
	/** Hooks / permission rules / trust grants, flattened from the three arrays. */
	executableState: RestoreExecutableItem[];
	/** Projects whose recorded path doesn't exist here — quarantined, sync skips them. */
	unresolvedProjects: RestoreUnresolvedProject[];
	/** Files the restore writes OUTSIDE the data home (harness agent dirs, global docs). */
	outOfHomeTargets: RestoreOutOfHomeTarget[];
	warnings: string[];
	/**
	 * Files this machine KEEPS that the snapshot does not carry — the
	 * `data.<section>.retained` lists plus `report.retained_extra_files`. The
	 * reassuring half of the disclosure: a `replace` does not mean "everything
	 * not in the backup is gone".
	 */
	retainedFiles: number;
	/** `report.audit_ledgers_note` — the CLI's sentence about append-only
	 *  ledgers that were merged rather than replaced. Shown verbatim or not at
	 *  all; `null` when the payload predates it. */
	auditLedgersNote: string | null;
	/** True whenever `trust.state !== "verified"` — the TOFU banner's condition. */
	unverified: boolean;
	/** Ordered next steps the CLI prints (restore never runs sync itself). */
	nextSteps: string[];
	/** True only on an apply reply that actually wrote (`apply: true`). */
	applied: boolean;
}

/** Read the first present key from a list of candidates. THE integration seam:
 *  a field rename on the Python side is one added string here. */
function pick<T>(raw: Record<string, unknown>, keys: string[], fallback: T): T {
	for (const k of keys) {
		const v = raw[k];
		if (v !== undefined && v !== null) return v as T;
	}
	return fallback;
}

function asArray(v: unknown): Record<string, unknown>[] {
	if (!Array.isArray(v)) return [];
	return v.map((item) =>
		typeof item === "object" && item !== null
			? (item as Record<string, unknown>)
			: { name: String(item) },
	);
}

function asStrings(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map((item) =>
		typeof item === "string" ? item : String((item as { path?: string })?.path ?? item),
	);
}

function str(v: unknown, fallback = ""): string {
	if (typeof v === "string") return v;
	if (v === undefined || v === null) return fallback;
	return String(v);
}

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

/** `projects` → `project`, `hooks` → `hook`, … for the section tags. */
function singular(section: string): string {
	return section.endsWith("s") ? section.slice(0, -1) : section;
}

/** The three-way verdicts that actually put bytes on disk. `skip` (identical)
 *  and `unsupported` (no target for this harness here) write nothing, so
 *  listing them under "writes outside the data home" would be a lie. */
const WRITE_ACTIONS = new Set(["write", "sibling", "overwrite"]);

/** Where a `sibling` verdict actually lands, per `restore.py::apply_plan`. */
function writtenPath(target: string, action: string): string {
	return action === "sibling" ? `${target}.from-backup` : target;
}

/** Flatten the real `executable_state` object (three typed arrays) into the flat
 *  list the consent dialog enumerates. */
function flattenExecutableState(block: Record<string, unknown>): RestoreExecutableItem[] {
	const out: RestoreExecutableItem[] = [];

	for (const h of asArray(block.hooks)) {
		const name = str(h.name);
		const event = str(h.event);
		out.push({
			kind: "hook",
			label: event ? `${event} · ${name}` : name,
			// The command is the thing the user is actually consenting to — verbatim.
			detail: str(h.command),
			broken: h.broken === true,
		});
	}

	for (const rule of asArray(block.permission_rules)) {
		const pattern = str(rule.pattern);
		out.push({
			kind: "permission",
			label: `${str(rule.kind, "allow")} · ${str(rule.scope, "global")}`,
			detail: pattern,
		});
	}

	for (const grant of asArray(block.codex_trust)) {
		out.push({
			kind: "trust",
			label: `Codex trust · ${str(grant.project)}`,
			detail: str(grant.reason) || str(grant.path),
		});
	}

	// ── code_dirs: restored connector / MCP-server source ────────────────────
	//
	// These MUST be enumerated. `requires_consent` counts every non-`identical`
	// entry, so a snapshot whose only executable state is connector code would
	// otherwise present a consent dialog with an empty list — asking the user to
	// accept "the 0 items above". `identical` entries are skipped to match the
	// Python side exactly: a byte-identical directory installs nothing new and
	// is not something to consent to.
	for (const dir of asArray(block.code_dirs)) {
		const action = str(dir.action);
		if (action === "identical") continue;
		const files = asStrings(dir.files);
		out.push({
			kind: str(dir.kind, "code") || "code",
			label: str(dir.name) || str(dir.section),
			detail: str(dir.section),
			code: true,
			action: action || "new",
			files,
		});
	}

	return out;
}

/** Legacy/defensive path: an already-flat array of executable items. */
function flatExecutableArray(items: Record<string, unknown>[]): RestoreExecutableItem[] {
	return items.map((e) => ({
		kind: str(pick(e, ["kind", "type"], "item"), "item"),
		label: str(pick(e, ["label", "name", "id", "event"], "")),
		detail: str(pick(e, ["command", "detail", "pattern", "rule", "path"], "")),
		broken: pick<boolean>(e, ["broken", "missing", "script_missing"], false),
	}));
}

/** `integrity.trust` → the normalized verdict. An absent block is treated as
 *  `unknown` + not-ok: a plan we cannot read the trust of is not a trusted one. */
function toTrust(integrity: Record<string, unknown>): RestoreTrust {
	const raw = obj(integrity.trust);
	const hasState = typeof raw.state === "string";
	const pinnedOne = typeof raw.pinned_key_id === "string" ? raw.pinned_key_id : null;
	const pinnedMany = asStrings(raw.pinned_key_ids);
	return {
		state: (hasState ? (raw.state as RestoreTrustState) : "unknown") as RestoreTrustState,
		// Only an explicit `ok: true` counts. A missing trust block never reads as fine.
		ok: raw.ok === true,
		hard: raw.hard === true,
		detail: str(raw.detail),
		keyId: typeof raw.key_id === "string" ? raw.key_id : null,
		// The singular stays the headline (it is what the banner names); the
		// plural is the full pin set, defaulting to the singular when absent.
		pinnedKeyId: pinnedOne ?? (pinnedMany.length > 0 ? pinnedMany[0] : null),
		pinnedKeyIds: pinnedMany.length > 0 ? pinnedMany : pinnedOne ? [pinnedOne] : [],
	};
}

/**
 * Normalize a raw `hub restore --json` payload into a [`RestorePlan`].
 *
 * Written defensively on purpose: `fatal` plans are truncated after `manifest`
 * (no `registry`, no `projects`, no `executable_state`), and an absent section
 * degrades to an empty list rather than throwing — so a shape drift shows up as
 * a thinner dialog, never a white screen over a destructive verb.
 */
export function toRestorePlan(
	raw: unknown,
	sourceHint = "",
	modeHint: RestoreMode | null = null,
): RestorePlan {
	const r = obj(raw);

	const fatal = r.fatal === true;
	const errors = asStrings(pick(r, ["errors"], []));
	const integrity = obj(r.integrity);
	const trust = toTrust(integrity);
	const treeDigestOk = obj(integrity.tree_digest).ok !== false;

	const registry = obj(r.registry);
	const sections = obj(obj(registry.diff).sections);

	// ── losses + conflicts: per-section name lists inside `registry.diff` ──────
	const lostEntries: RestoreLostEntry[] = [];
	const conflicts: RestoreConflict[] = [];
	const mode = pick<RestoreMode | null>(r, ["mode"], null);
	const resolution = mode === "merge" ? "backup wins" : "replaced by the backup";
	for (const section of Object.keys(sections)) {
		const block = obj(sections[section]);
		for (const name of asStrings(block.lost)) {
			lostEntries.push({ kind: singular(section), name });
		}
		for (const name of asStrings(block.conflicts)) {
			conflicts.push({ kind: singular(section), name, resolution });
		}
	}
	for (const key of asStrings(obj(registry.diff).top_level_lost)) {
		lostEntries.push({ kind: "registry key", name: key });
	}
	// Tolerated legacy/flat spellings, only when the real structure is absent.
	if (lostEntries.length === 0) {
		for (const e of asArray(pick(r, ["lost_entries", "lost", "would_lose", "removed"], []))) {
			lostEntries.push({
				kind: str(pick(e, ["kind", "type", "section"], "entry"), "entry"),
				name: str(pick(e, ["name", "id", "key"], "")),
				detail: str(pick(e, ["detail", "path", "description"], "")) || undefined,
			});
		}
	}
	if (conflicts.length === 0) {
		for (const e of asArray(pick(r, ["conflicts", "conflicting"], []))) {
			conflicts.push({
				kind: str(pick(e, ["kind", "type", "section"], "entry"), "entry"),
				name: str(pick(e, ["name", "id", "key"], "")),
				resolution: str(pick(e, ["resolution", "winner", "wins"], "")) || undefined,
			});
		}
	}

	// ── executable state: object of three arrays (or a legacy flat array) ─────
	const execRaw = r.executable_state ?? r.executable ?? r.executable_items;
	const executableState = Array.isArray(execRaw)
		? flatExecutableArray(asArray(execRaw))
		: flattenExecutableState(obj(execRaw));
	const execBlock = obj(Array.isArray(execRaw) ? {} : execRaw);
	const requiresExecConsent =
		execBlock.requires_consent === true ||
		(execBlock.requires_consent === undefined && executableState.length > 0);

	// ── quarantined projects: `projects[]` entries whose path doesn't exist ───
	let unresolvedProjects: RestoreUnresolvedProject[] = asArray(r.projects)
		.filter((p) => p.exists === false)
		.map((p) => ({ name: str(p.name), path: str(p.path) }));
	if (unresolvedProjects.length === 0) {
		unresolvedProjects = asArray(
			pick(r, ["unresolved_projects", "quarantined_projects", "unresolved"], []),
		).map((e) => ({
			name: str(pick(e, ["name", "project"], "")),
			path: str(pick(e, ["path", "expected_path"], "")),
		}));
	}

	// ── out-of-home writes: the sub-agent + global-doc three-way verdicts ─────
	const outOfHomeTargets: RestoreOutOfHomeTarget[] = [];
	for (const [key, kind] of [
		["subagents", "sub-agent"],
		["global_docs", "global doc"],
	] as const) {
		for (const entry of asArray(r[key])) {
			const action = str(entry.action);
			const target = str(entry.target);
			if (!target || !WRITE_ACTIONS.has(action)) continue;
			outOfHomeTargets.push({
				path: writtenPath(target, action),
				kind,
				action,
				detail: str(entry.detail),
			});
		}
	}
	if (outOfHomeTargets.length === 0) {
		for (const path of asStrings(
			pick(r, ["out_of_home_targets", "outside_data_home", "external_writes"], []),
		)) {
			outOfHomeTargets.push({ path, kind: "file", action: "write", detail: "" });
		}
	}

	// ── retained files: per-section lists + the report's tail count ───────────
	// Tolerant of both spellings the report may use (a list to count, or an
	// already-counted number), and of the whole block being absent.
	const dataSections = obj(r.data);
	let retainedFiles = 0;
	for (const key of Object.keys(dataSections)) {
		retainedFiles += asStrings(obj(dataSections[key]).retained).length;
	}
	const report = obj(r.report);
	const extra = report.retained_extra_files;
	retainedFiles += Array.isArray(extra)
		? extra.length
		: typeof extra === "number"
			? extra
			: 0;
	const auditLedgersNote =
		typeof report.audit_ledgers_note === "string" && report.audit_ledgers_note
			? report.audit_ledgers_note
			: null;

	// A consent-gated error is a GATE, not a failure — folding the "re-run with
	// --accept-executable-state" line into `error` would disable the very button
	// whose checkbox clears it. Only a fatal plan (or the CLI's own top-level
	// `{ok:false,error}` bail-out) is an unfixable-from-here refusal.
	const topError = pick<string | null>(r, ["error"], null);
	const error = topError ?? (fatal ? errors.join(" ") || "the snapshot could not be trusted" : null);

	return {
		ok: pick<boolean>(r, ["ok"], true),
		fatal,
		error,
		errors,
		source: str(pick(r, ["source", "from", "repo"], sourceHint), sourceHint),
		mode,
		// The hint is what we actually sent, so it WINS over the echo.
		requestedSource: sourceHint || str(pick(r, ["source", "from", "repo"], "")),
		requestedMode: modeHint ?? mode,
		trust,
		integrityOk: integrity.ok === true,
		treeDigestOk,
		// A hard verdict has no flag that clears it — never offer the checkbox.
		requiresTrustConsent: !trust.ok && !trust.hard && !fatal,
		requiresExecConsent,
		targetPopulated: registry.target_populated === true,
		modeRequired: registry.mode_required === true,
		lostEntries,
		conflicts,
		executableState,
		unresolvedProjects,
		outOfHomeTargets,
		warnings: asStrings(pick(r, ["warnings", "warning"], [])),
		retainedFiles,
		auditLedgersNote,
		unverified: trust.state !== "verified",
		nextSteps: asStrings(pick(r, ["next_steps", "nextSteps", "follow_up"], [])),
		// `applied` is an OBJECT on the wire (backup dir, writes, pins). The
		// boolean the UI wants is the plan's own `apply` flag.
		applied: r.apply === true || obj(r.applied).applied === true,
	};
}

/** Design §5: `--apply` REQUIRES `--accept-executable-state` when the plan
 *  installs any hooks / permission rules / trust grants. The UI gates its
 *  confirm button on this so the CLI's refusal is never how the user finds out. */
export function requiresExecutableConsent(plan: RestorePlan): boolean {
	return plan.requiresExecConsent;
}

/** Design §5: `--trust-new-key` accepts *and pins* a signer this machine has
 *  never seen. Never true for a `hard` verdict — those are refusals. */
export function requiresTrustConsent(plan: RestorePlan): boolean {
	return plan.requiresTrustConsent;
}

/**
 * Can the apply button fire at all, given the consents the user has ticked?
 *
 * The one place the gate composition lives, so the Backup screen's danger zone
 * and the bootstrap wizard can never disagree about what blocks a restore.
 */
export function canApplyRestore(
	plan: RestorePlan | null,
	consents: { executableState?: boolean; trustNewKey?: boolean } = {},
): boolean {
	if (!plan) return false;
	if (plan.fatal || plan.error) return false;
	if (plan.modeRequired) return false;
	if (plan.requiresExecConsent && !consents.executableState) return false;
	if (plan.requiresTrustConsent && !consents.trustNewKey) return false;
	return true;
}

/** Why the apply button is disabled, in the CLI's own words where it has them. */
export function restoreBlockReason(
	plan: RestorePlan | null,
	consents: { executableState?: boolean; trustNewKey?: boolean } = {},
): string | undefined {
	if (!plan) return "Preview the snapshot first";
	if (plan.error) return plan.error;
	if (plan.modeRequired)
		return "This machine already has hub content — pick replace or merge first";
	if (plan.requiresExecConsent && !consents.executableState)
		return "Accept the executable state above to continue";
	if (plan.requiresTrustConsent && !consents.trustNewKey)
		return "Accept the unverified signing key above to continue";
	return undefined;
}

/** The literal word both restore surfaces make the user type. */
export const RESTORE_CONFIRM_WORD = "RESTORE";

/** Has the user typed the confirmation word? Case- and whitespace-forgiving,
 *  because the gate exists to defeat muscle memory, not typing accuracy. */
export function typedConfirmationMet(typed: string): boolean {
	return typed.trim().toUpperCase() === RESTORE_CONFIRM_WORD;
}

/**
 * Does this plan need the typed-word gate?
 *
 * The Backup screen's danger zone always asks (a mid-life restore is never
 * routine). The first-run wizard asks only when the restore can actually
 * destroy something: it lists losses/conflicts, or this machine already holds
 * hub content. A genuinely empty first run stays a two-click flow — adding
 * ceremony where there is nothing to lose trains people to type it blind.
 */
export function requiresTypedConfirmation(plan: RestorePlan | null): boolean {
	if (!plan) return false;
	return plan.lostEntries.length > 0 || plan.conflicts.length > 0 || plan.targetPopulated;
}

/** Total count of destructive consequences — drives the dialog's headline. */
export function consequenceCount(plan: RestorePlan): number {
	return (
		plan.lostEntries.length +
		plan.conflicts.length +
		plan.executableState.length +
		plan.outOfHomeTargets.length
	);
}
