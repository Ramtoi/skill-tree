import { describe, it, expect } from "vitest";
import {
  matchItems,
  countByKind,
  countHits,
  highlightParts,
  type SearchItem,
} from "@/lib/unifiedSearch";

// Fixture exercising every ranking tier: exact, label-prefix, label
// word-prefix, label substring, keyword, and description.
const items: SearchItem[] = [
  {
    kind: "skill",
    id: "android-compose-ui",
    label: "android-compose-ui",
    // Wave 2 (D7): a name-tier hit whose description ALSO contains the
    // query gets both `ranges` and `descRanges` marked — test 12.
    description: "Android UI helpers for Compose",
  },
  { kind: "skill", id: "compose-helper", label: "compose-helper" },
  {
    kind: "skill",
    id: "deep-research",
    label: "deep-research",
    description: "Research android notes end to end",
  },
  { kind: "bundle", id: "android", label: "android" },
  {
    kind: "snippet",
    id: "android-conventions",
    label: "android-conventions",
    keywords: ["compose", "state"],
  },
];

function ids(hits: ReturnType<typeof matchItems>): string[] {
  return hits.map((h) => h.item.id);
}

describe("unifiedSearch", () => {
  it("1. tiers: exact -> label-prefix (shorter first) -> description", () => {
    expect(ids(matchItems(items, "android"))).toEqual([
      "android",
      "android-compose-ui",
      "android-conventions",
      "deep-research",
    ]);
  });

  it("2. tiers: label-prefix -> word-prefix -> keyword", () => {
    expect(ids(matchItems(items, "compose"))).toEqual([
      "compose-helper",
      "android-compose-ui",
      "android-conventions",
    ]);
  });

  it("3. name beats description: a description-only match carries empty ranges", () => {
    const hit = matchItems(items, "android").find((h) => h.item.id === "deep-research");
    expect(hit).toBeDefined();
    expect(hit!.ranges).toEqual([]);
  });

  it("4. ranges: word-prefix match offsets + highlightParts splits the label", () => {
    const hit = matchItems(items, "compose").find((h) => h.item.id === "android-compose-ui");
    expect(hit).toBeDefined();
    expect(hit!.ranges).toEqual([{ start: 8, end: 15 }]);
    const parts = highlightParts("android-compose-ui", hit!.ranges);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(3);
    const hitRun = parts.find((p) => p.hit);
    expect(hitRun?.text).toBe("compose");
  });

  it("5. kind filter narrows the pool before scoring", () => {
    const hits = matchItems(items, "android", ["bundle"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].item.kind).toBe("bundle");
  });

  it("6. empty query browses every item, ordered by KIND_ORDER then label", () => {
    expect(ids(matchItems(items, ""))).toEqual([
      "android-compose-ui",
      "compose-helper",
      "deep-research",
      "android",
      "android-conventions",
    ]);
  });

  it("7. determinism: sort order is independent of input order", () => {
    const shuffled = [items[3], items[0], items[4], items[2], items[1]];
    expect(matchItems(shuffled, "an")).toEqual(matchItems(items, "an"));
  });

  it("8. normalisation: query is trimmed and lowercased", () => {
    expect(matchItems(items, "  ANDROID ")).toEqual(matchItems(items, "android"));
  });

  it("9. countByKind ignores any kind filter (it has none to ignore)", () => {
    expect(countByKind(items, "android")).toEqual({
      all: 4,
      skill: 2,
      mcp: 0,
      bundle: 1,
      snippet: 1,
    });
  });

  it("10. countByKind on an empty query counts every item", () => {
    expect(countByKind(items, "")).toEqual({
      all: 5,
      skill: 3,
      mcp: 0,
      bundle: 1,
      snippet: 1,
    });
  });

  it("11. no match drops the item", () => {
    expect(matchItems(items, "zzz")).toEqual([]);
  });

  it("12. a name-tier hit whose description also contains the query has both ranges and descRanges", () => {
    const hit = matchItems(items, "android").find((h) => h.item.id === "android-compose-ui");
    expect(hit).toBeDefined();
    expect(hit!.ranges.length).toBeGreaterThan(0);
    expect(hit!.descRanges.length).toBeGreaterThan(0);
    expect(hit!.fields).toEqual(["name"]);
  });

  it("13. countByKind(items, q) === countHits(matchItems(items, q))", () => {
    expect(countByKind(items, "android")).toEqual(countHits(matchItems(items, "android")));
    expect(countByKind(items, "")).toEqual(countHits(matchItems(items, "")));
  });

  it("14. a multi-word query folds to hyphens for the LABEL tiers (m9): 'compose ui' still finds android-compose-ui", () => {
    const hit = matchItems(items, "compose ui").find((h) => h.item.id === "android-compose-ui");
    expect(hit).toBeDefined();
    expect(hit!.fields).toEqual(["name"]);
  });

  it("15. the hyphen fold never reaches description prose (spaces stay meaningful there)", () => {
    // "deep-research"'s description is "Research android notes end to end" —
    // no hyphenated form of "notes end" exists in it, so this must still
    // match via the ordinary substring (not a folded, wrong string).
    const hit = matchItems(items, "notes end").find((h) => h.item.id === "deep-research");
    expect(hit).toBeDefined();
    expect(hit!.fields).toEqual(["description"]);
  });
});
