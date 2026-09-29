import { describe, it, expect } from "vitest";
import {
	endpointLabel,
	secretRefsOf,
	literalSecretKeysOf,
	suggestRef,
	slugifyServerName,
	boundedDetail,
	placeLabel,
	deliveryReasonLine,
	warningLine,
	adoptionConsequences,
	maskQueryParam,
	MCP_DELIVERY_REASON_COPY,
	MCP_DOCTOR_FINDING_COPY,
	probeStateLine,
	parameterTypeLabel,
	capabilityCountsLine,
	catalogFetchErrorLine,
	truncationLine,
	catalogEmptyReason,
	titledLabel,
	annotationChips,
	ANNOTATION_HINT_TITLE,
	type McpDeliveryReason,
	type McpCandidate,
	type McpProbe,
	type McpProbeState,
	type McpScope,
	type McpUnsupportedReason,
	type McpFailureCode,
	type McpCatalogSummary,
	type McpToolParameter,
	type McpToolAnnotations,
} from "@/lib/mcpContract";
import type { McpSpec } from "@/types";
import corpus from "../../../tests/fixtures/mcp_secret_corpus.json";
import vocabulary from "../../../tests/fixtures/mcp_vocabulary.json";

const secretCorpus = corpus as {
	cases: { key: string; value: string; secret: boolean; note: string }[];
	suggest: { server: string; key: string; value: string; expect_value: string; expect_var: string }[];
	patterns: unknown;
};

const vocab = vocabulary as {
	delivery_states: string[];
	delivery_reasons: string[];
	probe_states: string[];
	doctor_findings: string[];
	unsupported_reasons: string[];
	warning_words: string[];
	failure_codes: string[];
};

/** W6: the vocabulary lives in ONE shared fixture (`tests/fixtures/mcp_vocabulary.json`),
 *  read by this test and by `tests/test_mcp_delivery.py`, which asserts it equals
 *  `mcp_delivery.DELIVERY_REASONS`. So a word added or dropped on the Python side
 *  fails here instead of at runtime (W1's fallback still covers a version skew). */
const ACTIVE_DELIVERY_REASONS = vocab.delivery_reasons;

// Case 1 — endpointLabel
describe("endpointLabel", () => {
	it("returns the url for http/sse", () => {
		expect(endpointLabel({ transport: "http", url: "https://mcp.example.com/mcp" })).toBe(
			"https://mcp.example.com/mcp",
		);
		expect(endpointLabel({ transport: "sse", url: "https://sse.example.com" })).toBe(
			"https://sse.example.com",
		);
	});
	it("returns command + args for stdio", () => {
		expect(
			endpointLabel({ transport: "stdio", command: "npx", args: ["-y", "@scope/pkg"] }),
		).toBe("npx -y @scope/pkg");
	});
	it("returns '' for a bare spec", () => {
		expect(endpointLabel({})).toBe("");
		expect(endpointLabel({ transport: "http" })).toBe("");
	});
});

// Case 2 — secretRefsOf
describe("secretRefsOf", () => {
	it("collects refs across env, headers and url, deduped and ordered", () => {
		const spec: McpSpec = {
			transport: "http",
			url: "https://x.example/${REGION}",
			headers: { Authorization: "Bearer ${TOKEN}" },
			env: { EXTRA: "${TOKEN}" },
		};
		expect(secretRefsOf(spec)).toEqual(["REGION", "TOKEN"]);
	});
	it("is empty for a spec with no references", () => {
		expect(secretRefsOf({ transport: "stdio", command: "python3" })).toEqual([]);
	});
});

// Case 3 (m12) — literalSecretKeysOf driven by the shared corpus fixture
describe("literalSecretKeysOf (corpus-driven, m12)", () => {
	for (const c of secretCorpus.cases) {
		it(`${JSON.stringify(c.key)}/${JSON.stringify(c.value)} → secret=${c.secret} (${c.note})`, () => {
			const spec: McpSpec = { transport: "http", url: "https://x", headers: { [c.key]: c.value } };
			const keys = literalSecretKeysOf(spec);
			expect(keys.includes(c.key)).toBe(c.secret);
		});
	}

	it("compiles its patterns from the fixture, not a TS-source literal", () => {
		// A pattern present in the fixture but absent from any plausible
		// hand-written literal (the exact opaque_re threshold, 20 chars) is
		// exercised by the corpus cases above; this assertion pins that the
		// fixture's own `patterns` block is what decides `secret`, by checking
		// a value that is secret ONLY via the corpus's opaque_re threshold.
		const opaqueCase = secretCorpus.cases.find((c) => c.note.startsWith("opaque_re"));
		expect(opaqueCase).toBeDefined();
	});
});

