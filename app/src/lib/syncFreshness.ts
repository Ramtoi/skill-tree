// The freshness state machine (design D4). Derives a per-project sync-truth
// signal from the `sync_report` envelope + the live registry fingerprint the
// Tauri command computes. Never invents a hue and never claims `fresh` unless
// it can prove the registry is unchanged since the recorded sync.

import type { InvocationOutcome } from "./invocation";
import type { SyncReportBackupSlot } from "./backupContract";
import type { McpDeliveryRow } from "./mcpContract";
import type { ReconcileProjectRecord } from "./companions";

export interface SyncReportError {
	stage: string;
	message: string;
	/** Present on a `stage: "invocation"` row (`_record_invocation_failure`):
	 *  the skill and harnesses that failure applies to. A `stage: "symlink"`
	 *  row predates this and carries neither — `message` is still the only
	 *  reliable join key across stages (see `groupedSyncErrors`). */
	skill?: string;
	harnesses?: string[];
	reason_code?: string;
}

export interface SyncAffinitySkip {
	skill: string;
	skill_harnesses: string[];
	project_harnesses: string[];
}

export interface MissingRef {
	skill: string;
	refs: string[];
}

export interface SyncReportProjectRecord {
	invocation?: InvocationOutcome[];
	ts: string;
	ok: boolean;
	errors: SyncReportError[];
	writes: number;
	removed: number;
	affinity_skips: SyncAffinitySkip[];
	/** Set instead of a normal sync when `project_sync_skip_reason` refused to
	 *  touch this project (no such path, or `path_unresolved` from a restore).
	 *  `ok` stays `true` on these records — a quarantined project is an
	 *  EXPECTED state, not a failure (`skill_variants.py`) — so a reader must
	 *  check this field first and never read `ok: true` alone as "synced". */
	quarantined?: string;
	/** Additive: `skill_variants.py` sets these alongside `quarantined` (same
	 *  `project_sync_skip_reason` guard) — a structural skip verdict plus its
	 *  reason text, so a reader can recognize a skip without parsing
	 *  `quarantined`'s prose. Older reports predate this pair and carry only
	 *  `quarantined`; check both (see `projectFreshness`). */
	outcome?: "skipped";
	skip_reason?: string;
	/** Count of links this project's sweep found owned by a DIFFERENT hub
	 *  install and left alone (`hub.py:141`). */
	skipped_unowned?: number;
	/** Optional: older reports predate this field. Skills active on this
	 *  project that reference a registered, non-global skill this project
	 *  does not have equipped (`skill_refs.missing_refs_for`). */
	missing_refs?: MissingRef[];
	/** Optional: older reports predate the MCP delivery-truth stream (wave C).
	 *  Per (harness, scope, server) delivery row for this project. */
	mcp_delivery?: McpDeliveryRow[];
	/** A16: the I7 reconcile record `hub sync` wrote for this project's
	 *  `ships_with` companions — evidence for the Loadout `COMPANIONS_PENDING`
	 *  banner, never a client-side prediction. Optional: older reports
	 *  predate wave 2. */
	companions?: ReconcileProjectRecord;
}

export interface SyncReportGlobal {
	skipped: string[];
	skills: { writes: number; removed: number; skipped_unowned?: number; ok?: boolean; errors?: SyncReportError[]; invocation?: InvocationOutcome[] };
	mcp: {
		writes: number;
		removed: number;
		/** Optional: older reports predate the MCP delivery-truth stream. */
		delivery?: McpDeliveryRow[];
	};
	permissions: { ok: boolean; errors: unknown[] };
	/** Optional: older reports predate the hooks stream / doctor rollup slots. */
	hooks?: { ok: boolean; errors: unknown[] };
	doctor?: { ok: boolean; errors: unknown[] };
	remotes: { attempted: number; alarming: number };
	/** Optional: older reports predate the backup slot. */
	backup?: SyncReportBackupSlot;
	/** A16: the I7 reconcile record for the global (`companions_global`)
	 *  scope. Deviation 1 (plan 2): typed and read-ready this wave, but no
	 *  surface renders a global pending banner yet — the navigator's global
	 *  row is a follow-up. */
	companions?: ReconcileProjectRecord;
}

