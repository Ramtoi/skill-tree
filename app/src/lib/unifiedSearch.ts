/**
 * Pure ranking model behind the Library's unified floating search
 * (`FloatingSearch`). No React, no imports from `@/components` — every
 * caller (the Library screen, its tests) works with plain data in and plain
 * data out.
 *
 * A hit either matched on the label (and carries `ranges`) or it didn't (and
 * `ranges` is empty) — the caller doesn't need to know which surface
 * (keywords vs. description) produced a non-label match.
 *
 * Wave 2 adds a second ranking band over skill/snippet BODY text
 * (`searchAll`, below `matchItems`). It is a plain lowercased substring scan
 * over a corpus prepared once per corpus identity (`prepareCorpus`) — no
 * search-index library, no async build step (see `DESIGN-library-search/
 * GRILL-2.md` finding 3: measured against the real ~170-document corpus, a
 * substring scan matches an indexed library's recall within noise at a
 * fraction of the code). A body-only hit always ranks below every name/
 * description/tag hit, and its "why is this row here" answer is an
 * `excerpt` (a windowed, marked line from the body) rather than a mark on
 * the row's own text.
 */

export type SearchKind = "skill" | "mcp" | "bundle" | "snippet";

/** Fixed order: every tie-break and every empty-query listing uses it. */
export const KIND_ORDER: SearchKind[] = ["skill", "mcp", "bundle", "snippet"];

export interface SearchItem {
  kind: SearchKind;
  /** Unique within `kind`; skills and MCP servers share one registry
   *  namespace, so a caller that treats `id` as globally unique (as the
   *  Library does, keying a flat `Set<string>` on it) is safe today but is
   *  relying on that shared namespace, not on this contract. */
  id: string;
  /** The identifier the user types. */
  label: string;
  description?: string;
  /** Extra match surface (snippet tags, a skill's bundle names). */
  keywords?: string[];
  /** Where picking it goes. Already encoded. */
  route?: string;
}

/** Half-open [start, end) offsets into `label`. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Which surface produced a hit. Band A (name/description/tags) implies
 *  exactly one of `name`/`description`/`tags` from its tier; band B (a
 *  body-only hit) is always exactly `["body"]`. */
export type MatchField = "name" | "description" | "tags" | "body";

export interface Excerpt {
  /** Already trimmed, whitespace-collapsed, `…`-elided. Render as-is. */
  text: string;
  /** Ranges into `text`, sorted and non-overlapping. */
  ranges: MatchRange[];
}

export interface SearchHit {
  item: SearchItem;
  /** LOWER IS BETTER. Band A: tier * 100 + intra-tier offset (0–599). Band
   *  B: 600 + a small offset, so it never outranks a band-A hit. */
  score: number;
  /** Non-empty only when the match was on `label` (band A tiers 0–3). */
  ranges: MatchRange[];
  /** Ranges into `item.description`. `[]` when there is no description or
   *  nothing in it matched. Populated for every band-A hit, regardless of
   *  which tier matched — "what you typed is marked wherever it shows". */
  descRanges: MatchRange[];
  /** Which surfaces matched. Band A: one of name/description/tags. Band B:
   *  always `["body"]`. n10: no production caller reads this today — a hit's
   *  `excerpt` presence and `ranges`/`descRanges` non-emptiness already tell
   *  the Library everything it renders on. Kept as part of the model's
   *  public shape (it's the cheapest, most explicit way to state "which
   *  surface matched" for a future caller, and every test that pins tier
   *  behaviour asserts it directly) rather than removed and re-derived
   *  later. */
  fields: MatchField[];
  /** Present ONLY for a band-B (body-only) hit — the row's own visible text
   *  does not contain the query. */
  excerpt?: Excerpt;
}

export type KindCounts = Record<SearchKind, number> & { all: number };

/** Every skill + snippet BODY the Library can search, keyed exactly as
 *  `read_search_corpus` (the Rust command) returns them: a registry skill
 *  name, or a snippet's file stem. Bundles have no body. */
export interface SearchCorpus {
  skills: Record<string, string>;
  snippets: Record<string, string>;
}

/** Characters that make a substring match "start a word" for tier 2. No
 * camel-hump splitting — every identifier in this app is kebab or snake. */