// Case 4 (m5, m12) — suggestRef driven by the corpus's suggest table
describe("suggestRef (corpus-driven, m5/m12)", () => {
	for (const s of secretCorpus.suggest) {
		it(`${s.server}/${s.key} → ${s.expect_value}`, () => {
			const result = suggestRef(s.server, s.key, s.value);
			expect(result.value).toBe(s.expect_value);
			expect(result.varName).toBe(s.expect_var);
		});
	}
});

// Case 5 (F3) — reason→copy completeness, and the removed words stay removed.
// W6: reads the SHARED fixture (also asserted against `mcp_delivery.py` in
// `tests/test_mcp_delivery.py`) instead of a hand-copied array — a reason
// word added to INTERFACES §4 and to `mcp_delivery.DELIVERY_REASONS` by a
// future wave now fails HERE if the copy table doesn't grow with it.
describe("MCP_DELIVERY_REASON_COPY completeness (F3)", () => {
	it("every ACTIVE reason word has a non-empty copy line", () => {
		for (const reason of ACTIVE_DELIVERY_REASONS as McpDeliveryReason[]) {
			expect(deliveryReasonLine(reason, null).length).toBeGreaterThan(0);
		}
		expect(Object.keys(MCP_DELIVERY_REASON_COPY).sort()).toEqual(
			[...ACTIVE_DELIVERY_REASONS].sort(),
		);
	});

	it("source_disabled and opencode_no_global are absent (dropped from the wave-C contract, m2)", () => {
		expect(Object.keys(MCP_DELIVERY_REASON_COPY)).not.toContain("source_disabled");
		expect(Object.keys(MCP_DELIVERY_REASON_COPY)).not.toContain("opencode_no_global");
		expect(vocab.delivery_reasons).not.toContain("source_disabled");
	});
});

// W1 — a vocabulary word this build does not recognize degrades instead of
// throwing (a differently-versioned `hub`; this exact vocabulary already
// churned once mid-flight).
describe("W1 — unrecognized-vocabulary fallbacks", () => {
	it("deliveryReasonLine falls back to the raw word for an unknown reason", () => {
		expect(deliveryReasonLine("a_reason_no_wave_has_shipped", null)).toBe(
			"a_reason_no_wave_has_shipped",
		);
	});

	it("probeStateLine falls back to a neutral line for an unknown state", () => {
		const probe = {
			name: "context7",
			transport: "http" as const,
			state: "a_state_no_wave_has_shipped" as unknown as McpProbeState,
			tool_count: null,
			tools: [],
			latency_ms: null,
			protocol_version: null,
			unresolved_refs: [],
			env_from_shell: true,
			error: null,
			checked_at: "2026-09-06T00:00:00Z",
		};
		const { text, tone } = probeStateLine(probe);
		expect(text.length).toBeGreaterThan(0);
		expect(tone).toBe("neutral");
	});
});

// Case 6 — detail substitution
describe("deliveryReasonLine detail substitution", () => {
	it("substitutes <detail>, never printing the placeholder literally", () => {
		const line = deliveryReasonLine("codex_header_not_representable", "X-Trace");
		expect(line).toContain("X-Trace");
		expect(line).not.toContain("<detail>");
	});
	it("codex_env_not_representable substitutes its detail", () => {
		const line = deliveryReasonLine("codex_env_not_representable", "MY_VAR");
		expect(line).toContain("MY_VAR");
	});
	it("opencode_default_dropped substitutes its detail", () => {
		const line = deliveryReasonLine("opencode_default_dropped", "API_KEY");
		expect(line).toContain("API_KEY");
	});
});

// Case 7 — every probe state has a line and a tone (W6: read from the shared
// fixture, also asserted against `mcp_probe.PROBE_STATES` in
// `tests/test_mcp_delivery.py`).
describe("probeStateLine completeness", () => {
	const STATES = vocab.probe_states as McpProbeState[];

	function probeFor(state: McpProbeState): McpProbe {
		return {
			name: "context7",
			transport: "http",
			state,
			tool_count: 3,
			tools: ["a", "b", "c"],
			latency_ms: 312,
			protocol_version: "2024-11-05",
			unresolved_refs: state === "unresolved_ref" ? ["MY_TOKEN"] : [],
			env_from_shell: true,
			error: state === "unreachable" ? "connection refused" : null,
			checked_at: "2026-09-06T00:00:00Z",
		};
	}

	for (const state of STATES) {
		it(`${state} has a non-empty line and a tone`, () => {
			const { text, tone } = probeStateLine(probeFor(state));
			expect(text.length).toBeGreaterThan(0);
			expect(tone.length).toBeGreaterThan(0);
		});
	}
});

