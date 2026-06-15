// Pure TS evaluator that mirrors Python's risks.detect_risks. Pattern table
// (code/severity/explanation) is the single SoT, loaded at runtime from the
// embedded `risks.generated.json` via the `permissions_risks_schema` Tauri
// command. Predicate logic IS duplicated from risks.py — kept in lockstep by
// a golden-output Vitest test (app/src/test/permissionsRisks.test.ts).

import type {
	NormalizedPermissions,
	RiskFinding,
	RiskSchemaEntry,
} from "@/types/permissions";

const UNBOUNDED_BASH_RE = /^Bash\(\*\)$|^Bash:\*$/;
const UNBOUNDED_WRITE_RE = /^Write\(\*\)$|^Write:\*$|^Edit\(\*\)$/;
const UNBOUNDED_FETCH_RE = /^WebFetch\(\*\)$|^WebFetch:\*$/;
const SUDO_RE = /(?:^|[\s;|&])sudo(?:\s|$)/;

function checkUnbounded(perms: NormalizedPermissions, re: RegExp): string[] {
	return perms.allow.filter((r) => re.test(r.pattern)).map((r) => r.pattern);
}

type Predicate = (perms: NormalizedPermissions) => string[];

const PREDICATES: Record<string, Predicate> = {
	UNBOUNDED_BASH: (p) => checkUnbounded(p, UNBOUNDED_BASH_RE),
	UNBOUNDED_WRITE: (p) => checkUnbounded(p, UNBOUNDED_WRITE_RE),
	UNBOUNDED_FETCH: (p) => checkUnbounded(p, UNBOUNDED_FETCH_RE),
	UNSAFE_CODEX_COMBO: (p) =>
		p.approval_policy === "never" && p.sandbox_mode === "danger-full-access"
			? ["approval_policy=never + sandbox_mode=danger-full-access"]
			: [],
	HOOK_RUNS_SUDO: (p) =>
		p.hooks
			.filter((h) => SUDO_RE.test(h.command ?? ""))
			.map((h) => `${h.event}/${h.matcher}: ${h.command}`),
};

const SEVERITY_RANK: Record<string, number> = { danger: 0, warning: 1 };

export function detectRisks(
	perms: NormalizedPermissions,
	schema: RiskSchemaEntry[],
): RiskFinding[] {
	const findings: RiskFinding[] = [];
	for (const pat of schema) {
		const pred = PREDICATES[pat.code];
		if (!pred) continue;
		const details = pred(perms);
		for (const detail of details) {
			findings.push({
				code: pat.code,
				severity: pat.severity,
				explanation: pat.explanation,
				detail,
			});
		}
	}
	findings.sort((a, b) => {
		const sa = SEVERITY_RANK[a.severity] ?? 99;
		const sb = SEVERITY_RANK[b.severity] ?? 99;
		if (sa !== sb) return sa - sb;
		if (a.code !== b.code) return a.code < b.code ? -1 : 1;
		return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
	});
	return findings;
}

/** Index findings by the rule pattern that triggered them (for inline badges). */
export function findingsByPattern(
	findings: RiskFinding[],
): Record<string, RiskFinding[]> {
	const out: Record<string, RiskFinding[]> = {};
	const seen = new Set<string>();
	for (const f of findings) {
		// Use the detail string as the key. For UNBOUNDED_* the detail IS the
		// pattern; for UNSAFE_CODEX_COMBO and HOOK_RUNS_SUDO the detail is a
		// synthetic key — callers map those separately. Deduplicate by finding
		// identity so duplicate rules do not attach repeated badges to every row.
		const identity = `${f.detail}\u0000${f.code}\u0000${f.severity}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		if (!out[f.detail]) out[f.detail] = [];
		out[f.detail].push(f);
	}
	return out;
}

/** Worst-severity in a finding list, for section-header badges. */
export function worstSeverity(
	findings: RiskFinding[],
): "danger" | "warning" | null {
	if (findings.some((f) => f.severity === "danger")) return "danger";
	if (findings.some((f) => f.severity === "warning")) return "warning";
	return null;
}
