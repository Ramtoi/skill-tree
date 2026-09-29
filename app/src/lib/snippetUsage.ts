import type { SnippetLocation, SnippetUsage } from "@/types/snippets";

/**
 * Client-side mirror of Python's `snippets.usage_rollup` (see `snippets.py`).
 * The editor already has the location list from `snippet status --name` (one
 * walk, shared with the applied-locations panel), so it computes the same
 * roll-up locally instead of waiting on a second scan from `snippet show`.
 *
 * Worst-status rule, matching the library exactly: modified > outdated >
 * applied > none.
 */
export function usageRollup(locations: SnippetLocation[]): SnippetUsage {
	let summary: SnippetUsage["summary"];
	if (locations.some((l) => l.status === "modified")) {
		summary = "modified";
	} else if (locations.some((l) => l.status === "outdated")) {
		summary = "outdated";
	} else if (locations.length > 0) {
		summary = "applied";
	} else {
		summary = "none";
	}
	return {
		count: locations.length,
		summary,
		outdated_count: locations.filter((l) => l.status === "outdated").length,
		locations,
	};
}
