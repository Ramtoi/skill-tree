import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	findRefs,
	countRefs,
	previewHits,
	incomingRefs,
	splitFrontmatter,
	type SkillRefHit,
} from "@/lib/skillRefs";
import { skillBackTarget } from "@/lib/backTarget";

// ─── Cross-language parity ────────────────────────────────────────────────────
// skillRefs.ts is a hand-ported TypeScript twin of skill_refs.py. Both sides
// are asserted against ONE shared golden corpus, the same pattern as
// tests/fixtures/hook_catalog_corpus.json / agent_docs_corpus.json.
interface SkillRefCorpusCase {
	name: string;
	text: string;
	names: string[];
	self: string | null;
	ignore: string[];
	expect: SkillRefHit[];
	counts: Record<string, number>;
	preview_hits: number;
}

const CORPUS = JSON.parse(
	readFileSync(
		resolve(process.cwd(), "../tests/fixtures/skill_refs_corpus.json"),
		"utf-8",
	),
) as {
	schema_version: number;
	cases: SkillRefCorpusCase[];
};

describe("skillRefs ↔ skill_refs.py parity (shared corpus)", () => {
	it.each(CORPUS.cases)("%s", (c) => {
		expect(findRefs(c.text, c.names, c.self, c.ignore)).toEqual(c.expect);
		expect(countRefs(c.text, c.names, c.self, c.ignore)).toEqual(c.counts);
	});
});

it("the corpus is BMP-only so offsets agree across languages", () => {
	for (const c of CORPUS.cases) {
		expect(c.text.length).toBe([...c.text].length);
	}
});

it("previewHits drops every hit inside an inline code span", () => {
	const fencedFree = CORPUS.cases.filter((c) => !c.text.includes("```"));
	for (const c of fencedFree) {
		expect(previewHits(c.text, c.names, c.self, c.ignore).length).toBe(
			c.preview_hits,
		);
	}

	const findByName = (name: string): SkillRefCorpusCase => {
		const found = CORPUS.cases.find((c) => c.name === name);
		if (!found) throw new Error(`missing corpus case ${name}`);
		return found;
	};

	for (const name of ["inline-code-command-span", "backtick-with-leading-slash"]) {
		const c = findByName(name);
		const preview = previewHits(c.text, c.names, c.self, c.ignore);
		const all = findRefs(c.text, c.names, c.self, c.ignore);
		expect(preview.length).toBeLessThan(all.length);
	}
});

it("splits frontmatter like the Rust splitter", () => {
	// Well-formed fence: the closer's opening eol is not part of the
	// frontmatter slice.
	expect(splitFrontmatter("---\nname: x\n---\nbody\n")).toEqual([
		"name: x",
		"body\n",
	]);
	// Two leading BOMs, CRLF throughout.
	expect(
		splitFrontmatter("﻿﻿---\r\nname: x\r\n---\r\nbody\r\n"),
	).toEqual(["name: x", "body\r\n"]);
	// Unterminated fence: no closer at all -> whole text is body.
	expect(splitFrontmatter("---\nname: x\n")).toEqual([
		null,
		"---\nname: x\n",
	]);
	// Every leading repetition of the eol is stripped from the body, not
	// just one.
	expect(splitFrontmatter("---\nx\n---\n\n\nbody")).toEqual(["x", "body"]);
	// Empty frontmatter: no closer found inside `after_open` either, so the
	// whole file is body (both ports agree).
	expect(splitFrontmatter("---\n---\nbody")).toEqual([
		null,
		"---\n---\nbody",
	]);
});

it("counts incoming references per referrer", () => {
	const corpus = { a: "see `t`", b: "see /t and `t`", t: "self" };
	const names = ["t"];
	expect(incomingRefs(corpus, "t", names)).toEqual([
		{ name: "a", count: 1 },
		{ name: "b", count: 2 },
	]);
});

it("honours the referrer's own ignore list for incoming edges", () => {
	const corpus = { a: "see `t`", b: "see /t and `t`", t: "self" };
	const names = ["t"];
	const ignoreOf = (referrer: string) => (referrer === "b" ? ["t"] : []);
	expect(incomingRefs(corpus, "t", names, ignoreOf)).toEqual([
		{ name: "a", count: 1 },
	]);
});

describe("skillBackTarget", () => {
	it("returns the skill route with a skill crumb", () => {
		expect(skillBackTarget("rt-android-expert")).toEqual({
			label: "rt-android-expert",
			path: "/skill/rt-android-expert",
			crumbs: ["skill", "rt-android-expert"],
		});

		const escaped = skillBackTarget("foo bar/baz");
		expect(escaped.path).toBe(
			`/skill/${encodeURIComponent("foo bar/baz")}`,
		);
	});
});