// Case 7b — doctor finding id → copy completeness (twinned with wave C's case
// 40; W6: no Python constant exists for this vocabulary, so the fixture is
// still the one hand-source, but at least it is the SAME one the reason/state
// lists come from rather than a fourth copy).
describe("MCP_DOCTOR_FINDING_COPY completeness (7b)", () => {
	const FINDING_IDS = vocab.doctor_findings;

	it("every doctor finding id has a non-empty line", () => {
		for (const id of FINDING_IDS) {
			expect(MCP_DOCTOR_FINDING_COPY[id]?.length).toBeGreaterThan(0);
		}
		expect(Object.keys(MCP_DOCTOR_FINDING_COPY).sort()).toEqual([...FINDING_IDS].sort());
	});
});

// ─── E3 rev 2 §5 case 18 — the scope union (with `global`), McpUnsupportedReason,
// the warning words, and McpFailureCode, all pinned against mcp_vocabulary.json —
// the same exhaustiveness pattern §5 case 5 already uses for delivery reasons. ─

describe("McpScope exhaustiveness (case 18)", () => {
	// Every scope word the backend can emit for a candidate source/option
	// (INTERFACES §3): Claude's own "user" alongside the "global" word every
	// other harness's user-level config uses (grill finding 5 — this union
	// widening IS the fix; a `Record<McpScope, string>` that fails to compile
	// once a word is added or removed is the whole point).
	const SCOPE_WORDS: McpScope[] = ["user", "local", "project", "global"];
	const SCOPE_LABEL: Record<McpScope, string> = {
		user: "user",
		local: "local",
		project: "project",
		global: "global",
	};

	it("placeLabel renders every scope word, never a dangling separator", () => {
		for (const scope of SCOPE_WORDS) {
			expect(placeLabel("codex", scope)).toBe(`Codex (${SCOPE_LABEL[scope]})`);
		}
	});

	it("the F5 registry pseudo-option renders with no scope and no path", () => {
		expect(placeLabel("registry", null)).toBe("Skill Tree's own record");
	});

	it("a codex global-scope place reads 'Codex (global)' (red on main before the fix: no such word existed)", () => {
		expect(placeLabel("codex", "global")).toBe("Codex (global)");
	});
});

describe("McpUnsupportedReason completeness (case 18)", () => {
	const REASONS = vocab.unsupported_reasons as McpUnsupportedReason[];

	it("every word in the fixture is a member of the TS union (compile-time exhaustiveness)", () => {
		// A `switch` over `McpUnsupportedReason` with every fixture word as a
		// case, plus a `default: never` fallthrough — this FAILS TO COMPILE
		// the moment `mcp_vocabulary.json` grows a word this file's own union
		// (`McpUnsupportedReason` in `mcpContract.ts`) does not also carry.
		function assertKnown(reason: McpUnsupportedReason): true {
			switch (reason) {
				case "ws_transport":
				case "oauth_block":
				case "headers_helper":
				case "unknown_shape":
				case "local_scope_unregistered_project":
				case "no_global_target":
				case "invalid_name":
				case "name_taken":
				case "unknown_transport":
				case "transport_conflict":
				case "no_endpoint":
				case "malformed_url":
				case "unsupported_url_scheme":
				case "malformed_field":
				case "duplicate_header":
				case "disabled_upstream":
				case "unreadable_file":
					return true;
			}
		}
		for (const r of REASONS) expect(assertKnown(r)).toBe(true);
		// And the reverse: no TS-only word the fixture doesn't know either.
		const TS_WORDS: McpUnsupportedReason[] = [
			"ws_transport",
			"oauth_block",
			"headers_helper",
			"unknown_shape",
			"local_scope_unregistered_project",
			"no_global_target",
			"invalid_name",
			"name_taken",
			"unknown_transport",
			"transport_conflict",
			"no_endpoint",
			"malformed_url",
			"unsupported_url_scheme",
			"malformed_field",
			"duplicate_header",
			"disabled_upstream",
			"unreadable_file",
		];
		expect([...TS_WORDS].sort()).toEqual([...REASONS].sort());
	});
});