const WORD_BOUNDARY_CHARS = new Set(["-", "_", ".", "/", ":", " "]);

/** Earliest index at which `q` starts a word inside `lowerLabel` — i.e. is
 * preceded by a boundary character — or -1. Callers already know
 * `lowerLabel` does not start with `q` (that's tier 1, checked first). */
function wordPrefixIndex(lowerLabel: string, q: string): number {
  let idx = lowerLabel.indexOf(q);
  while (idx !== -1) {
    if (idx > 0 && WORD_BOUNDARY_CHARS.has(lowerLabel[idx - 1])) return idx;
    idx = lowerLabel.indexOf(q, idx + 1);
  }
  return -1;
}

/** Every case-insensitive, non-overlapping occurrence of `needle` in `text`,
 *  capped at 8 (a mark is a hint, not an index). Empty `needle` matches
 *  nothing. */
function locateAll(text: string, needle: string): MatchRange[] {
  if (!needle) return [];
  const lower = text.toLowerCase();
  const q = needle.toLowerCase();
  const ranges: MatchRange[] = [];
  let idx = lower.indexOf(q);
  while (idx !== -1 && ranges.length < 8) {
    ranges.push({ start: idx, end: idx + q.length });
    idx = lower.indexOf(q, idx + q.length);
  }
  return ranges;
}

/** Sorts by start and merges overlapping/adjacent ranges — a multi-term
 *  excerpt query, or a query term that is a substring of another matched
 *  term, can otherwise overlap. `highlightParts` assumes non-overlapping,
 *  ascending input. */
function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: MatchRange[] = [{ ...sorted[0] }];
  for (const r of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** `locateAll` for every term in `terms`, merged into one non-overlapping,
 *  ascending list. */
function locateAllTerms(text: string, terms: readonly string[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const term of terms) ranges.push(...locateAll(text, term));
  return mergeRanges(ranges);
}

interface ScoredMatch {
  score: number;
  ranges: MatchRange[];
  field: MatchField;
}

/** Scores one item against an already-trimmed-and-lowercased `q`, or
 * returns `null` when nothing about the item matches. Tiers, best to worst:
 * exact match, label prefix, label word-prefix, label substring, keyword
 * match, description substring. */
function scoreItem(item: SearchItem, q: string): ScoredMatch | null {
  const label = item.label;
  const lowerLabel = label.toLowerCase();
  // m9: every identifier in this app is kebab-case, so a multi-word query
  // ("compose ui") should still find "android-compose-ui" the way a single
  // word already does — fold spaces to hyphens for the LABEL tiers only.
  // Tags/description stay on the untouched `q`: a keyword is a single
  // token, and a description is prose where spaces are meaningful.
  const qLabel = q.includes(" ") ? q.replace(/\s+/g, "-") : q;

  if (lowerLabel === qLabel) {
    return { score: 0, ranges: [{ start: 0, end: label.length }], field: "name" };
  }
  if (lowerLabel.startsWith(qLabel)) {
    return { score: 100, ranges: [{ start: 0, end: qLabel.length }], field: "name" };
  }
  const wordIdx = wordPrefixIndex(lowerLabel, qLabel);
  if (wordIdx !== -1) {
    return {
      score: 200 + Math.min(wordIdx, 99),
      ranges: [{ start: wordIdx, end: wordIdx + qLabel.length }],
      field: "name",
    };
  }
  const containsIdx = lowerLabel.indexOf(qLabel);
  if (containsIdx !== -1) {
    return {
      score: 300 + Math.min(containsIdx, 99),
      ranges: [{ start: containsIdx, end: containsIdx + qLabel.length }],
      field: "name",
    };
  }
  if (item.keywords) {
    for (const keyword of item.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (lowerKeyword === q || lowerKeyword.startsWith(q)) {
        return { score: 400, ranges: [], field: "tags" };
      }
    }
  }
  if (item.description) {
    const descIdx = item.description.toLowerCase().indexOf(q);
    if (descIdx !== -1) {
      return { score: 500 + Math.min(descIdx, 99), ranges: [], field: "description" };
    }
  }
  return null;
}

/** Total order across hits sharing a tier: shorter label first, then
 * `KIND_ORDER`, then a plain `localeCompare` that never falls through (so
 * the sort is input-order independent). */
function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.item.label.length !== b.item.label.length) {
    return a.item.label.length - b.item.label.length;
  }
  const kindDelta = KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind);
  if (kindDelta !== 0) return kindDelta;
  return a.item.label.localeCompare(b.item.label);
}

