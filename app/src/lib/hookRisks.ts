// ─── Hook risk labels from the mirrored schema (hooks-surface D7) ─────────────
// Hook doctor findings must be LABELLED from the generated risks schema (the same
// `permissions_risks_schema` mirror the permissions UI uses) — never hardcoded —
// so the app stays consistent with the Python doctor. The schema already carries
// the hook codes (HOOK_BROKEN_SCRIPT / HOOK_RUNS_SUDO / LSP_CHECKER_MISSING /
// LSP_INTERPRETER_MISSING) and no longer carries the retired DROPPED_HOOK. This
// helper looks a hook finding's label up from that mirror for whatever surface
// renders it (project card / doctor rollup — the later wave).

import type { RiskSchemaEntry } from "@/types/permissions";

/** The hook-related risk codes carried by the generated schema (risks.py).
 *  Must stay exhaustive over the HOOK_* / LSP_* families risks.py can emit — a
 *  missing code makes `isHookRiskCode` return false for a real finding, which
 *  renders it unlabelled. Pinned bidirectionally by hookHelpers.test.ts. */
export const HOOK_RISK_CODES = [
	"HOOK_BROKEN_SCRIPT",
	"HOOK_RUNS_SUDO",
	"LSP_CHECKER_MISSING",
	"LSP_INTERPRETER_MISSING",
] as const;

export type HookRiskCode = (typeof HOOK_RISK_CODES)[number];

export function isHookRiskCode(code: string): code is HookRiskCode {
	return (HOOK_RISK_CODES as readonly string[]).includes(code);
}

/**
 * Resolve a hook risk code to its schema entry (severity + explanation) from the
 * mirrored risks schema. Returns null when the schema hasn't loaded or the code
 * is absent — callers fall back to showing the raw code rather than a wrong label.
 */
export function hookRiskEntry(
	code: string,
	schema: RiskSchemaEntry[] | undefined,
): RiskSchemaEntry | null {
	if (!schema) return null;
	return schema.find((e) => e.code === code) ?? null;
}

/** Human label for a hook risk code, sourced from the mirror. Falls back to the
 *  raw code when the schema is unavailable (never invents a string). */
export function hookRiskLabel(
	code: string,
	schema: RiskSchemaEntry[] | undefined,
): string {
	return hookRiskEntry(code, schema)?.explanation ?? code;
}