export interface SyncReport {
	schema_version: number;
	generated_at: string;
	registry_sha256: string;
	registry_mtime: number;
	ok: boolean;
	global: SyncReportGlobal;
	projects: Record<string, SyncReportProjectRecord>;
}

export interface SyncReportEnvelope {
	report: SyncReport;
	registry_current: { sha256: string; mtime: number };
}

export type Freshness = "fresh" | "stale" | "unknown" | "error" | "quarantined";

/** The live registry fact this reads: a project this machine cannot reach
 *  (`path_unresolved`, set by `hub restore` for a checkout that does not
 *  exist here — F1/A6). Narrower than `Project` so a caller with only the
 *  registry's raw JSON (untyped beyond this) can still pass it through. */
export interface ProjectAttachmentFact {
	path_unresolved?: boolean;
}

/** Per-project freshness (design D4, extended by F1 for attachment truth):
 *  - `quarantined` — sync refuses to touch this project (F1): either the LIVE
 *    registry says so (`project.path_unresolved`, checked first — always
 *    wins, so a stale or legacy report can never hide a project that is
 *    STILL unattached right now), or the last sync's own record says so
 *    (`record.quarantined` / additive `record.outcome === "skipped"`) AND
 *    that record is not itself stale. Never "fresh", REGARDLESS of
 *    `record.ok` — a quarantined record's `ok` stays `true` because skipping
 *    it is expected, not a failure, and that must not read as "in sync" (the
 *    F1 bug: 13 skipped projects counted as synced).
 *  - `stale`   — project synced ok, but the registry changed since (sha
 *    differs) — INCLUDING a report that called the project quarantined
 *    before a since-run recovery attached it: once the live registry no
 *    longer says `path_unresolved` and the sha has moved on, that old
 *    "quarantined" is stale evidence of a past state, not a live "still
 *    unattached" claim, and the honest read is "needs a re-sync", not
 *    "No local directory attached" (a since-fixed misread this regression
 *    guards against).
 *  - `unknown` — no envelope, or the project is absent from the report.
 *  - `error`   — project present and its last sync recorded errors (`ok:false`).
 *  - `fresh`   — project synced ok and the registry is unchanged. */
export function projectFreshness(
	name: string,
	envelope: SyncReportEnvelope | null | undefined,
	project?: ProjectAttachmentFact | null,
): Freshness {
	if (project?.path_unresolved) return "quarantined";
	if (!envelope?.report) return "unknown";
	const record = envelope.report.projects?.[name];
	if (!record) return "unknown";
	const stale = envelope.report.registry_sha256 !== envelope.registry_current?.sha256;
	const reportedSkip = !!record.quarantined || record.outcome === "skipped" || !!record.skip_reason;
	if (reportedSkip) return stale ? "stale" : "quarantined";
	if (!record.ok) return "error";
	if (stale) return "stale";
	return "fresh";
}

/** Whole-report freshness, no project scoping — for a block that is not
 *  about any one project (the MCP panel's DELIVERY header): `error` when the
 *  last sync itself failed, `stale` when the registry changed since,
 *  `unknown` with no envelope at all, `fresh` otherwise. */
export function reportFreshness(envelope: SyncReportEnvelope | null | undefined): Freshness {
	if (!envelope?.report) return "unknown";
	if (!envelope.report.ok) return "error";
	if (envelope.report.registry_sha256 !== envelope.registry_current?.sha256) {
		return "stale";
	}
	return "fresh";
}

/** Every `mcp_delivery` row (global ∪ every project) naming `server` — the
 *  MCP panel's DELIVERY table source, read straight from the sync report
 *  (never computed client-side, per the module's own no-predictive-twin
 *  rule). Computed here so `SkillEditor` stays a one-line consumer. */
