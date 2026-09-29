import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import {
	findRefs,
	slashRefContextAt,
	SLASH_REF_LEAD_CLASS,
	SLASH_REF_NAME_SRC,
	SLASH_REF_TAIL_SRC,
	SLASH_REF_SRC,
	type SkillRefRenderOptions,
} from "@/lib/skillRefs";
import {
	rankSkillCompletions,
	skillRefCompletionSource,
	SUBSTRING_MIN_QUERY,
	MAX_COMPLETION_OPTIONS,
} from "@/components/skillRefs/refCompletion";

// ─── T-1: recomposition identity ──────────────────────────────────────────────
// SLASH_REF_SRC must stay byte-identical to the literal it used to be, so the
// Python twin (skill_refs.py) can never drift out from under this split.
describe("SLASH_REF_SRC recomposition (T-1)", () => {
	it("is byte-identical to the pinned literal", () => {
		const pinned =
			"(^|[^A-Za-z0-9_/.~(])/([a-z0-9][a-z0-9-]*)" +
			"(?![A-Za-z0-9_-])(?!/)(?!\\.[A-Za-z0-9_])";
		expect(SLASH_REF_SRC).toBe(pinned);
	});

	it("recomposes from the three named parts", () => {
		expect(SLASH_REF_SRC).toBe(
			`(^|${SLASH_REF_LEAD_CLASS})/(${SLASH_REF_NAME_SRC})` + SLASH_REF_TAIL_SRC,
		);
	});
});

// ─── Marked-string helper: `|` marks the caret position ──────────────────────
function caret(marked: string): { text: string; pos: number } {
	const pos = marked.indexOf("|");
	if (pos === -1) throw new Error(`no "|" caret marker in: ${marked}`);
	return { text: marked.slice(0, pos) + marked.slice(pos + 1), pos };
}

// ─── T-2: open grammar — the §Trigger grammar matrix ──────────────────────────
describe("slashRefContextAt — open grammar (T-2)", () => {
	it("opens at line start", () => {
		const { text, pos } = caret("/cod|");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 0, to: 4, query: "cod" });
	});

	it("opens after a space", () => {
		const { text, pos } = caret("see /cod|");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 4, to: 8, query: "cod" });
	});

	it("opens after a list-item marker", () => {
		const { text, pos } = caret("- /cod|");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 2, to: 6, query: "cod" });
	});

	it("opens inside a fenced code block", () => {
		const { text, pos } = caret("```\n/cod|\n```");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 4, to: 8, query: "cod" });
	});

	it("opens inside an inline backtick span", () => {
		// The backtick is not in SLASH_REF_LEAD_CLASS's excluded set, so it is a
		// valid lead character — the overlay opens, and (per plans/2.md) always
		// inserts the slash form, never guessing at a closing backtick.
		const { text, pos } = caret("`/cod|`");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 1, to: 5, query: "cod" });
	});

	it("a bare `/` reports an empty query (policy of not opening lives elsewhere)", () => {
		const { text, pos } = caret("/|");
		expect(slashRefContextAt(text, pos)).toEqual({ from: 0, to: 1, query: "" });
	});

	const noOpenCases: Array<[string, string]> = [
		["preceded by a path segment", "references/cod|"],
		["preceded by ./", "./cod|"],
		["preceded by ../", "../cod|"],
		["preceded by ~/", "~/cod|"],
		["preceded by (", "[x](/cod|"],
		["a second path segment", "a/b/cod|"],
		["preceded by a letter, not a boundary", "and/or|"],
		["an uppercase name start", "/Cod|"],
	];
	it.each(noOpenCases)("does not open: %s (%s)", (_label, marked) => {
		const { text, pos } = caret(marked);
		expect(slashRefContextAt(text, pos)).toBeNull();
	});

	it("does not open when the next character is a slash (T3)", () => {
		const { text, pos } = caret("/cod|/");
		expect(slashRefContextAt(text, pos)).toBeNull();
	});

	it("does not open when the name runs into a file extension (T3)", () => {
		const { text, pos } = caret("/cod|.md");
		expect(slashRefContextAt(text, pos)).toBeNull();
	});

	it("end-of-line/end-of-doc satisfies every trailing guard", () => {
		const { text, pos } = caret("/cod|");
		expect(slashRefContextAt(text, pos)).not.toBeNull();
	});

	it("never opens inside frontmatter, even when it looks like a reference", () => {
		const { text, pos } = caret(
			"---\ndescription: see /code-review|\n---\n\nBody text.\n",
		);
		expect(slashRefContextAt(text, pos)).toBeNull();
	});
});

