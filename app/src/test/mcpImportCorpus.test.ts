import { describe, it, expect } from "vitest";
import { resolveAddExistingName, tryParseJsonObject, wrapperKeys } from "@/components/NewSkillSheet";
import { slugifyServerName } from "@/lib/mcpContract";
import corpus from "../../../tests/fixtures/mcp_import_corpus.json";

// ─── E3 rev 2 §5 cases 16/17 — the TS half of the shared 65-id import corpus ─
//
// `tests/test_mcp_import_corpus.py` drives every case through the REAL
// Python readers (`mcp_reconcile.classify` / `hub_cli.mcp._parse_add_stdin`).
// This file drives the ONE thing the frontend can see for itself without a
// Python process: name resolution. For `paste`/`paste_wrapper` cases that is
// the sheet's own parse pipeline (`tryParseJsonObject` → `wrapperKeys` →
// `resolveAddExistingName` → `slugifyServerName`) all the way to
// `import_name`, or the parse-level refusal it can detect on its own
// (`empty_wrapper`/`nested_wrapper`/invalid JSON — never the deep
// `normalize_native` reasons like `malformed_field:timeout`, which only the
// Python side computes). For every OTHER (discovery-sourced) case, the
// completeness sweep below asserts at least the slug: `slugifyServerName`
// applied to the case's own `name` must equal Python's `import_name`.
//
// Every one of the 65 ids is iterated here — a case this suite cannot fully
// verify still gets its slug pinned, so nothing is silently skipped.

interface CorpusCase {
	id: string;
	note: string;
	source: string;
	name: string | null;
	native: Record<string, unknown> | null;
	raw_stdin?: string | null;
	bom?: boolean;
	expect: {
		status: string;
		import_name: string | null;
		reason: string | null;
		warnings: string[];
		spec: Record<string, unknown> | null;
	};
}

interface CorpusFile {
	schema_version: number;
	cases: CorpusCase[];
}

const CASES = (corpus as CorpusFile).cases;
const PASTE_SOURCES = new Set(["paste", "paste_wrapper"]);

function stdinTextFor(c: CorpusCase): string {
	const text = c.raw_stdin ?? JSON.stringify(c.native);
	return c.bom ? `\uFEFF${text}` : text;
}

/** The parse-level refusal words the sheet's OWN pipeline can distinguish —
 *  a `reason: null` covers BOTH "no reason at all" (a plain `ok` row) and
 *  Python's own "invalid JSON" refusal, which `_die` calls with no `reason`
 *  kwarg (S07 pins `reason: null`, not `"invalid_json"`). */
const PARSE_LEVEL_REASONS = new Set(["empty_wrapper", "nested_wrapper"]);