describe("warning word copy (case 18)", () => {
	it("every warning word in the fixture renders a non-empty dim line", () => {
		for (const w of vocab.warning_words) {
			// `:<detail>` words need a detail to render their real sentence —
			// a bare word still must not come back empty (the default
			// fallback renders the word itself, `_` → space).
			expect(warningLine(w).length).toBeGreaterThan(0);
			expect(warningLine(`${w}:some-detail`).length).toBeGreaterThan(0);
		}
	});

	// N8: the assertion above can never fail — `warningLine`'s default
	// branch always returns a non-empty string, so it pins the function's
	// mere existence, nothing about what any WORD actually maps to. Pin the
	// real behavior instead: a word with its own named §2.6 case renders
	// DIFFERENTLY from the mechanical `word.replace(/_/g," "):detail`
	// fallback every other (unnamed) word intentionally falls through to.
	it("every warning word maps to a genuine copy line, not just the mechanical fallback shape", () => {
		const NAMED_CASES = new Set([
			"renamed_from",
			"command_has_arguments",
			"command_list_split",
			"dropped_field",
		]);
		for (const w of vocab.warning_words) {
			const withDetail = warningLine(`${w}:some-detail`);
			const mechanicalFallback = `${w.replace(/_/g, " ")}: some-detail`;
			if (NAMED_CASES.has(w)) {
				expect(withDetail).not.toBe(mechanicalFallback);
			} else {
				// An unnamed word is DESIGNED to fall through to the mechanical
				// shape (E3 rev 2 §2.6: "others use the word as-is, `_` → space,
				// `:<detail>` appended") — pinning it here means a word quietly
				// moved OFF that fallback (a copy line added without updating
				// `NAMED_CASES`) fails loudly instead of this test staying green.
				expect(withDetail).toBe(mechanicalFallback);
			}
		}
	});

	it("renamed_from needs the resolved name to say what it becomes", () => {
		expect(warningLine("renamed_from:Sanity", "sanity")).toBe("registered as sanity");
		expect(warningLine("renamed_from:Sanity")).toBe("registered under a different name");
	});
});

describe("McpFailureCode completeness (case 18)", () => {
	const CODES = vocab.failure_codes as McpFailureCode[];

	it("every code in the fixture is a member of the TS union (compile-time exhaustiveness)", () => {
		function assertKnown(code: McpFailureCode): true {
			switch (code) {
				case "literal_secret":
				case "invalid_name":
				case "name_taken":
				case "name_collision_in_batch":
				case "ambiguous_option":
				case "unknown_candidate":
				case "invalid_spec":
				case "invalid_json":
				case "no_catalog":
				case "other":
					return true;
			}
		}
		for (const c of CODES) expect(assertKnown(c)).toBe(true);
		const TS_CODES: McpFailureCode[] = [
			"literal_secret",
			"invalid_name",
			"name_taken",
			"name_collision_in_batch",
			"ambiguous_option",
			"unknown_candidate",
			"invalid_spec",
			"invalid_json",
			"no_catalog",
			"other",
		];
		expect([...TS_CODES].sort()).toEqual([...CODES].sort());
	});
});

// ─── E3 rev 2 §5 case 17 — slugifyServerName pinned against the shared H02/E06
// secret corpus's OWN server/key pairs is redundant with mcpImportCorpus.test.ts's
// full 66-id sweep; this file adds only the NFKD/combining-mark edge the secret
// corpus doesn't otherwise exercise, to keep both fixtures pulling their weight. ─
describe("slugifyServerName (case 17, spot checks — the full pin lives in mcpImportCorpus.test.ts)", () => {
	it("NFKD-decomposes and drops combining marks", () => {
		expect(slugifyServerName("Grüße")).toBe("gru-e");
	});
	it("refuses separator debris and a bare . or ..", () => {
		expect(slugifyServerName("../../etc")).toBeNull();
		expect(slugifyServerName(".")).toBeNull();
		expect(slugifyServerName("..")).toBeNull();
	});
	it("refuses empty, non-string, and whitespace-only input", () => {
		expect(slugifyServerName("")).toBeNull();
		expect(slugifyServerName("   ")).toBeNull();
		expect(slugifyServerName(undefined)).toBeNull();
		expect(slugifyServerName(42)).toBeNull();
	});
	it("has no length refusal", () => {
		const long = "a".repeat(80);
		expect(slugifyServerName(long)).toBe(long);
	});
	// N2 / N1-new: Python drops a decomposed character only when its Unicode
	// CANONICAL COMBINING CLASS is non-zero — a Devanagari spacing vowel
	// sign (Mc, ccc=0) is one Python KEEPS (then collapses to `-`); this
	// twin's `\p{Mn}`-only strip must agree, not the wider `\p{M}` a naive
	// port would reach for. The string is the review's own probe P5 —
	// `"a" + U+093E + "b"`, NOT `"aनाb"` (a full "ना" syllable, whose leading
	// consonant "न" is unaffected by either regex, so it slugifies to `a-b`
	// under BOTH `\p{Mn}` and the wider `\p{M}` and cannot go red on the
	// pre-fix code — the bug this case exists to catch).
	it("keeps a spacing combining mark (Mc, ccc=0) — collapses to '-', never dropped outright", () => {
		expect(slugifyServerName(`a${String.fromCodePoint(0x093e)}b`)).toBe("a-b");
	});
});