// ─── T-3: agreement with findRefs ─────────────────────────────────────────────
// For every "opens" case, completing the typed query into a registered name
// makes findRefs report a hit at exactly `from`. For every "does not open"
// case, it reports none. This is what makes a silent non-reference
// structurally impossible.
describe("slashRefContextAt agrees with findRefs (T-3)", () => {
	const NAMES = ["code-review"];

	function completeAndCheck(marked: string): { hits: number; atFrom: boolean } {
		const { text, pos } = caret(marked);
		const ctx = slashRefContextAt(text, pos);
		if (!ctx) return { hits: -1, atFrom: false };
		const completed = text.slice(0, ctx.to) + "e-review" + text.slice(ctx.to);
		const hits = findRefs(completed, NAMES);
		return { hits: hits.length, atFrom: hits.length > 0 && hits[0].offset === ctx.from };
	}

	it("opens agree: completing the query resolves a hit at `from`", () => {
		for (const marked of ["/cod|", "see /cod|", "- /cod|", "```\n/cod|\n```"]) {
			const { text, pos } = caret(marked);
			const ctx = slashRefContextAt(text, pos);
			expect(ctx, marked).not.toBeNull();
			const completed = text.slice(0, ctx!.to) + "e-review" + text.slice(ctx!.to);
			const hits = findRefs(completed, NAMES);
			expect(hits.length, marked).toBe(1);
			expect(hits[0].offset, marked).toBe(ctx!.from);
			expect(hits[0].name, marked).toBe("code-review");
		}
	});

	it("non-opens agree: completing the query resolves no hit", () => {
		for (const marked of [
			"references/cod|",
			"./cod|",
			"../cod|",
			"~/cod|",
			"[x](/cod|",
			"a/b/cod|",
			"and/or|",
			"/Cod|",
		]) {
			const { text, pos } = caret(marked);
			// Complete at the raw caret position (slashRefContextAt already says
			// "no"), so simulate "the rest of the name was typed anyway" at pos.
			const completed = text.slice(0, pos) + "e-review" + text.slice(pos);
			const hits = findRefs(completed, NAMES);
			expect(hits.length, marked).toBe(0);
			expect(completeAndCheck(marked).hits, marked).toBe(-1);
		}
	});
});

// ─── T-4: ranking + the tier gate ─────────────────────────────────────────────
describe("rankSkillCompletions — tier order, tie-break, cap (T-4a)", () => {
	const describe4a = (name: string): string | undefined =>
		({
			reviewer: "Reviews code changes on every pull request.",
		})[name];

	it("orders prefix > name-substring > description-substring, name-ascending within a tier", () => {
		const candidates = [
			"zeta-code",
			"code-beta",
			"alpha-code-tool",
			"code-alpha",
			"reviewer",
		];
		expect(rankSkillCompletions("code", candidates, describe4a)).toEqual([
			"code-alpha",
			"code-beta",
			"alpha-code-tool",
			"zeta-code",
			"reviewer",
		]);
	});

	it("caps at `limit` (default MAX_COMPLETION_OPTIONS = 8)", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => `code-${String.fromCharCode(97 + i)}`);
		const ranked = rankSkillCompletions("code", candidates, () => undefined);
		expect(ranked).toHaveLength(MAX_COMPLETION_OPTIONS);
		expect(ranked).toEqual(candidates.slice(0, MAX_COMPLETION_OPTIONS));
	});

	it("respects an explicit limit", () => {
		const candidates = ["code-a", "code-b", "code-c"];
		expect(rankSkillCompletions("code", candidates, () => undefined, 2)).toEqual([
			"code-a",
			"code-b",
		]);
	});

	it("T6 raw signal: a fully-typed query ranks itself first", () => {
		expect(rankSkillCompletions("code-review", ["code-review"], () => undefined)[0]).toBe(
			"code-review",
		);
	});
});

