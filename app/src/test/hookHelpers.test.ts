import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CANONICAL_EVENTS,
	CANONICAL_TOOLS,
	eventSupported,
	hookToolVocabulary,
} from "@/lib/hookCatalog";
import { reachBadges } from "@/lib/hookReach";
import { hookRiskLabel, isHookRiskCode, HOOK_RISK_CODES } from "@/lib/hookRisks";
import type { HookCapabilitiesCache } from "@/hooks/useHooks";
import type { Registry } from "@/types";
import type { RiskSchemaEntry } from "@/types/permissions";
import { sampleRegistry } from "./helpers";

describe("hookCatalog", () => {
	it("pins the canonical event vocabulary", () => {
		expect(CANONICAL_EVENTS).toContain("PostToolUse");
		expect(CANONICAL_EVENTS).toContain("SessionStart");
		expect(CANONICAL_EVENTS.length).toBe(14);
	});

	it("pins CANONICAL_TOOLS in lockstep with subagents.KNOWN_TOOLS (47 tools)", () => {
		// Regression: this list used to be a truncated 11-tool subset. A count
		// pin (not full-content, to keep this test cheap to maintain) catches
		// the next drift the moment either side adds/removes a tool.
		expect(new Set(CANONICAL_TOOLS).size).toBe(CANONICAL_TOOLS.length);
		expect(CANONICAL_TOOLS.length).toBe(47);
		expect(CANONICAL_TOOLS).toContain("Edit");
		expect(CANONICAL_TOOLS).toContain("MultiEdit");
		expect(CANONICAL_TOOLS).toContain("TodoWrite");
	});

	it("gates events per harness (codex is a subset of claude-code)", () => {
		// SessionEnd is claude-only (not in the codex 10-event subset).
		expect(eventSupported("SessionEnd", "claude-code")).toBe(true);
		expect(eventSupported("SessionEnd", "codex")).toBe(false);
		// PostToolUse is supported on both.
		expect(eventSupported("PostToolUse", "codex")).toBe(true);
		// opencode/pi have no hook adapter → no events.
		expect(eventSupported("PostToolUse", "opencode")).toBe(false);
	});

	it("includes canonical tools and dynamic mcp tokens in the picker vocabulary", () => {
		const vocab = hookToolVocabulary(sampleRegistry as Registry);
		expect(vocab).toContain("Edit");
		expect(vocab).toContain("Bash");
		// sampleRegistry has an mcp-server skill `fs-mcp`.
		expect(vocab).toContain("mcp__fs-mcp");
	});
});

// ─── Cross-language catalog parity ────────────────────────────────────────────
// hookCatalog.ts is a HAND-COPIED mirror of tool_catalog.py. Until this suite
// existed each side pinned only its own copy, so adding/renaming an event (or
// moving one into/out of codex's subset) in Python broke only the Python pin —
// and the mirror silently drifted, making the editor's reach display claim a
// hook reaches a harness that `_resolve_matcher` skips at write time (the hook
// never fires, the UI asserts the opposite). Both sides are now asserted against
// ONE shared golden corpus, the same pattern as tests/fixtures/agent_docs_corpus.json.
const CORPUS = JSON.parse(
	readFileSync(
		resolve(process.cwd(), "../tests/fixtures/hook_catalog_corpus.json"),
		"utf-8",
	),
) as {
	canonical_events: string[];
	harness_events: Record<string, string[]>;
	canonical_tools_sorted: string[];
};

describe("hookCatalog ↔ tool_catalog.py parity (shared corpus)", () => {
	it("mirrors CANONICAL_EVENTS in the same order", () => {
		expect([...CANONICAL_EVENTS]).toEqual(CORPUS.canonical_events);
	});

	it("mirrors per-harness event support for every canonical event", () => {
		for (const [harness, supported] of Object.entries(CORPUS.harness_events)) {
			const reached = CORPUS.canonical_events.filter((e) =>
				eventSupported(e, harness),
			);
			expect(reached, harness).toEqual(supported);
		}
	});

	it("mirrors the canonical tool vocabulary", () => {
		expect([...CANONICAL_TOOLS].sort()).toEqual(CORPUS.canonical_tools_sorted);
	});
});

const CAPS: HookCapabilitiesCache = {
	schema_version: 1,
	probed_at: "2026-07-14T00:00:00Z",
	harnesses: {
		"claude-code": {
			harness_id: "claude-code",
			verdict: "supported",
			reason: "ok",
			extra: {},
		},
		codex: { harness_id: "codex", verdict: "feature_off", reason: "off", extra: {} },
		opencode: {
			harness_id: "opencode",
			verdict: "unsupported",
			reason: "no adapter",
			extra: {},
		},
		pi: { harness_id: "pi", verdict: "not_installed", reason: "gone", extra: {} },
	},
};

