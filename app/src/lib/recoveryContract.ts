/**
 * `hub recovery …` wire contract (backend draft: `/tmp/restore-recovery-contract.md`
 * plus the parent's required corrections in `/tmp/restore-backend-followup.txt`).
 *
 * The persisted-vs-live split matters here more than in `restoreContract.ts`:
 * `hub recovery status --json` never trusts a persisted "ready" over a fresh
 * registry/filesystem read, and a `"running"` row with a dead owner reads back
 * as `"interrupted"` — this module treats both as backend-derived facts to
 * render, not something the UI re-derives from raw paths.
 *
 * Every reader here is defensive the same way `toRestorePlan` is: an absent or
 * malformed field degrades to a safe empty/neutral value rather than throwing,
 * because a recovery journey the UI cannot render is worse than a thinner one.
 */

export type RecoveryStage = "library" | "sources" | "projects" | "remaining" | "sync";

/** Every row status the backend contract defines. `interrupted` is a
 *  backend-computed verdict (a `"running"` row whose owner process is dead) —
 *  the UI never infers it from staleness itself. */
export type RecoveryRowStatus =
	| "pending"
	| "running"
	| "ready"
	| "skipped"
	| "deferred"
	| "failed"
	| "interrupted";

export interface RecoveryRepositoryAssociation {
	url: string;
	remote: string;
	subdirectory: string;
}

export interface RecoveryProjectRow {
	name: string;
	path: string;
	pathUnresolved: boolean;
	attached: boolean;
	repository: RecoveryRepositoryAssociation | null;
	status: RecoveryRowStatus;
	detail: string | null;
	updatedAt: string | null;
}

export interface RecoverySourceRow {
	id: string;
	url: string;
	cache: string;
	healthy: boolean;
	status: RecoveryRowStatus;
	detail: string | null;
	updatedAt: string | null;
}

export interface RecoveryLocalSourceRow {
	skill: string;
	missingPath: string;
	status: RecoveryRowStatus;
	detail: string | null;
	path: string | null;
	updatedAt: string | null;
}

export interface RecoveryRowSummary {
	ready: number;
	pending: number;
	skipped: number;
	failed: number;
	interrupted: number;
	total: number;
}

export interface RecoveryStatus {
	ok: boolean;
	operationId: string | null;
	stage: RecoveryStage | null;
	/** True while there is recovery work this machine has not finished or
	 *  dismissed — the ONE condition that may show a "Finish setup" entry
	 *  point. A healthy, fully-synced, never-restored install must read
	 *  `false` here (A14) — status derives this from live facts, not just
	 *  "a record file exists". */
	needsRecovery: boolean;
	/** The user explicitly closed the journey with unresolved/skipped items
	 *  still present — `needsRecovery` can still be true (retryable failures,
	 *  a reopenable Attach), but the wizard must not auto-open on its own. */
	dismissed: boolean;
	/** Every stage reached `ready`/`skipped` and `finish` was called. */
	completed: boolean;
	bootstrapCompleted: boolean;
	bootstrapCompletedAt: string | null;
	restoredFrom: string | null;
	backupPendingReconcile: boolean;
	projects: RecoveryProjectRow[];
	projectsSummary: RecoveryRowSummary;
	sources: RecoverySourceRow[];
	localSources: RecoveryLocalSourceRow[];
	syncResult?: RecoverySyncResult | null;
	syncCurrent?: boolean;
}

export interface RecoveryGithubRepo {
	fullName: string;
	url: string;
	sshUrl: string;
	private: boolean;
	updatedAt: string | null;
	defaultBranch: string | null;
}

export type RecoveryGithubErrorKind =
	| "gh_unavailable"
	| "unauthenticated"
	| "timeout"
	| "gh_failed"
	| null;

export interface RecoveryGithubRepos {
	ok: boolean;
	repositories: RecoveryGithubRepo[];
	page: number;
	perPage: number;
	hasMore: boolean;
	truncated?: boolean;
	errorKind: RecoveryGithubErrorKind;
	error: string | null;
}

export interface RecoveryDiscoverMatch {
	path: string;
	gitRoot: string;
	isWorktree: boolean;
	matchedRemote: string;
	subdirectories: string[];
}

export interface RecoveryDiscoverResult {
	ok: boolean;
	matches: RecoveryDiscoverMatch[];
	/** Non-fatal scan findings (`discover_checkouts`'s typed issues — a
	 *  permission-denied subtree, a symlink loop, …), reduced to their
	 *  message text; the scan still returns whatever matches it found. */
	issues: string[];
	truncated: boolean;
	error: string | null;
}

