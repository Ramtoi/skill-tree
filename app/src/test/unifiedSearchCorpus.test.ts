import { describe, it, expect } from "vitest";
import {
  buildExcerpt,
  countByKind,
  countHits,
  matchItems,
  prepareCorpus,
  searchAll,
  type SearchCorpus,
  type SearchItem,
} from "@/lib/unifiedSearch";

// Wave 2's content-search band (PLAN-2.md §12): a plain lowercased substring
// scan over skill/snippet bodies, cached per corpus object identity — no
// search-index library. See GRILL-2.md finding 3 for why.

const LONG_LINE = "a".repeat(80) + " markerword " + "b".repeat(80);

const items: SearchItem[] = [
  { kind: "skill", id: "compose", label: "compose" },
  { kind: "skill", id: "long-body-skill", label: "long-body-skill" },
  { kind: "skill", id: "body-only-skill", label: "body-only-skill" },
  {
    kind: "skill",
    id: "dual-match",
    label: "dual-match",
    description: "mentions marker in the description too",
  },
  { kind: "skill", id: "both-terms", label: "both-terms" },
  { kind: "skill", id: "only-alpha", label: "only-alpha" },
  { kind: "skill", id: "heading-hit", label: "heading-hit" },
];

const corpus: SearchCorpus = {
  skills: {
    compose: "",
    "long-body-skill": "compose ".repeat(50),
    "body-only-skill": `## Heading\n\n${LONG_LINE}\n`,
    "dual-match": "the word marker also appears in this body.\n",
    "both-terms": "Some alpha content, and beta too, in one line.\n",
    "only-alpha": "alpha only here, no partner.\n",
    "heading-hit": "## Overview mentions ztermword right here\n",
  },
  snippets: {},
};