// ─── W5 — boundedDetail, the TS twin of `mcp_spec._bounded_detail` ───────────

describe("boundedDetail (W5)", () => {
	it("replaces a NUL byte (and other non-printables) with U+FFFD", () => {
		const nul = String.fromCharCode(0);
		expect(boundedDetail(`a${nul}b`)).toBe("a�b");
	});
	it("caps at 40 characters with a trailing ellipsis", () => {
		const long = "a".repeat(5000);
		const result = boundedDetail(long);
		expect(result).toBe(`${"a".repeat(39)}…`);
		expect(result.length).toBe(40);
	});
	it("leaves a short, printable string untouched", () => {
		expect(boundedDetail("Sanity")).toBe("Sanity");
	});
	it("keeps the ASCII space printable", () => {
		expect(boundedDetail("a b")).toBe("a b");
	});
	it("stringifies a non-string input rather than throwing", () => {
		expect(boundedDetail(42)).toBe("42");
	});
});

// ─── N3 — maskQueryParam masks WITHOUT percent-encoding the mask itself ──────

describe("maskQueryParam (N3)", () => {
	it("masks the value with a literal bullet string, not URLSearchParams.set's percent-encoding", () => {
		const masked = maskQueryParam("https://x.example.com/mcp?token=sk-live-abc&other=1", "token");
		expect(masked).toBe("https://x.example.com/mcp?token=••••••&other=1");
		expect(masked).not.toContain("%E2%80%A2");
	});
	it("leaves the URL unchanged when the param is absent", () => {
		const url = "https://x.example.com/mcp?other=1";
		expect(maskQueryParam(url, "token")).toBe(url);
	});
	it("returns the input unchanged for an unparseable URL", () => {
		expect(maskQueryParam("not a url", "token")).toBe("not a url");
	});
});

// ─── W3 — adoptionConsequences mirrors the 2.3 scope rule per scope kind ─────