describe("reachBadges", () => {
	it("maps supported→ok, others→neutral, and omits not_installed", () => {
		const badges = reachBadges(CAPS);
		const byId = Object.fromEntries(badges.map((b) => [b.harnessId, b]));
		expect(byId["claude-code"].tone).toBe("ok");
		expect(byId["codex"].tone).toBe("neutral"); // feature_off is neutral, NOT amber
		expect(byId["opencode"].tone).toBe("neutral");
		expect(byId["pi"]).toBeUndefined(); // not_installed omitted
	});

	it("downgrades an otherwise-reachable harness that doesn't support the event", () => {
		// SessionEnd is unsupported on codex → codex badge becomes event-unsupported.
		const badges = reachBadges(CAPS, "SessionEnd");
		const codex = badges.find((b) => b.harnessId === "codex")!;
		expect(codex.eventUnsupported).toBe(true);
		expect(codex.tone).toBe("neutral");
		// claude-code supports SessionEnd → stays ok.
		expect(badges.find((b) => b.harnessId === "claude-code")!.tone).toBe("ok");
	});

	it("returns [] with no cache", () => {
		expect(reachBadges(null)).toEqual([]);
		expect(reachBadges(undefined)).toEqual([]);
	});
});

describe("hookRisks (labels from the mirrored schema)", () => {
	const schema: RiskSchemaEntry[] = [
		{
			code: "HOOK_BROKEN_SCRIPT",
			severity: "warning",
			explanation: "A hook command references a missing script.",
		},
		{
			code: "LSP_CHECKER_MISSING",
			severity: "warning",
			explanation: "A configured checker binary is not on PATH.",
		},
	];

	it("recognises the hook risk codes and excludes the retired DROPPED_HOOK", () => {
		expect(isHookRiskCode("HOOK_BROKEN_SCRIPT")).toBe(true);
		expect(isHookRiskCode("LSP_CHECKER_MISSING")).toBe(true);
		expect(isHookRiskCode("HOOK_RUNS_SUDO")).toBe(true);
		expect(isHookRiskCode("DROPPED_HOOK")).toBe(false);
		expect(HOOK_RISK_CODES).not.toContain("DROPPED_HOOK");
	});

	it("labels a code from the schema mirror, not a hardcoded string", () => {
		expect(hookRiskLabel("HOOK_BROKEN_SCRIPT", schema)).toBe(
			"A hook command references a missing script.",
		);
		// Falls back to the raw code when the schema is unavailable.
		expect(hookRiskLabel("HOOK_BROKEN_SCRIPT", undefined)).toBe(
			"HOOK_BROKEN_SCRIPT",
		);
	});
});

// ─── HOOK_RISK_CODES ↔ risks.py emit_schema() parity ─────────────────────────
// `HOOK_RISK_CODES` is a hand-maintained mirror of the hook-library codes in
// risks.py. `isHookRiskCode` is the filter for whatever surface renders hook
// findings, so a code missing from the list is silently classified as
// not-a-hook-risk and dropped from the UI. Nothing cross-checked the two lists;
// these read the LIVE Python schema (the exact source the Rust build embeds via
// build.rs → risks.generated.json) instead of a second hardcoded copy.

function pythonRiskSchema(): { code: string; severity: string }[] | null {
	const repoRoot = resolve(process.cwd(), "..");
	const proc = spawnSync(
		"python3",
		["-c", "import risks, sys; sys.stdout.write(risks.emit_schema_json())"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	if (proc.status !== 0 || !proc.stdout) return null;
	return JSON.parse(proc.stdout);
}

describe("hookRisks ↔ risks.py emit_schema parity", () => {
	const schema = pythonRiskSchema();

	it("actually read the generated schema (guards a vacuous parity pass)", () => {
		// python3 is a hard dependency of this repo (see cliContract.test.ts); a
		// null schema here would make every parity assertion below vacuous.
		expect(schema).not.toBeNull();
		expect(schema!.length).toBeGreaterThan(0);
	});

	it("every code in HOOK_RISK_CODES exists in the generated schema", () => {
		if (!schema) return;
		const codes = new Set(schema.map((e) => e.code));
		for (const code of HOOK_RISK_CODES) {
			expect(codes, `${code} is not emitted by risks.py`).toContain(code);
		}
	});

	it("mirrors EVERY hook code Python emits (no unlabelled findings)", () => {
		if (!schema) return;
		// Hook-library codes are exactly the HOOK_* / LSP_* families in risks.py.
		const pythonHookCodes = schema
			.map((e) => e.code)
			.filter((c) => c.startsWith("HOOK_") || c.startsWith("LSP_"))
			.sort();
		const missing = pythonHookCodes.filter(
			(c) => !(HOOK_RISK_CODES as readonly string[]).includes(c),
		);
		// The drift this pin used to record (LSP_INTERPRETER_MISSING emitted by
		// risks.py but absent from hookRisks.ts, so `isHookRiskCode` returned
		// false and the finding rendered unlabelled) is fixed. An empty set is
		// now the contract: adding a hook code to risks.py without mirroring it
		// into HOOK_RISK_CODES fails here.
		expect(missing).toEqual([]);
	});

	it("carries no TS-only code that Python cannot emit", () => {
		if (!schema) return;
		const codes = new Set(schema.map((e) => e.code));
		expect(
			(HOOK_RISK_CODES as readonly string[]).filter((c) => !codes.has(c)),
		).toEqual([]);
	});
});
