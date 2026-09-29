// ─── Cloud targets — frontend contract for `hub cloud …` ─────────────────────
// A "cloud target" is a chat product (claude.ai, ChatGPT web) that accepts a
// skill ONLY as a hand-uploaded ZIP. There is no API, so the app cannot sync to
// it — it can only build the archive, remember the fingerprint it last built,
// and tell you whether what you last uploaded still matches your library.
//
// Every shape below mirrors a `--json` payload emitted by `cloud_targets.py`
// (verified against the live CLI); the UI never re-derives any of it.

import type { BadgeChannel } from "@/components/StatusBadge";

/** Per-skill drift verdict. `orphaned` never appears inside `skills[]` — it is
 *  its own list — but the badge vocabulary covers it so one map serves both. */
export type CloudSkillStatus =
	| "new"
	| "up_to_date"
	| "changed"
	| "missing"
	| "orphaned";

export interface CloudDrift {
	new: number;
	changed: number;
	up_to_date: number;
	/** Equipped, but its source folder is gone. Part of the rollup because a
	 *  card that omitted it read "equipped 1" beside "Nothing equipped yet". */
	missing: number;
	orphaned: number;
}

/** One row of `hub cloud targets --json`. */
export interface CloudTarget {
	id: string;
	label: string;
	upload_url: string;
	/** Breadcrumb INSIDE the product ("Customize > Skills > + > Create skill"). */
	upload_path: string;
	supports: string[];
	/** Honest-limits copy authored backend-side. Rendered verbatim — the UI must
	 *  never paraphrase it, because the caveats (mobile reach, remote-only MCP)
	 *  are exactly where an overclaim would mislead. */
	notes: string[];
	equipped: number;
	drift: CloudDrift;
	/** Most recent `exported_at` in this target's sidecar, or null if hub has
	 *  never built a ZIP for it. The only date hub can honestly claim — it
	 *  cannot know whether the upload ever happened. */
	last_exported: string | null;
}

export interface CloudSkillRow {
	skill: string;
	status: CloudSkillStatus;
	sha256: string | null;
	exported_sha256: string | null;
	exported_at: string | null;
	zip_name: string | null;
	lint: string[];
}

export interface CloudOrphanRow {
	skill: string;
	sha256: string | null;
	exported_at: string | null;
	zip_name: string | null;
}

export interface CloudUnsupportedRow {
	skill: string;
	reason: string;
}

export interface CloudStatusSummary {
	equipped: number;
	new: number;
	changed: number;
	up_to_date: number;
	missing: number;
	orphaned: number;
	unsupported: number;
	lint_warnings: number;
}

/** `hub cloud status <id> --json`. */
export interface CloudStatus {
	target: string;
	label: string;
	upload_url: string;
	upload_path: string;
	last_exported: string | null;
	notes: string[];
	skills: CloudSkillRow[];
	orphaned: CloudOrphanRow[];
	unsupported: CloudUnsupportedRow[];
	summary: CloudStatusSummary;
	/** Present only when the export-state sidecar was unreadable. */
	warnings?: string[];
}

export interface CloudExportRow {
	skill: string;
	zip_path: string;
	sha256: string;
	files: number;
	status_before: CloudSkillStatus;
	lint: string[];
}

/** `hub cloud export <id> --json`. NOTE the key is `out_dir` (not export_dir). */
export interface CloudExportResult {
	target: string;
	label: string;
	upload_url: string;
	upload_path: string;
	out_dir: string;
	results: CloudExportRow[];
	pruned: { skill: string; removed_zip: string | null }[];
	unsupported: CloudUnsupportedRow[];
	errors: string[];
	notes: string[];
}

/**
 * The fixed cloud catalog, mirrored from `CLOUD_TARGETS` in `cloud_targets.py`.
 *
 * It is hardcoded there *by design* — it describes somebody else's product, not
 * user data — so mirroring the two ids here is not a cache that can silently go
 * stale on a registry edit. It buys two things a query cannot: a palette entry
 * that costs no subprocess at app boot, and a label for the detail header
 * before the first `hub cloud` call resolves.
 *
 * `src/test/cliContract.test.ts` runs the real CLI and asserts these ids still
 * match, so a backend catalog change fails the suite rather than drifting.
 */