describe("adoptionConsequences (W3)", () => {
	function candWithSources(
		sources: McpCandidate["sources"],
		options: McpCandidate["options"],
		warnings: string[] = [],
	): McpCandidate {
		return {
			name: "context7",
			status: "conflict",
			spec: null,
			sources,
			options,
			reason: null,
			warnings,
			import_name: "context7",
		};
	}

	it("global scope: every OTHER source Updates, the chosen one gets no line", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "context7", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "context7", native: {} },
			],
			[
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", spec: { transport: "http", url: "a" } },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", spec: { transport: "http", url: "b" } },
			],
		);
		const lines = adoptionConsequences(cand, cand.options[0], "global");
		expect(lines).toEqual([{ place: "Codex (global)", verb: "Updates" }]);
	});

	it("project scope: a Claude LOCAL source Removes UNCONDITIONALLY — winner or loser", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "local", file: "~/.claude.json", name: "context7", native: {} },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", name: "context7", native: {} },
			],
			[
				{ harness: "claude-code", scope: "local", file: "~/.claude.json", spec: { transport: "http", url: "a" } },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", spec: { transport: "http", url: "b" } },
			],
		);
		// Adopting the LOCAL copy itself still removes it — the bug C1's
		// review found ("adopting the local copy never shows Removes").
		const lines = adoptionConsequences(cand, cand.options[0], "project");
		expect(lines).toContainEqual({ place: "Claude Code (local)", verb: "Removes" });
		expect(lines).toContainEqual({ place: "Codex (project)", verb: "Updates" });
	});

	it("project scope: a non-local source whose block already matches the chosen one gets no consequence line", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "project", file: ".mcp.json", name: "context7", native: {} },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", name: "context7", native: {} },
			],
			[
				{ harness: "claude-code", scope: "project", file: ".mcp.json", spec: { transport: "http", url: "same" } },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", spec: { transport: "http", url: "same" } },
			],
		);
		const lines = adoptionConsequences(cand, cand.options[0], "project");
		expect(lines).toEqual([]);
	});

	// ─── W9 — a renamed candidate Removes every native source, at EITHER
	// scope kind, before the scope branches ever run (never "Updates" where
	// the apply actually deletes the entry).

	it("W9: a renamed candidate Removes every source at GLOBAL scope, chosen one included", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", name: "Sanity", native: {} },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", name: "sanity", native: {} },
			],
			[
				{ harness: "claude-code", scope: "user", file: "~/.claude.json", spec: { transport: "http", url: "a" } },
				{ harness: "codex", scope: "global", file: "~/.codex/config.toml", spec: { transport: "http", url: "b" } },
			],
			["renamed_from:Sanity"],
		);
		const lines = adoptionConsequences(cand, cand.options[0], "global");
		expect(lines).toEqual([
			{ place: "Claude Code (user)", verb: "Removes" },
			{ place: "Codex (global)", verb: "Removes" },
		]);
	});

	it("W9: a renamed candidate Removes every source at PROJECT scope too", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "project", file: ".mcp.json", name: "Sanity", native: {} },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", name: "sanity", native: {} },
			],
			[
				{ harness: "claude-code", scope: "project", file: ".mcp.json", spec: { transport: "http", url: "a" } },
				{ harness: "codex", scope: "project", file: ".codex/config.toml", spec: { transport: "http", url: "b" } },
			],
			["renamed_from:Sanity"],
		);
		const lines = adoptionConsequences(cand, cand.options[1], "project");
		expect(lines).toEqual([
			{ place: "Claude Code (project)", verb: "Removes" },
			{ place: "Codex (project)", verb: "Removes" },
		]);
	});

	// ─── N4-new — the project-scope Removes gate is `scope === "local"` alone
	// (`_apply_project_scope_ownership`, `hub_cli/mcp.py:1788`), not also
	// `harness === "claude-code"`. Only Claude emits `local` today, but the
	// rule itself never checks the harness.

	it("N4-new: a non-Claude source at 'local' scope also Removes unconditionally", () => {
		const cand = candWithSources(
			[
				{ harness: "codex", scope: "local", file: "~/.codex/somewhere.toml", name: "context7", native: {} },
				{ harness: "claude-code", scope: "project", file: ".mcp.json", name: "context7", native: {} },
			],
			[
				{ harness: "codex", scope: "local", file: "~/.codex/somewhere.toml", spec: { transport: "http", url: "a" } },
				{ harness: "claude-code", scope: "project", file: ".mcp.json", spec: { transport: "http", url: "b" } },
			],
		);
		const lines = adoptionConsequences(cand, cand.options[1], "project");
		expect(lines).toContainEqual({ place: "Codex (local)", verb: "Removes" });
	});

	// ─── N5-new — a source with NO matching option (two identical native
	// copies collapsed to one option) gets no consequence line at all
	// (Python: `entry is None: continue`, `hub_cli/mcp.py:1805-1806`), never
	// an unconditional "Updates".

	it("N5-new: a source with no matching option gets no line, not an unconditional Updates", () => {
		const cand = candWithSources(
			[
				{ harness: "claude-code", scope: "project", file: ".mcp.json", name: "context7", native: {} },
				{ harness: "opencode", scope: "project", file: "opencode.json", name: "context7", native: {} },
			],
			// Only ONE option: opencode's copy collapsed with claude-code's
			// (identical spec) — claude-code's source has no matching option.
			[{ harness: "opencode", scope: "project", file: "opencode.json", spec: { transport: "http", url: "same" } }],
		);
		const lines = adoptionConsequences(cand, cand.options[0], "project");
		expect(lines).toEqual([]);
	});
});

// ─── plans/G.md §6/§7, rev 3 §11 — the MCP capability catalogue ─────────────

function param(p: Partial<McpToolParameter> & { name: string }): McpToolParameter {
	return {
		type: null,
		required: false,
		description: null,
		enum: null,
		enum_truncated: false,
		default: null,
		items_type: null,
		...p,
	};
}