describe("skillRefCompletionSource — self/ignore exclusion and T6 (T-4a)", () => {
	function opts(partial: Partial<SkillRefRenderOptions>): SkillRefRenderOptions {
		return {
			names: ["code-review", "code-search"],
			describe: () => undefined,
			onOpen: () => {},
			...partial,
		};
	}

	function run(text: string, pos: number, o: SkillRefRenderOptions): CompletionResult | null {
		const state = EditorState.create({ doc: text });
		const context = new CompletionContext(state, pos, false);
		const result = skillRefCompletionSource(o)(context);
		if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
			throw new Error("expected a synchronous completion result");
		}
		return result as CompletionResult | null;
	}

	it("excludes `self`", () => {
		const { text, pos } = caret("/cod|");
		const result = run(text, pos, opts({ self: "code-review" }));
		expect(result?.options.map((o) => o.label)).toEqual(["code-search"]);
	});

	it("excludes every `refs_ignore` name", () => {
		const { text, pos } = caret("/cod|");
		const result = run(text, pos, opts({ ignore: ["code-search"] }));
		expect(result?.options.map((o) => o.label)).toEqual(["code-review"]);
	});

	it("T6: returns null once the top match is already fully typed", () => {
		const { text, pos } = caret("/code-review|");
		const result = run(text, pos, opts({ names: ["code-review"] }));
		expect(result).toBeNull();
	});

	it("re-opens on one more character after T6 closed it", () => {
		const { text, pos } = caret("/code-review-|");
		const result = run(text, pos, opts({ names: ["code-review", "code-review-two"] }));
		expect(result?.options.map((o) => o.label)).toEqual(["code-review-two"]);
	});

	it("each option carries the slash-form `apply` and the bare name as `label`", () => {
		const { text, pos } = caret("/cod|");
		const result = run(text, pos, opts({ names: ["code-review"] }));
		expect(result?.options).toEqual([
			{ label: "code-review", detail: undefined, type: "keyword", apply: "/code-review" },
		]);
		expect(result?.filter).toBe(false);
	});
});

describe("rankSkillCompletions — the tier gate (T-4b)", () => {
	// A candidate whose NAME contains "dev" but does not START with it (tier 1),
	// and a candidate whose DESCRIPTION contains "dev" while its own name does
	// not (tier 2). Demonstrates the gate opening exactly at SUBSTRING_MIN_QUERY
	// characters — disjoint from the T-4c "never open" fixture below, which is
	// deliberately built to contain none of the ten path words anywhere.
	const gateCandidates = ["ops-devtools", "helper-x", "readme-gen"];
	const gateDescribe = (name: string): string | undefined =>
		name === "helper-x" ? "Sets up a dev container quickly." : undefined;

	it("at 1-2 characters, only prefix matches show", () => {
		expect(rankSkillCompletions("d", gateCandidates, gateDescribe)).toEqual([]);
		expect(rankSkillCompletions("de", gateCandidates, gateDescribe)).toEqual([]);
	});

	it("at SUBSTRING_MIN_QUERY (3) characters, name-substring and description-substring both appear", () => {
		expect(SUBSTRING_MIN_QUERY).toBe(3);
		expect(rankSkillCompletions("dev", gateCandidates, gateDescribe)).toEqual([
			"ops-devtools", // tier 1: name substring
			"helper-x", // tier 2: description substring
		]);
	});
});

describe("rankSkillCompletions — path words never open (T-4c)", () => {
	// A ≥100-name fixture built entirely in-test — never the real
	// ~/.skill-hub/registry.yaml, which is machine-specific and would make the
	// suite non-hermetic. A handful of realistic names plus 90 generated
	// "fixture-skill-NNN" slugs, none of which prefix-match, substring-match,
	// or description-match any of the ten path words below.
	const realNames = [
		"code-review",
		"code-search",
		"brainstorm",
		"deliver-it",
		"openspec-apply",
		"openspec-code",
		"grill-it",
		"simplify",
		"proof-it",
		"unslop",
	];
	const generatedNames = Array.from(
		{ length: 90 },
		(_, i) => `fixture-skill-${String(i + 1).padStart(3, "0")}`,
	);
	const fixtureNames = [...realNames, ...generatedNames];
	const fixtureDescribe = (name: string): string | undefined =>
		realNames.includes(name)
			? `A fixture description for ${name}, unrelated to any path segment.`
			: `Generated fixture skill entry ${name}.`;

	const pathWords = ["etc", "dev", "bin", "opt", "var", "usr", "tmp", "home", "srv", "lib"];

	it("the fixture has at least 100 candidate names", () => {
		expect(fixtureNames.length).toBeGreaterThanOrEqual(100);
	});

	it.each(pathWords)("%s never opens", (word) => {
		expect(rankSkillCompletions(word, fixtureNames, fixtureDescribe)).toEqual([]);
	});
});