/** Same total order, used directly for the empty-query listing (every hit
 * scores 0, so `compareHits`'s length tie-break would sort by label length
 * before locale — the empty-query browse mode wants plain `KIND_ORDER` then
 * label instead). */
function compareBrowse(a: SearchItem, b: SearchItem): number {
  const kindDelta = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kindDelta !== 0) return kindDelta;
  return a.label.localeCompare(b.label);
}

/**
 * Ranks `items` against `query`, optionally restricted to `kinds` (applied
 * BEFORE scoring). Empty query is a browse mode: every item in the kind set
 * comes back at `score: 0` with empty `ranges`, ordered by `KIND_ORDER` then
 * label — this is what makes "press BUNDLES with no query" work without a
 * second code path.
 */
export function matchItems(
  items: readonly SearchItem[],
  query: string,
  kinds?: readonly SearchKind[],
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const pool = kinds ? items.filter((item) => kinds.includes(item.kind)) : items;

  if (q === "") {
    return [...pool].sort(compareBrowse).map((item) => ({
      item,
      score: 0,
      ranges: [] as MatchRange[],
      descRanges: [] as MatchRange[],
      fields: [] as MatchField[],
    }));
  }

  const hits: SearchHit[] = [];
  for (const item of pool) {
    const match = scoreItem(item, q);
    if (!match) continue;
    hits.push({
      item,
      score: match.score,
      ranges: match.ranges,
      // "What you typed is marked wherever it shows" — a name-tier hit
      // whose description also contains the query gets both marked.
      descRanges: locateAll(item.description ?? "", q),
      fields: [match.field],
    });
  }
  return hits.sort(compareHits);
}

/**
 * Per-kind match counts, ignoring any kind filter — the chip counts must say
 * what *selecting* that chip would yield, so they are always computed over
 * every kind. `all` is the sum of the four. Band A (name/description/tags)
 * only — pairs with `matchItems`. `countHits` is the general form that also
 * counts a body-hit list from `searchAll`.
 *
 * n10: `SkillLibrary.tsx` now goes through `useLibrarySearch` (which counts
 * via `countHits(searchAll(...))` directly), so this one is exercised only
 * by `unifiedSearch.test.ts` today. Kept — and kept exported — as the
 * documented band-A-only baseline test 7.2 #8's "content matches raise the
 * count" assertion compares against.
 */
export function countByKind(items: readonly SearchItem[], query: string): KindCounts {
  return countHits(matchItems(items, query));
}

/** Per-kind counts from an ALREADY-computed hit list — so a chip count and
 *  the rows on screen can never disagree about what matched. */
export function countHits(hits: readonly SearchHit[]): KindCounts {
  const counts: KindCounts = { skill: 0, mcp: 0, bundle: 0, snippet: 0, all: 0 };
  for (const hit of hits) {
    counts[hit.item.kind]++;
    counts.all++;
  }
  return counts;
}

// ─── Band B — content search over skill/snippet bodies ─────────────────────
//
// GRILL-2 finding 3: no search-index library. A lowercased-once corpus plus
// a per-keystroke `indexOf` scan matches an indexed library's recall within
// noise at this corpus size (~170 documents / ~2 MB), with none of the
// build-jank, tokenizer-edge, or fuzzy-false-positive risk an index carries.

export interface PreparedCorpus {
  /** The corpus this was prepared from — kept for excerpt building (the
   *  ORIGINAL, unlowercased body text). */
  readonly corpus: SearchCorpus;
  readonly lowerSkills: Map<string, string>;
  readonly lowerSnippets: Map<string, string>;
}

/** `corpus` object identity -> its prepared (lowercased-once) form. A plain
 *  module-level cache, not React state: react-query hands back the SAME
 *  corpus object across a refetch when the bodies are byte-for-byte
 *  unchanged (structural sharing), so calling this every render is cheap —
 *  the expensive lowercasing pass runs once per distinct corpus, not once
 *  per keystroke or per remount. See `useSearchCorpus`'s doc comment. */