describe("mcpImportCorpus — TS half (E3 rev 2 §5 case 16)", () => {
	it("the fixture still holds all 67 ids (drift guard, mirrors the Python side)", () => {
		// 67 = the catalogue's 65 ids, with N12 split into N12 (the real NUL
		// byte) and N12b (an ordinary space), plus F5W (a non-catalogue
		// vocabulary-completeness case for `unclaimed_native_entry`) — see
		// `tests/test_mcp_import_corpus.py::test_corpus_has_all_expected_ids`.
		expect(CASES.length).toBe(67);
		expect(new Set(CASES.map((c) => c.id)).size).toBe(67);
	});

	const pasteCases = CASES.filter((c) => PASTE_SOURCES.has(c.source));

	for (const c of pasteCases) {
		it(`${c.id}: ${c.note}`, () => {
			const text = stdinTextFor(c);
			// Sanity: `tryParseJsonObject`/`wrapperKeys` are the exact
			// primitives the sheet's own prefill effect uses.
			const parsed = tryParseJsonObject(text.startsWith("\uFEFF") ? text.slice(1) : text);
			void wrapperKeys(parsed); // exercised, not separately asserted — resolveAddExistingName is the pipeline under test.

			const resolved = resolveAddExistingName(text, c.name);
			if (!resolved.ok) {
				if (PARSE_LEVEL_REASONS.has(c.expect.reason ?? "") || (c.expect.reason === null && c.expect.import_name === null)) {
					// A refusal both sides can see — assert the word too when
					// the Python side names one this layer produces.
					if (PARSE_LEVEL_REASONS.has(c.expect.reason ?? "")) {
						expect(resolved.reason).toBe(c.expect.reason);
					}
					expect(c.expect.import_name).toBeNull();
				} else {
					throw new Error(
						`${c.id}: the sheet's parse pipeline refused (${resolved.reason}) but the corpus expects import_name=${c.expect.import_name} — a case this suite should have been able to name`,
					);
				}
				return;
			}
			const slug = slugifyServerName(resolved.rawName);
			expect(slug).toBe(c.expect.import_name);
		});
	}

	// ─── C1 — resolveAddExistingName is exactly as strict as
	// `hub_cli.mcp._parse_add_stdin`: a `nameArg` that is not a key in the
	// wrapper refuses, even when the wrapper holds exactly one (different)
	// key — the corpus's own 67 ids never exercise a paste whose `name`
	// diverges from its wrapper key, so this is asserted directly. ─────────

	it("C1: a nameArg absent from a SINGLE-key wrapper refuses (unknown_candidate), never falls back to keys[0]", () => {
		const text = JSON.stringify({ mcpServers: { Sanity: { command: "npx" } } });
		const resolved = resolveAddExistingName(text, "sanity");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.reason).toBe("unknown_candidate");
	});

	it("C1: a nameArg that IS the wrapper's own (non-slug) key resolves to that raw key", () => {
		const text = JSON.stringify({ mcpServers: { Sanity: { command: "npx" } } });
		const resolved = resolveAddExistingName(text, "Sanity");
		expect(resolved).toEqual({ ok: true, rawName: "Sanity" });
	});

	it("C1: a nameArg naming ONE key of a multi-key wrapper resolves to that raw key, never the other", () => {
		const text = JSON.stringify({
			mcpServers: { "a-srv": { command: "npx" }, Sanity: { command: "npx" } },
		});
		const resolved = resolveAddExistingName(text, "Sanity");
		expect(resolved).toEqual({ ok: true, rawName: "Sanity" });
	});

	// ─── N6-new — a PRESENT `mcpServers` key whose value is not an object
	// (a list, a string, …) is its OWN refusal in Python
	// (`elif "mcpServers" in obj: _die(...)`, `hub_cli/mcp.py:521-523`) —
	// never a silent fall-through to registering the WHOLE pasted object
	// (including the malformed `mcpServers` key) as one bare server. The
	// 67-id shared corpus has no such case (only S03 empty / S04 nested), so
	// this is asserted directly, same as the C1 cases above it.

	it("N6-new: a top-level array mcpServers value refuses, never falls through to the bare-object branch", () => {
		const text = JSON.stringify({ mcpServers: [] });
		const resolved = resolveAddExistingName(text, "sanity");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.reason).toBe("invalid_json");
	});

	it("N6-new: a string mcpServers value also refuses, even with a nameArg present", () => {
		const text = JSON.stringify({ mcpServers: "not-an-object" });
		const resolved = resolveAddExistingName(text, "sanity");
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.reason).toBe("invalid_json");
	});

	// ─── case 17 — slugifyServerName matches Python on EVERY corpus name ─────
	const named = CASES.filter((c) => c.name !== null);
	for (const c of named) {
		it(`${c.id}: slugifyServerName(${JSON.stringify(c.name)}) matches the corpus`, () => {
			const slug = slugifyServerName(c.name);
			if (c.expect.reason === "invalid_name" || (c.expect.import_name === null && c.expect.reason?.startsWith("invalid_name"))) {
				expect(slug).toBeNull();
			} else if (c.expect.import_name !== null) {
				expect(slug).toBe(c.expect.import_name);
			}
			// Cases where import_name is null for a non-naming reason (the
			// wrapper-structural paste refusals) carry no `name` at all —
			// excluded by the `c.name !== null` filter above.
		});
	}

	// ─── completeness — every one of the 65 ids appears in THIS suite ───────
	it("every corpus id is covered by a case above (paste pipeline or slug pin)", () => {
		const coveredByPaste = new Set(pasteCases.map((c) => c.id));
		const coveredBySlug = new Set(named.map((c) => c.id));
		for (const c of CASES) {
			const covered = coveredByPaste.has(c.id) || coveredBySlug.has(c.id);
			expect(covered, `${c.id} (source=${c.source}, name=${c.name}) is not exercised by this suite`).toBe(true);
		}
	});
});