export interface RecoverySyncCounts {
	success: number;
	skipped: number;
	failed: number;
}

export interface RecoverySyncResult {
	ok: boolean;
	counts: RecoverySyncCounts;
	/** Names of projects that failed delivery in this sync — kept separate
	 *  from `counts.failed` so the UI can name them, not just count them. */
	failedProjects: string[];
	/** Human-readable delivery failures grouped by project name. The backend
	 *  may omit this field for older reports, so an empty map is the safe
	 *  normalized value. */
	projectFailures: Record<string, string[]>;
	/** Failures not scoped to one project (a global/tail-pass error). Kept
	 *  visible even when every project's own delivery succeeded (PLAN.md
	 *  §Sync reporting: "keep global failures visible even when project
	 *  delivery succeeds"). */
	globalFailures: string[];
	error: string | null;
}

// ─── shared tolerant readers (mirrors restoreContract.ts's `pick`/`asArray`) ──

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function arr(v: unknown): Record<string, unknown>[] {
	if (!Array.isArray(v)) return [];
	return v.map((item) => (typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {}));
}

function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function bool(v: unknown, fallback = false): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strings(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

/** Like `strings`, but also accepts the `{code, message, field}` issue
 *  objects `discover`'s `issues` array actually carries — a plain `strings()`
 *  read silently dropped every one of them (they are objects, not strings),
 *  which is how a scan permission error went unrendered. */
function messages(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.map((x) => {
			if (typeof x === "string") return x;
			if (x && typeof x === "object" && typeof (x as Record<string, unknown>).message === "string") {
				return (x as Record<string, unknown>).message as string;
			}
			return "";
		})
		.filter(Boolean);
}

/** Read old persisted failure entries without leaking a Python object repr or
 * silently dropping object-shaped entries. New sync results are already flat
 * strings; this keeps older records useful after an app restart. */
function readableFailure(v: unknown, inheritedScope?: string): string {
	if (typeof v === "string") return v;
	if (v === null || v === undefined) return "";
	if (typeof v !== "object" || Array.isArray(v)) return String(v);

	const record = v as Record<string, unknown>;
	const scope = typeof record.scope === "string"
		? record.scope
		: typeof record.stage === "string"
			? record.stage
			: inheritedScope;
	const direct = [record.message, record.error, record.detail, record.reason]
		.find((value): value is string => typeof value === "string" && value.length > 0);
	if (direct) return scope && !direct.startsWith(`${scope}:`) ? `${scope}: ${direct}` : direct;

	const parts = Object.entries(record)
		.filter(([key, value]) => key !== "scope" && value !== null && value !== undefined)
		.map(([key, value]) => {
			const detail = readableFailure(value);
			return detail ? `${key}: ${detail}` : "";
		})
		.filter(Boolean);
	const fallback = parts.join(", ");
	return fallback ? (scope ? `${scope}: ${fallback}` : fallback) : (scope ? `${scope}: sync failed` : "sync failed");
}

function readableFailures(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map((entry) => readableFailure(entry)).filter(Boolean);
}

function stringMap(v: unknown): Record<string, string[]> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
		const items = readableFailures(value);
		if (items.length > 0) out[key] = items;
	}
	return out;
}

const ROW_STATUSES: RecoveryRowStatus[] = [
	"deferred",
	"pending",
	"running",
	"ready",
	"skipped",
	"failed",
	"interrupted",
];

function rowStatus(v: unknown): RecoveryRowStatus {
	return typeof v === "string" && (ROW_STATUSES as string[]).includes(v)
		? (v as RecoveryRowStatus)
		: "pending";
}

function stage(v: unknown): RecoveryStage | null {
	return v === "library" || v === "sources" || v === "projects" || v === "remaining" || v === "sync"
		? v
		: null;
}

function repository(v: unknown): RecoveryRepositoryAssociation | null {
	const r = obj(v);
	if (typeof r.url !== "string") return null;
	return {
		url: r.url,
		remote: str(r.remote, "origin"),
		subdirectory: str(r.subdirectory, "."),
	};
}

function summarize(rows: { status: RecoveryRowStatus }[]): RecoveryRowSummary {
	const out: RecoveryRowSummary = { ready: 0, pending: 0, skipped: 0, failed: 0, interrupted: 0, total: rows.length };
	for (const row of rows) {
		if (row.status === "running") continue; // counted as neither done nor pending in the summary strip
		if (row.status in out) (out as unknown as Record<string, number>)[row.status] += 1;
	}
	return out;
}

