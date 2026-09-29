import { useMemo } from "react";
import { useSearchCorpus } from "./useSearchCorpus";
import {
	countHits,
	prepareCorpus,
	searchAll,
	type KindCounts,
	type SearchHit,
	type SearchItem,
	type SearchKind,
} from "@/lib/unifiedSearch";

export interface LibrarySearch {
	/**
	 * Every match across every kind, ranked. The one source of truth every
	 * other field here derives from. n10: `SkillLibrary.tsx` (the only
	 * caller) doesn't destructure this directly today — it reads `counts`/
	 * `listHits`/`bundleHits`/`snippetHits` instead — but it's exposed so a
	 * future consumer (a combined results view, a "jump to top hit" action)
	 * doesn't have to re-run `searchAll` to get what this hook already
	 * computed.
	 */
	allHits: SearchHit[];
	counts: KindCounts;
	/** skill+mcp hits by name; null when the query is empty (= no filtering). */
	listHits: Map<string, SearchHit> | null;
	bundleHits: SearchHit[];
	snippetHits: SearchHit[];
}

/**
 * The Library's one search call: band A (name/description/tags) ∪ band B (a
 * skill/snippet body match — `lib/unifiedSearch.ts`'s `searchAll`), ranked,
 * then sliced into what each part of the screen needs. Replaces three
 * separate `matchItems` calls per keystroke (`counts`, `listMatchIds`,
 * `crossHits`) with one `searchAll` call plus cheap derived slices.
 *
 * `items` is the FACET-filtered pool (source/bundle facets already applied),
 * the same pool wave 1 used for all three of those. Content search needs no
 * separate facet-free pool: `prepareCorpus` never looks at `items` — it only
 * lowercases every body once, keyed on the corpus object — so narrowing
 * `items` narrows band B for free, with no index to rebuild when a facet
 * changes.
 */
export function useLibrarySearch(args: {
	items: readonly SearchItem[];
	query: string;
	kindFilter: "all" | SearchKind;
}): LibrarySearch {
	const { items, query, kindFilter } = args;
	const { data: corpus } = useSearchCorpus();
	const prepared = useMemo(() => (corpus ? prepareCorpus(corpus) : undefined), [corpus]);

	// Chip counts ignore the active kind filter — they say what SELECTING
	// that chip would yield — so they're always computed over every kind.
	const allHits = useMemo(
		() => searchAll(items, query, undefined, prepared),
		[items, query, prepared],
	);
	const counts = useMemo(() => countHits(allHits), [allHits]);

	const listHits = useMemo(() => {
		if (!query.trim()) return null;
		const map = new Map<string, SearchHit>();
		for (const hit of allHits) {
			if (hit.item.kind === "skill" || hit.item.kind === "mcp") {
				map.set(hit.item.id, hit);
			}
		}
		return map;
	}, [allHits, query]);

	// Cross-entity matches render as BODY rows, never in the floating bar —
	// kind = all groups them under the skill list once a query is typed;
	// kind = bundle/snippet is the whole body. skill/mcp kinds are already
	// the list, so this stays empty for them.
	//
	// n11: derived by FILTERING `allHits` (which already has every kind)
	// rather than a second `searchAll` call — `allHits`'s pool is never
	// kind-restricted, so a bundle/snippet's score and band placement are
	// identical either way, and `compareHits`/`compareBrowse` are both total
	// orders, so filtering preserves the sub-order a kind-scoped call would
	// have produced (band B's absolute score number can differ slightly —
	// its index runs over more candidates — but relative order, all a
	// caller ever renders on, does not).
	const showCross =
		kindFilter === "bundle" || kindFilter === "snippet" ||
		(kindFilter === "all" && query.trim().length > 0);
	const bundleHits = useMemo(() => {
		if (!showCross || kindFilter === "snippet") return [];
		return allHits.filter((h) => h.item.kind === "bundle");
	}, [allHits, showCross, kindFilter]);
	const snippetHits = useMemo(() => {
		if (!showCross || kindFilter === "bundle") return [];
		return allHits.filter((h) => h.item.kind === "snippet");
	}, [allHits, showCross, kindFilter]);

	return { allHits, counts, listHits, bundleHits, snippetHits };
}