const CORPUS_CACHE = new WeakMap<SearchCorpus, PreparedCorpus>();

/** Lowercases every body in `corpus` once, cached by `corpus` object
 *  identity. Safe to call on every render — a cache hit is a single `Map`
 *  lookup. */
export function prepareCorpus(corpus: SearchCorpus): PreparedCorpus {
  const cached = CORPUS_CACHE.get(corpus);
  if (cached) return cached;

  const lowerSkills = new Map<string, string>();
  for (const [id, body] of Object.entries(corpus.skills)) {
    lowerSkills.set(id, body.toLowerCase());
  }
  const lowerSnippets = new Map<string, string>();
  for (const [id, body] of Object.entries(corpus.snippets)) {
    lowerSnippets.set(id, body.toLowerCase());
  }

  const prepared: PreparedCorpus = { corpus, lowerSkills, lowerSnippets };
  CORPUS_CACHE.set(corpus, prepared);
  return prepared;
}

/** `corpus.skills`/`corpus.snippets` are keyed by registry name / snippet
 *  stem — a skill and an mcp-server share the SAME map (mcp-servers are
 *  just skills of a different `type`). Bundles have no body. */
function rawBodyFor(item: SearchItem, prepared: PreparedCorpus): string | undefined {
  if (item.kind === "snippet") return prepared.corpus.snippets[item.id];
  if (item.kind === "skill" || item.kind === "mcp") return prepared.corpus.skills[item.id];
  return undefined;
}

function lowerBodyFor(item: SearchItem, prepared: PreparedCorpus): string | undefined {
  if (item.kind === "snippet") return prepared.lowerSnippets.get(item.id);
  if (item.kind === "skill" || item.kind === "mcp") return prepared.lowerSkills.get(item.id);
  return undefined;
}

/** A leading Markdown list/heading/quote/table-row marker — stripping it
 *  keeps an excerpt reading as prose instead of raw syntax (`## `, `- `,
 *  `1. `, `> `, `| `). */