/** Normalize a raw `hub recovery status --json` payload. Tolerates the record
 *  being entirely absent (an older install, or a machine that never ran a
 *  recovery) — every field degrades to its "nothing to do" value. */
export function toRecoveryStatus(raw: unknown): RecoveryStatus {
	const r = obj(raw);
	const bootstrap = obj(r.bootstrap);
	const backup = obj(r.backup);

	const projects: RecoveryProjectRow[] = arr(r.projects).map((p) => ({
		name: str(p.name),
		path: str(p.path),
		pathUnresolved: bool(p.path_unresolved),
		attached: bool(p.attached),
		repository: repository(p.repository),
		status: rowStatus(p.status),
		detail: strOrNull(p.detail),
		updatedAt: strOrNull(p.updated_at),
	}));

	const sources: RecoverySourceRow[] = arr(r.sources).map((s) => ({
		id: str(s.id),
		url: str(s.url),
		cache: str(s.cache),
		healthy: bool(s.healthy),
		status: rowStatus(s.status),
		detail: strOrNull(s.detail),
		updatedAt: strOrNull(s.updated_at),
	}));

	const localSources: RecoveryLocalSourceRow[] = arr(r.local_sources).map((s) => ({
		skill: str(s.skill),
		missingPath: str(s.missing_path),
		status: rowStatus(s.status),
		detail: strOrNull(s.detail),
		path: strOrNull(s.path),
		updatedAt: strOrNull(s.updated_at),
	}));

	const projectsSummaryRaw = obj(r.projects_summary);
	const projectsSummary: RecoveryRowSummary = projectsSummaryRaw.total !== undefined
		? {
				ready: num(projectsSummaryRaw.ready),
				pending: num(projectsSummaryRaw.pending),
				skipped: num(projectsSummaryRaw.skipped),
				failed: num(projectsSummaryRaw.failed),
				interrupted: num(projectsSummaryRaw.interrupted),
				total: num(projectsSummaryRaw.total, projects.length),
			}
		: summarize(projects);

	// `needs_recovery` is the backend's own verdict when present. Falling back
	// to "is there anything not ready/skipped" keeps older backend payloads
	// (pre-correction contract) from permanently hiding a real unfinished
	// recovery, without ever forcing a healthy install into the gate (an
	// empty `projects`/`sources`/`local_sources` read stays `false`).
	const hasOutstanding =
		[...projects, ...sources, ...localSources].some(
			(row) => row.status !== "ready" && row.status !== "skipped",
		) || (stage(r.stage) !== null && !bool(r.completed));
	const needsRecovery = typeof r.needs_recovery === "boolean" ? r.needs_recovery : hasOutstanding;

	return {
		ok: bool(r.ok, true),
		operationId: strOrNull(r.operation_id),
		stage: stage(r.stage),
		needsRecovery,
		dismissed: bool(r.dismissed),
		completed: bool(r.completed),
		bootstrapCompleted: bool(bootstrap.completed),
		bootstrapCompletedAt: strOrNull(bootstrap.completed_at),
		restoredFrom: strOrNull(bootstrap.restored_from),
		backupPendingReconcile: bool(backup.pending_reconcile),
		projects,
		projectsSummary,
		sources,
		localSources,
		syncResult: r.sync_result && typeof r.sync_result === "object" ? toSyncResult(r.sync_result) : null,
		syncCurrent: bool(r.sync_current),
	};
}

export function toGithubRepos(raw: unknown): RecoveryGithubRepos {
	const r = obj(raw);
	return {
		ok: bool(r.ok, true),
		repositories: arr(r.repositories).map((repo) => ({
			fullName: str(repo.full_name),
			url: str(repo.url),
			sshUrl: str(repo.ssh_url),
			private: bool(repo.private),
			updatedAt: strOrNull(repo.updated_at),
			defaultBranch: strOrNull(repo.default_branch),
		})),
		page: num(r.page, 1),
		perPage: num(r.per_page, 30),
		hasMore: bool(r.has_more),
		truncated: bool(r.truncated),
		errorKind: (typeof r.error_kind === "string" ? r.error_kind : null) as RecoveryGithubErrorKind,
		error: strOrNull(r.error),
	};
}

