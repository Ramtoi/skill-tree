import { describe, it, expect } from "vitest";
import {
	SKILL_SLUG_RE,
	invalidPreview,
	normalizePreview,
	parseCliJson,
} from "@/lib/skillPack";

describe("parseCliJson", () => {
	it("parses a clean payload", () => {
		expect(parseCliJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	// hub.py may print deprecation warnings / sync chatter before the payload.
	it("skips leading non-JSON noise", () => {
		const out =
			"warning: SKILL_HUB_DIR is deprecated\nsyncing…\n" +
			'{"imported":"widget","files":3}';
		expect(parseCliJson<{ imported: string }>(out).imported).toBe("widget");
	});

	it("recovers when noise TRAILS the payload", () => {
		expect(
			parseCliJson<{ ok: boolean }>('{"ok":true}\nDone in 0.4s\n'),
		).toEqual({ ok: true });
	});

	it("throws with the raw text when nothing parses", () => {
		expect(() => parseCliJson("not json at all")).toThrow(/not json at all/);
		expect(() => parseCliJson("")).toThrow(/empty response/);
	});
});

describe("normalizePreview", () => {
	it("passes a well-formed preview through", () => {
		const p = normalizePreview({
			valid: true,
			errors: [],
			name: "widget",
			version: "1.0.0",
			description: "d",
			type: "claude-skill",
			scope: "portable",
			files: [{ path: "SKILL.md", bytes: 10 }],
			collision: true,
			existing: { version: "0.9.0" },
		});
		expect(p.valid).toBe(true);
		expect(p.collision).toBe(true);
		expect(p.files).toHaveLength(1);
		expect(p.existing?.version).toBe("0.9.0");
	});

	// The CLI's OTHER shape: a hard refusal is `{"error": "..."}` with no
	// `valid`/`errors`/`files`. Rendering that raw would crash on errors.length.
	it("collapses the CLI's bare {error} shape into an invalid preview", () => {
		const p = normalizePreview({ error: "bogus.skillpack is not valid JSON" });
		expect(p.valid).toBe(false);
		expect(p.errors).toEqual(["bogus.skillpack is not valid JSON"]);
		expect(p.files).toEqual([]);
		expect(p.collision).toBe(false);
	});

	it("guarantees arrays even when the payload omits them", () => {
		const p = normalizePreview({ valid: true, name: "widget" });
		expect(p.errors).toEqual([]);
		expect(p.files).toEqual([]);
		expect(p.existing).toBeNull();
	});

	it("handles junk input without throwing", () => {
		for (const junk of [null, undefined, 42, "nope", []]) {
			const p = normalizePreview(junk);
			expect(p.valid).toBe(false);
			expect(p.errors.length).toBeGreaterThan(0);
		}
	});

	it("invalidPreview drops empty messages", () => {
		expect(invalidPreview(["boom", ""]).errors).toEqual(["boom"]);
	});
});

describe("SKILL_SLUG_RE", () => {
	it("matches the CLI's slug rule", () => {
		for (const ok of ["widget", "shared-widget-2", "a1"]) {
			expect(SKILL_SLUG_RE.test(ok)).toBe(true);
		}
		for (const bad of ["Widget", "with space", "under_score", "", "dot.name"]) {
			expect(SKILL_SLUG_RE.test(bad)).toBe(false);
		}
	});
});