describe("parameterTypeLabel (§5.7 rows, case 6.1)", () => {
	it("returns the type verbatim for a plain scalar", () => {
		expect(parameterTypeLabel(param({ name: "q", type: "string" }))).toBe("string");
	});
	it("returns a union verbatim (already pipe-joined by the backend)", () => {
		expect(parameterTypeLabel(param({ name: "q", type: "string|null" }))).toBe("string|null");
	});
	it("returns '<items_type>[]' for an array", () => {
		expect(parameterTypeLabel(param({ name: "filters", type: "array", items_type: "object" }))).toBe("object[]");
	});
	it("falls back to 'any[]' for an array with no items_type", () => {
		expect(parameterTypeLabel(param({ name: "filters", type: "array", items_type: null }))).toBe("any[]");
	});
	it("returns '—' for a null type", () => {
		expect(parameterTypeLabel(param({ name: "mystery", type: null }))).toBe("—");
	});
});

function summary(overrides: Partial<McpCatalogSummary> = {}): McpCatalogSummary {
	return {
		tools: 0,
		resources: 0,
		resource_templates: 0,
		prompts: 0,
		offered: { tools: false, resources: false, resource_templates: false, prompts: false },
		unknown: [],
		server_name: null,
		server_version: null,
		instructions: false,
		errors: 0,
		...overrides,
	};
}

describe("capabilityCountsLine (grill F12, one case per branch)", () => {
	it("omits a kind the server does not offer", () => {
		const s = summary({ offered: { tools: true, resources: false, resource_templates: false, prompts: false }, tools: 3 });
		expect(capabilityCountsLine(s)).toBe("3 tools");
	});
	it("renders '<kind>: unknown' for a kind whose fetch errored, never '0 <kind>'", () => {
		const s = summary({
			offered: { tools: true, resources: false, resource_templates: false, prompts: false },
			tools: 3,
			resources: 0,
			unknown: ["resources"],
		});
		const line = capabilityCountsLine(s);
		expect(line).toBe("3 tools · resources: unknown");
		expect(line).not.toContain("0 resources");
	});
	it("singularizes a count of exactly one", () => {
		const s = summary({ offered: { tools: true, resources: false, resource_templates: false, prompts: false }, tools: 1 });
		expect(capabilityCountsLine(s)).toBe("1 tool");
	});
	it("joins every offered kind with the same separator", () => {
		const s = summary({
			offered: { tools: true, resources: true, resource_templates: true, prompts: true },
			tools: 44,
			resources: 3,
			resource_templates: 1,
			prompts: 2,
		});
		expect(capabilityCountsLine(s)).toBe("44 tools · 3 resources · 1 template · 2 prompts");
	});
});

describe("catalogFetchErrorLine", () => {
	it("names the kind a JSON-RPC method maps to", () => {
		expect(catalogFetchErrorLine({ method: "resources/list", error: "deadline exceeded" })).toBe(
			"Could not read resources: deadline exceeded",
		);
	});
	it("falls back to the raw method name for one this build does not recognise", () => {
		expect(catalogFetchErrorLine({ method: "future/list", error: "boom" })).toBe("Could not read future/list: boom");
	});
});

describe("truncationLine", () => {
	it("names the kind and the count actually included", () => {
		expect(truncationLine("tools", 500)).toBe("Showing the first 500 tools. More were left out.");
	});
	it("uses the plural kind label for a singular-sounding kind too", () => {
		expect(truncationLine("resource_templates", 20)).toBe("Showing the first 20 templates. More were left out.");
	});
});

function probe(overrides: Partial<McpProbe> = {}): McpProbe {
	return {
		name: "context7",
		transport: "http",
		state: "ok",
		tool_count: 4,
		tools: ["search_docs"],
		latency_ms: 100,
		protocol_version: "2025-06-18",
		unresolved_refs: [],
		env_from_shell: true,
		error: null,
		checked_at: "2026-09-06T12:00:00Z",
		...overrides,
	};
}