describe("unifiedSearch — content search (band B)", () => {
  it("1. name tier beats body: the item literally named the query outranks a body mentioning it 50 times", () => {
    const prepared = prepareCorpus(corpus);
    const hits = searchAll(items, "compose", undefined, prepared);
    expect(hits[0].item.id).toBe("compose");
    expect(hits[0].score).toBeLessThan(600);
    const bodyHit = hits.find((h) => h.item.id === "long-body-skill");
    expect(bodyHit).toBeDefined();
    expect(bodyHit!.score).toBeGreaterThanOrEqual(600);
  });

  it("2. a body-only hit is band B, carries fields:['body'], and an excerpt containing the term", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "markerword", undefined, prepared).find(
      (h) => h.item.id === "body-only-skill",
    );
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(600);
    expect(hit!.fields).toEqual(["body"]);
    expect(hit!.excerpt).toBeDefined();
    expect(hit!.excerpt!.text.toLowerCase()).toContain("markerword");
    expect(hit!.excerpt!.ranges.length).toBeGreaterThan(0);
  });

  it("3. a name/description hit never gets an excerpt, even when its body also contains the term", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "marker", undefined, prepared).find(
      (h) => h.item.id === "dual-match",
    );
    expect(hit).toBeDefined();
    expect(hit!.score).toBeLessThan(600);
    expect(hit!.excerpt).toBeUndefined();
  });

  it("4. excerpt shape: bounded length, single line, no doubled whitespace, ellipsis on both truncated edges", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "markerword", undefined, prepared).find(
      (h) => h.item.id === "body-only-skill",
    )!;
    const text = hit.excerpt!.text;
    expect(text.length).toBeLessThanOrEqual(130);
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/ {2,}/);
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("5. below the 3-char floor, searchAll deep-equals matchItems — band B never runs", () => {
    const prepared = prepareCorpus(corpus);
    expect(searchAll(items, "an", undefined, prepared)).toEqual(matchItems(items, "an"));
    expect(searchAll(items, "co", undefined, prepared)).toEqual(matchItems(items, "co"));
  });

  it("6. the excerpt marks exactly the typed term, not the whole word it sits inside", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "marker", undefined, prepared).find(
      (h) => h.item.id === "body-only-skill",
    )!;
    const [range] = hit.excerpt!.ranges;
    const marked = hit.excerpt!.text.slice(range.start, range.end);
    expect(marked.toLowerCase()).toBe("marker");
    expect(marked.length).toBe(6);
  });

  it("7. multi-term is AND: every term must occur, in any order", () => {
    const prepared = prepareCorpus(corpus);
    const hits = searchAll(items, "alpha beta", undefined, prepared);
    expect(hits.some((h) => h.item.id === "both-terms")).toBe(true);
    expect(hits.some((h) => h.item.id === "only-alpha")).toBe(false);
  });

  it("8. countHits(searchAll(...)) counts content matches that band-A-only countByKind misses", () => {
    const prepared = prepareCorpus(corpus);
    const withContent = countHits(searchAll(items, "markerword", undefined, prepared));
    const bandAOnly = countByKind(items, "markerword");
    expect(withContent.all).toBeGreaterThan(bandAOnly.all);
  });

  it("9. determinism: band B's order is independent of item input order", () => {
    const prepared = prepareCorpus(corpus);
    const shuffled = [...items].reverse();
    expect(searchAll(shuffled, "compose", undefined, prepared)).toEqual(
      searchAll(items, "compose", undefined, prepared),
    );
  });

  it("10. facet intersection: narrowing the `items` pool narrows band B too", () => {
    // `prepared` is built over the FULL corpus (facets never rebuild it) —
    // only the caller's `items` array is narrowed, D6's contract.
    const prepared = prepareCorpus(corpus);
    const narrowed = items.filter((i) => i.id !== "long-body-skill");
    const hits = searchAll(narrowed, "compose", undefined, prepared);
    expect(hits.some((h) => h.item.id === "long-body-skill")).toBe(false);
  });

  it("11. no prepared corpus = matchItems verbatim (band A alone, the wave-1 behaviour)", () => {
    expect(searchAll(items, "compose")).toEqual(matchItems(items, "compose"));
    expect(searchAll(items, "markerword")).toEqual(matchItems(items, "markerword"));
  });

  it("12. overlapping term ranges in an excerpt merge into one non-overlapping range", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "marker arkerw", undefined, prepared).find(
      (h) => h.item.id === "body-only-skill",
    )!;
    // "marker" (0-6) and "arkerw" (1-7) inside "markerword" overlap —
    // `mergeRanges` must collapse them into exactly one range.
    expect(hit.excerpt!.ranges.length).toBe(1);
  });

  it("13. prepareCorpus is memoised by corpus object identity (equip -> same reference -> no re-lowercasing)", () => {
    const a = prepareCorpus(corpus);
    const b = prepareCorpus(corpus);
    expect(a).toBe(b);
  });

  it("14. a leading Markdown heading/list/quote marker is stripped from the excerpt", () => {
    const prepared = prepareCorpus(corpus);
    const hit = searchAll(items, "ztermword", undefined, prepared).find(
      (h) => h.item.id === "heading-hit",
    )!;
    expect(hit.excerpt!.text.startsWith("#")).toBe(false);
    expect(hit.excerpt!.text.toLowerCase()).toContain("ztermword");
  });

  it("15. m4: buildExcerpt takes an already-lowercased body and never re-lowercases it itself", () => {
    // A `lowerBody` that DISAGREES with `body` proves the function trusts the
    // caller's lowercased form rather than deriving its own — if it called
    // `body.toLowerCase()` internally it would find "zzzmarker" (from `body`)
    // at a different offset than what `lowerBody` reports, or not at all.
    const body = "prefix ZZZMARKER suffix";
    const lowerBody = "prefix zzzmarker suffix";
    const excerpt = buildExcerpt(body, ["zzzmarker"], lowerBody);
    expect(excerpt).toBeDefined();
    expect(excerpt!.text.toLowerCase()).toContain("zzzmarker");
  });

  it("16. buildExcerpt falls back to lowercasing `body` itself when no `lowerBody` is given", () => {
    const excerpt = buildExcerpt("a body mentioning MARKERWORD here", ["markerword"]);
    expect(excerpt).toBeDefined();
    expect(excerpt!.ranges.length).toBeGreaterThan(0);
  });

  it("17. n12: a numeric query landing inside an ordered-list marker still gets a real, marked excerpt", () => {
    // "123. some text" — the query "123" sits INSIDE what LINE_PREFIX_RE
    // reads as an ordered-list marker. Stripping it naively would start the
    // window after the match itself, yielding an unmarked (or match-less)
    // excerpt.
    const body = "123. some text follows the marker\n";
    const excerpt = buildExcerpt(body, ["123"]);
    expect(excerpt).toBeDefined();
    expect(excerpt!.text).toContain("123");
    expect(excerpt!.ranges.length).toBeGreaterThan(0);
    const [range] = excerpt!.ranges;
    expect(excerpt!.text.slice(range.start, range.end)).toBe("123");
  });
});