export const CLOUD_TARGET_CATALOG: { id: string; label: string }[] = [
	{ id: "claude-ai", label: "claude.ai" },
	{ id: "chatgpt-web", label: "ChatGPT (web)" },
];

export function cloudCatalogLabel(id: string): string | undefined {
	return CLOUD_TARGET_CATALOG.find((t) => t.id === id)?.label;
}

/**
 * Pull the JSON document out of a `hub_cmd` stdout blob.
 *
 * Same problem `parseCliJson` solves (hub.py may prepend advisory lines), but
 * `hub cloud targets --json` answers with a top-level ARRAY, which that helper
 * cannot see — it scans for `{` only. This scans for whichever of `{` / `[`
 * comes first and retries on the balanced prefix when trailing noise follows.
 */
export function parseHubJson<T>(output: string): T {
	const text = (output ?? "").trim();
	const candidates = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
	if (candidates.length > 0) {
		const start = Math.min(...candidates);
		const closer = text[start] === "[" ? "]" : "}";
		try {
			return JSON.parse(text.slice(start)) as T;
		} catch {
			const end = text.lastIndexOf(closer);
			if (end > start) {
				try {
					return JSON.parse(text.slice(start, end + 1)) as T;
				} catch {
					/* fall through */
				}
			}
		}
	}
	throw new Error(text || "empty response from hub");
}

/**
 * Status → badge props. The grammar is "matches what you last exported",
 * never "synced" — nothing here is a live connection.
 *
 * Channels follow the house rule (COMPONENTS.md §Accents): green = settled OK,
 * blue = informational/actionable-local, neutral + pulse = transitional/stale.
 * Amber is provenance-only and is deliberately NOT used for `changed`, which is
 * the exact overload the narrow-color-polish sweep removed.
 */
export const CLOUD_STATUS_META: Record<
	CloudSkillStatus,
	{ channel: BadgeChannel; label: string; hint: string; motion?: "pulse" }
> = {
	up_to_date: {
		channel: "ok",
		label: "up to date",
		hint: "Matches the ZIP you last exported for this target.",
	},
	new: {
		channel: "info",
		label: "new",
		hint: "Never exported here — export, then upload it.",
	},
	changed: {
		channel: "neutral",
		label: "changed",
		hint: "Edited since the last export. Re-export and upload it again.",
		motion: "pulse",
	},
	missing: {
		channel: "neutral",
		label: "missing",
		hint: "The skill's source folder is gone — nothing to export.",
		motion: "pulse",
	},
	orphaned: {
		channel: "neutral",
		label: "orphaned",
		hint: "Exported before, no longer equipped. The next export prunes its ZIP.",
		motion: "pulse",
	},
};

export function cloudStatusMeta(status: CloudSkillStatus) {
	return (
		CLOUD_STATUS_META[status] ?? {
			channel: "neutral" as BadgeChannel,
			label: status,
			hint: "",
		}
	);
}

/** The card's ambient staleness cluster: which badges to show, in reading
 *  order, skipping the zeros. An all-settled target collapses to one green
 *  "up to date" so a glance costs no counting. */
export function driftCluster(
	drift: CloudDrift,
	equipped: number,
): { status: CloudSkillStatus; count: number }[] {
	const out: { status: CloudSkillStatus; count: number }[] = [];
	if (drift.changed > 0) out.push({ status: "changed", count: drift.changed });
	if (drift.new > 0) out.push({ status: "new", count: drift.new });
	// `missing` first among the dead-state pair: it is a skill the user still
	// believes is equipped here, and leaving it out of the cluster is what let a
	// card claim "equipped 1" while saying "Nothing equipped yet".
	if ((drift.missing ?? 0) > 0)
		out.push({ status: "missing", count: drift.missing });
	if (drift.orphaned > 0)
		out.push({ status: "orphaned", count: drift.orphaned });
	if (out.length === 0 && equipped > 0 && drift.up_to_date > 0) {
		out.push({ status: "up_to_date", count: drift.up_to_date });
	}
	return out;
}