const LINE_PREFIX_RE = /^(#{1,6}\s+|[-*]\s+|\d+[.)]\s+|>\s+|\|\s*)/;

/**
 * Builds the one-line "why this row matched" excerpt for a body-only hit:
 * the line containing the EARLIEST occurrence of any `terms` entry, a leading
 * Markdown marker stripped, windowed to ~`max` chars around that occurrence
 * with `…` on a truncated edge, every term that lands inside the window
 * marked. Returns `undefined` when none of `terms` literally occurs in
 * `body` (should not happen for a hit `searchAll` itself produced, but a
 * defensive `undefined` beats a lying excerpt).
 *
 * `lowerBody` is the ALREADY-lowercased body (`prepareCorpus`'s per-corpus
 * cache) — pass it to avoid re-lowercasing up to ~2 MB on every keystroke
 * (a body match this common re-derives on almost every render otherwise).
 * Falls back to lowercasing `body` itself only when the caller has no
 * prepared form on hand (e.g. a hand-built fixture in a test).
 */
export function buildExcerpt(
  body: string,
  terms: readonly string[],
  lowerBody: string = body.toLowerCase(),
  max = 120,
): Excerpt | undefined {
  let bestIdx = -1;
  for (const term of terms) {
    const idx = lowerBody.indexOf(term.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) return undefined;

  const rawLineStart = body.lastIndexOf("\n", bestIdx) + 1;
  const lineEndIdx = body.indexOf("\n", bestIdx);
  const lineEnd = lineEndIdx === -1 ? body.length : lineEndIdx;

  const prefixMatch = LINE_PREFIX_RE.exec(body.slice(rawLineStart, lineEnd));
  // n12: a numeric query ("123") can itself sit INSIDE what looks like an
  // ordered-list marker ("123. text") — stripping the marker would then
  // start the window after the very match it's supposed to show. Skip the
  // strip whenever the match falls inside the matched prefix span.
  const prefixEnd = prefixMatch ? rawLineStart + prefixMatch[0].length : rawLineStart;
  const lineStart = prefixMatch && bestIdx >= prefixEnd ? prefixEnd : rawLineStart;

  const windowStart = Math.max(lineStart, bestIdx - 40);
  const windowEnd = Math.min(lineEnd, windowStart + max);

  const collapsed = body.slice(windowStart, windowEnd).replace(/\s+/g, " ").trim();
  const prefix = windowStart > lineStart ? "…" : "";
  const suffix = windowEnd < lineEnd ? "…" : "";
  const text = `${prefix}${collapsed}${suffix}`;

  // Recomputed against the FINAL string (after the whitespace collapse) so
  // the offsets can never drift from what's actually rendered. A term
  // outside the window (an AND partner far from the earliest hit) simply
  // finds nothing here and stays unmarked — documented, not a bug.
  return { text, ranges: locateAllTerms(text, terms) };
}

/**
 * Band A (`matchItems`) ∪ band B (a content match), ranked — the one search
 * entry point the Library uses. Band B runs only when `prepared` is given,
 * the query is non-empty, and EVERY trimmed term is at least 3 characters
 * (a 1–2 char term would light most of the corpus — see
 * `DESIGN-library-search/GRILL-2.md` finding 5). Multi-term matching is AND:
 * every term must occur somewhere in the body, in any order.
 *
 * Every band-A hit outranks every band-B hit (scores 0–599 vs. 600+), and an
 * item band A already matched is never reconsidered for band B (`seen`).
 */
export function searchAll(
  items: readonly SearchItem[],
  query: string,
  kinds?: readonly SearchKind[],
  prepared?: PreparedCorpus,
): SearchHit[] {
  const bandA = matchItems(items, query, kinds);
  const q = query.trim();
  if (!prepared || q === "") return bandA;

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || terms.some((t) => t.length < 3)) return bandA;

  const seen = new Set(bandA.map((h) => `${h.item.kind}:${h.item.id}`));
  const pool = kinds ? items.filter((item) => kinds.includes(item.kind)) : items;

  const candidates: Array<{ item: SearchItem; firstOffset: number }> = [];
  for (const item of pool) {
    if (seen.has(`${item.kind}:${item.id}`)) continue;
    const lowerBody = lowerBodyFor(item, prepared);
    if (!lowerBody) continue;

    let firstOffset = Infinity;
    let matchesAll = true;
    for (const term of terms) {
      const idx = lowerBody.indexOf(term);
      if (idx === -1) {
        matchesAll = false;
        break;
      }
      if (idx < firstOffset) firstOffset = idx;
    }
    if (matchesAll) candidates.push({ item, firstOffset });
  }

  // Rank by earliest occurrence, then the same total order as band A —
  // input-order independent, same as `compareHits`.
  candidates.sort((a, b) => {
    if (a.firstOffset !== b.firstOffset) return a.firstOffset - b.firstOffset;
    if (a.item.label.length !== b.item.label.length) {
      return a.item.label.length - b.item.label.length;
    }
    const kindDelta = KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind);
    if (kindDelta !== 0) return kindDelta;
    return a.item.label.localeCompare(b.item.label);
  });

  const bandB: SearchHit[] = candidates.map(({ item }, i) => {
    const rawBody = rawBodyFor(item, prepared) ?? "";
    const lowerBody = lowerBodyFor(item, prepared) ?? "";
    return {
      item,
      score: 600 + Math.min(i, 399),
      ranges: [],
      descRanges: [],
      fields: ["body"],
      excerpt: buildExcerpt(rawBody, terms, lowerBody),
    };
  });

  return [...bandA, ...bandB];
}

/** Splits `label` into rendered runs from a set of (possibly unordered,
 * non-overlapping) `ranges`. `hit: true` runs get a `<mark>`. */
export function highlightParts(
  label: string,
  ranges: readonly MatchRange[],
): Array<{ text: string; hit: boolean }> {
  if (ranges.length === 0) return [{ text: label, hit: false }];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const runs: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) {
      runs.push({ text: label.slice(cursor, range.start), hit: false });
    }
    runs.push({ text: label.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < label.length) {
    runs.push({ text: label.slice(cursor), hit: false });
  }
  return runs;
}