export function mcpDeliveryRowsFor(
	envelope: SyncReportEnvelope | null | undefined,
	server: string,
): McpDeliveryRow[] {
	const report = envelope?.report;
	if (!report || !server) return [];
	const rows: McpDeliveryRow[] = [];
	for (const row of report.global.mcp.delivery ?? []) {
		if (row.server === server) rows.push(row);
	}
	for (const proj of Object.values(report.projects ?? {})) {
		for (const row of proj.mcp_delivery ?? []) {
			if (row.server === server) rows.push(row);
		}
	}
	return rows;
}

/** The per-project record from the report, or `null` when absent. */
export function projectRecord(
	name: string,
	envelope: SyncReportEnvelope | null | undefined,
): SyncReportProjectRecord | null {
	return envelope?.report?.projects?.[name] ?? null;
}

/** One root cause, every raw stage error that independently reported it. */
export interface GroupedSyncError {
	message: string;
	stages: SyncReportError[];
}

/** F3: a missing skill source is reported once per stage that notices it —
 *  `symlink` (placement) AND `invocation` (dispatch) — and both stages emit
 *  the IDENTICAL `"source missing: <path>"` text for the same skill
 *  (`skill_variants.py`'s `_record_invocation_failure` reuses the symlink
 *  stage's own message as its exception text). Grouping by that exact
 *  message turns ten raw errors from five missing sources into five
 *  actionable items, while `stages` keeps every raw diagnostic available on
 *  expand — never discarded, only collapsed. Two different root causes never
 *  merge just because both start with "source missing:"; only an identical
 *  message does. Order is first-seen, so the UI stays stable across renders. */
export function groupedSyncErrors(errors: SyncReportError[]): GroupedSyncError[] {
	const order: string[] = [];
	const byMessage = new Map<string, SyncReportError[]>();
	for (const error of errors) {
		let bucket = byMessage.get(error.message);
		if (!bucket) {
			bucket = [];
			byMessage.set(error.message, bucket);
			order.push(error.message);
		}
		bucket.push(error);
	}
	return order.map((message) => ({ message, stages: byMessage.get(message)! }));
}

const LABELS: Record<Freshness, string> = {
	fresh: "in sync",
	stale: "registry changed — re-sync",
	unknown: "unknown — run sync",
	error: "last sync failed",
	quarantined: "no local directory attached",
};

/** Short human label for a freshness state (used by badges + drawer rows). */
export function freshnessLabel(state: Freshness): string {
	return LABELS[state];
}

/**
 * Classify a non-zero `hub sync` exit for the toast. `hub sync` exits non-zero
 * when the doctor finds a danger-severity risk EVEN THOUGH every write
 * succeeded — that run applied everything and must not read as "Couldn't
 * sync". `danger_only` holds exactly when the report is from THIS run
 * (generated at/after `startedAtMs`, minus a small clock-skew slack), every
 * project and both streams are ok, and only the doctor slot is not.
 */
export function classifySyncFailure(
	envelope: SyncReportEnvelope | null | undefined,
	startedAtMs: number,
): "danger_only" | "hard_failure" {
	const r = envelope?.report;
	if (!r?.generated_at) return "hard_failure";
	const generated = Date.parse(r.generated_at);
	if (Number.isNaN(generated) || generated < startedAtMs - 5000)
		return "hard_failure";
	const g = r.global;
	const projectsOk = Object.values(r.projects ?? {}).every(
		(p) => p.ok !== false,
	);
	const streamsOk =
		g?.skills?.ok !== false && g?.permissions?.ok !== false && (g?.hooks ? g.hooks.ok !== false : true);
	const doctorBad = g?.doctor?.ok === false;
	return projectsOk && streamsOk && doctorBad ? "danger_only" : "hard_failure";
}

/** Compact relative time for sync timestamps ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function relTime(iso?: string): string {
	if (!iso) return "—";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "—";
	const diff = Date.now() - then;
	if (diff < 0) return "just now";
	const min = Math.floor(diff / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}
