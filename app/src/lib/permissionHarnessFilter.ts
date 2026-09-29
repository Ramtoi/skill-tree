// Harness-filter derivation for the permissions editor. Drives the segmented
// "All · Common · <harness…>" control from the SAME capability data the
// affinity chips read (`harnessSupportsRule`) — never a second hardcoded
// matrix.
//
// Definitions:
//   - "Common"      → a rule expressible on EVERY installed harness (i.e. every
//                     installed harness can honor the rule given its capability
//                     set + per-rule pattern caveats). For the universal
//                     three-verb Bash model this is the portable core.
//   - "<harness>"   → a rule that applies to that harness: it is supported by
//                     the harness AND the rule's affinity does not exclude it.

import {
	harnessSupportsRule,
	type Capabilities,
	type Rule,
} from "@/types/permissions";

export type HarnessFilter = "all" | "common" | { harness: string };

export const ALL_FILTER: HarnessFilter = "all";
export const COMMON_FILTER: HarnessFilter = "common";

export function filterKey(filter: HarnessFilter): string {
	if (filter === "all") return "all";
	if (filter === "common") return "common";
	return `harness:${filter.harness}`;
}

export function filtersEqual(a: HarnessFilter, b: HarnessFilter): boolean {
	return filterKey(a) === filterKey(b);
}

/** Whether the rule's affinity includes a harness (null/undefined ⇒ all). */
export function affinityIncludes(rule: Rule, harnessId: string): boolean {
	const explicit = rule.harnesses ?? null;
	return explicit === null || explicit.includes(harnessId);
}

/**
 * A rule "applies to" a harness when the harness can express it (capability +
 * pattern caveat) AND the rule's affinity does not exclude it.
 */
export function ruleAppliesToHarness(
	rule: Rule,
	harnessId: string,
	capabilities: Capabilities,
): boolean {
	return (
		harnessSupportsRule(harnessId, rule, capabilities) &&
		affinityIncludes(rule, harnessId)
	);
}

/**
 * "Common" = expressible on EVERY installed harness (ignores affinity — it's a
 * portability question, not a targeting one). With no installed harnesses,
 * nothing is common.
 */
export function ruleIsCommon(
	rule: Rule,
	installed: string[],
	capabilities: Capabilities,
): boolean {
	if (installed.length === 0) return false;
	return installed.every((id) => harnessSupportsRule(id, rule, capabilities));
}

/** Apply the active harness filter to a single rule. */
export function ruleMatchesFilter(
	rule: Rule,
	filter: HarnessFilter,
	installed: string[],
	capabilities: Capabilities,
): boolean {
	if (filter === "all") return true;
	if (filter === "common") return ruleIsCommon(rule, installed, capabilities);
	return ruleAppliesToHarness(rule, filter.harness, capabilities);
}
