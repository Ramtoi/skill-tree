// The freshness state machine (design D4). Derives a per-project sync-truth
// signal from the `sync_report` envelope + the live registry fingerprint the
// Tauri command computes. Never invents a hue and never claims `fresh` unless
// it can prove the registry is unchanged since the recorded sync.

export interface SyncReportError {
	stage: string;
	message: string;
}

export interface SyncAffinitySkip {
	skill: string;
	skill_harnesses: string[];
	project_harnesses: string[];
}

export interface SyncReportProjectRecord {
	ts: string;
	ok: boolean;
	errors: SyncReportError[];
	writes: number;
	removed: number;
	affinity_skips: SyncAffinitySkip[];
}

export interface SyncReportGlobal {
	skipped: string[];
	skills: { writes: number; removed: number };
	mcp: { writes: number; removed: number };
	permissions: { ok: boolean; errors: unknown[] };
	remotes: { attempted: number; alarming: number };
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

export type Freshness = "fresh" | "stale" | "unknown" | "error";

/** Per-project freshness (design D4):
 *  - `unknown` — no envelope, or the project is absent from the report.
 *  - `error`   — project present and its last sync recorded errors (`ok:false`).
 *  - `stale`   — project synced ok, but the registry changed since (sha differs).
 *  - `fresh`   — project synced ok and the registry is unchanged. */
export function projectFreshness(
	name: string,
	envelope: SyncReportEnvelope | null | undefined,
): Freshness {
	if (!envelope?.report) return "unknown";
	const record = envelope.report.projects?.[name];
	if (!record) return "unknown";
	if (!record.ok) return "error";
	if (envelope.report.registry_sha256 !== envelope.registry_current?.sha256) {
		return "stale";
	}
	return "fresh";
}

/** The per-project record from the report, or `null` when absent. */
export function projectRecord(
	name: string,
	envelope: SyncReportEnvelope | null | undefined,
): SyncReportProjectRecord | null {
	return envelope?.report?.projects?.[name] ?? null;
}

const LABELS: Record<Freshness, string> = {
	fresh: "in sync",
	stale: "registry changed — re-sync",
	unknown: "unknown — run sync",
	error: "last sync failed",
};

/** Short human label for a freshness state (used by badges + drawer rows). */
export function freshnessLabel(state: Freshness): string {
	return LABELS[state];
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