describe("catalogEmptyReason (§6.3 precedence, one case per row)", () => {
	it("row 1: no probe at all", () => {
		expect(catalogEmptyReason(null)).toMatch(/Not checked yet/);
		expect(catalogEmptyReason(undefined)).toMatch(/Not checked yet/);
	});
	it("row 2: unresolved_ref — the check never ran", () => {
		expect(catalogEmptyReason(probe({ state: "unresolved_ref" }))).toBe(
			"The check did not run, so nothing was read.",
		);
	});
	it("row 3: unsupported transport", () => {
		expect(catalogEmptyReason(probe({ state: "unsupported" }))).toBe(
			"Skill Tree cannot read a catalogue over this transport.",
		);
	});
	it("row 4: unreachable / protocol_error / timeout all read the same", () => {
		const line = "The last check did not reach the server, so there is nothing to list.";
		expect(catalogEmptyReason(probe({ state: "unreachable" }))).toBe(line);
		expect(catalogEmptyReason(probe({ state: "protocol_error" }))).toBe(line);
		expect(catalogEmptyReason(probe({ state: "timeout" }))).toBe(line);
	});
	it("row 5: state ok but catalog null/undefined", () => {
		expect(catalogEmptyReason(probe({ state: "ok", catalog: null }))).toBe(
			"This check did not read the server's catalogue.",
		);
		expect(catalogEmptyReason(probe({ state: "ok" }))).toBe("This check did not read the server's catalogue.");
	});
	it("row 6: summary present, but the sheet's own catalog fetch says no_catalog", () => {
		const p = probe({ state: "ok", catalog: summary({ tools: 4, offered: { tools: true, resources: false, resource_templates: false, prompts: false } }) });
		expect(catalogEmptyReason(p, { ok: false, error: "gone", code: "no_catalog" })).toBe(
			"The stored catalogue is gone. Check again to read it.",
		);
	});
	it("row 7: every offered kind empty and no errors", () => {
		const p = probe({
			state: "ok",
			catalog: summary({ offered: { tools: true, resources: true, resource_templates: true, prompts: true } }),
		});
		expect(catalogEmptyReason(p)).toBe("This server answered but offers no tools, resources or prompts.");
	});
	it("row 7 also covers a server that offers nothing at all (-32601 on every kind)", () => {
		const p = probe({ state: "ok", catalog: summary() });
		expect(catalogEmptyReason(p)).toBe("This server answered but offers no tools, resources or prompts.");
	});
	it("row 8: fetch_errors present — falls through to null (render counts + errors normally)", () => {
		const p = probe({
			state: "ok",
			catalog: summary({
				offered: { tools: true, resources: true, resource_templates: false, prompts: true },
				tools: 44,
				prompts: 2,
				unknown: ["resources"],
				errors: 1,
			}),
		});
		expect(catalogEmptyReason(p)).toBeNull();
	});
	it("falls through to null on the ordinary happy path (real counts to show)", () => {
		const p = probe({
			state: "ok",
			catalog: summary({ offered: { tools: true, resources: false, resource_templates: false, prompts: false }, tools: 4 }),
		});
		expect(catalogEmptyReason(p)).toBeNull();
	});
});

// ─── rev 3 §11.4 — title/name pairing ────────────────────────────────────────

describe("titledLabel (rev 3 §11.4)", () => {
	it("shows only the name when no title was declared", () => {
		expect(titledLabel("get_page", null)).toEqual({ primary: "get_page", secondary: null });
		expect(titledLabel("get_page", undefined)).toEqual({ primary: "get_page", secondary: null });
	});
	it("shows only the name when the title matches it exactly", () => {
		expect(titledLabel("get_page", "get_page")).toEqual({ primary: "get_page", secondary: null });
	});
	it("shows title as primary and name as secondary when they differ", () => {
		expect(titledLabel("get_page", "Get Page")).toEqual({ primary: "Get Page", secondary: "get_page" });
	});
});

// ─── rev 3 §11.6 — annotation chips ───────────────────────────────────────────

function annotations(overrides: Partial<McpToolAnnotations> = {}): McpToolAnnotations {
	return { read_only: null, destructive: null, idempotent: null, open_world: null, ...overrides };
}

describe("annotationChips (rev 3 §11.6)", () => {
	it("renders nothing for absent annotations", () => {
		expect(annotationChips(null)).toEqual([]);
		expect(annotationChips(undefined)).toEqual([]);
	});
	it("renders nothing when every hint is null", () => {
		expect(annotationChips(annotations())).toEqual([]);
	});
	it("renders one chip for a single declared hint, the rest null", () => {
		expect(annotationChips(annotations({ read_only: true }))).toEqual([{ key: "read_only", label: "read-only" }]);
	});
	it("renders a declared false as its negative wording, not silence", () => {
		expect(annotationChips(annotations({ destructive: false }))).toEqual([
			{ key: "destructive", label: "not destructive" },
		]);
	});
	it("renders every declared hint together", () => {
		const chips = annotationChips({ read_only: true, destructive: true, idempotent: null, open_world: false });
		expect(chips).toEqual([
			{ key: "read_only", label: "read-only" },
			{ key: "destructive", label: "destructive" },
			{ key: "open_world", label: "closed-world" },
		]);
	});
	it("carries the untrusted-hint title text every chip shows", () => {
		expect(ANNOTATION_HINT_TITLE).toMatch(/does not verify/);
	});
});