export function toDiscoverResult(raw: unknown): RecoveryDiscoverResult {
	const r = obj(raw);
	return {
		ok: bool(r.ok, true),
		matches: arr(r.matches).map((m) => ({
			path: str(m.path),
			gitRoot: str(m.git_root),
			isWorktree: bool(m.is_worktree),
			matchedRemote: str(m.matched_remote, "origin"),
			subdirectories: strings(m.subdirectories),
		})),
		issues: messages(r.issues),
		truncated: bool(r.truncated),
		error: strOrNull(r.error),
	};
}

export function toSyncResult(raw: unknown): RecoverySyncResult {
	const r = obj(raw);
	const counts = obj(r.counts);
	return {
		ok: bool(r.ok, true),
		counts: {
			success: num(counts.success),
			skipped: num(counts.skipped),
			failed: num(counts.failed),
		},
		failedProjects: strings(r.failed_projects),
		projectFailures: stringMap(r.project_failures),
		globalFailures: readableFailures(r.global_failures),
		error: strOrNull(r.error),
	};
}

/** The wizard's step order (PLAN.md's accepted five-step journey). "library"
 *  is not its own screen — it is the state the user is in the instant a
 *  restore applies, before `recovery start` — so the wizard's own stepper
 *  begins at `sources`. */
export const RECOVERY_STAGES: RecoveryStage[] = ["library", "sources", "projects", "remaining", "sync"];

/** Human label for the stepper / status strip. */
export const RECOVERY_STAGE_LABELS: Record<RecoveryStage, string> = {
	library: "Library restored",
	sources: "Recover skill sources",
	projects: "Attach projects",
	remaining: "Review remaining issues",
	sync: "Sync and finish",
};

/** A source row still needing attention (not ready, not explicitly skipped). */
export function openSourceRows(status: RecoveryStatus): RecoverySourceRow[] {
	return status.sources.filter((s) => s.status !== "ready" && s.status !== "skipped" && s.status !== "deferred");
}

/** A project that has neither an attached directory nor an explicit skip. */
export function openProjectRows(status: RecoveryStatus): RecoveryProjectRow[] {
	return status.projects.filter((p) => !p.attached && p.status !== "skipped" && p.status !== "deferred");
}

export function openLocalSourceRows(status: RecoveryStatus): RecoveryLocalSourceRow[] {
	return status.localSources.filter((s) => s.status !== "ready" && s.status !== "skipped" && s.status !== "deferred");
}

/** Counts for the finish screen (PLAN.md: "ready, unattached/skipped, and
 *  failed items" — a skipped project never counts as ready). */
export function recoveryFinishCounts(status: RecoveryStatus): {
	ready: number;
	skipped: number;
	failed: number;
} {
	const rows = [...status.projects, ...status.sources, ...status.localSources];
	let ready = 0;
	let skipped = 0;
	let failed = 0;
	for (const row of rows) {
		if (row.status === "ready") ready += 1;
		else if (row.status === "skipped" || row.status === "deferred") skipped += 1;
		else if (row.status === "failed" || row.status === "interrupted") failed += 1;
	}
	return { ready, skipped, failed };
}

/** Any row across every collection still untouched — never attempted, never
 *  explicitly skipped, and not currently mid-attempt. Finish must refuse
 *  while this is true: every source, project, and local-only skill needs an
 *  explicit outcome (ready, failed-after-a-try, or skipped), not a silent
 *  pass-through the user never actually looked at. */
export function hasUnresolvedRows(status: RecoveryStatus): boolean {
	return [...status.projects, ...status.sources, ...status.localSources].some(
		(row) => row.status !== "ready" && row.status !== "skipped" && row.status !== "deferred",
	);
}

/** True once every row belonging to `stage` has left "pending"/"running" — a
 *  real attempt (ready, failed, interrupted) or an explicit skip. The
 *  stepper's checkmark reads THIS, never "the user clicked past it": a stage
 *  advanced by navigation alone must stay unchecked. `sync` has no row
 *  collection of its own — its completion is whether a sync actually ran
 *  this session, tracked by the caller (`RecoveryWizard`), not derivable
 *  from `status` alone until the backend persists sync evidence. */
export function stageRowsResolved(status: RecoveryStatus, stage: RecoveryStage): boolean {
	const rows: { status: RecoveryRowStatus }[] =
		stage === "sources"
			? status.sources
			: stage === "projects"
				? status.projects
				: stage === "remaining"
					? status.localSources
					: [];
	if (stage === "sync") return status.syncCurrent === true;
	// Deferred work remains resumable. Keep its step visibly open so the
	// stepper never gives a green completion signal to an unresolved outcome.
	return rows.every((r) => r.status === "ready" || r.status === "skipped");
}
