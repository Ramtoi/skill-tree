import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { SearchCorpus } from "@/lib/unifiedSearch";

/**
 * Every skill + snippet BODY, for the Library's content search
 * (`read_search_corpus`). Refetched whenever `invalidateRegistry()` or
 * `useInvalidateSnippets()` runs — a registry write can create, rename, or
 * archive a skill, and a snippet mutation rewrites its body.
 *
 * React-query's structural sharing hands back the SAME object when the
 * refetched bodies are byte-for-byte unchanged (an equip, a sync with no body
 * edit, …) — that reference stability is what lets `unifiedSearch.ts`'s
 * per-corpus `WeakMap` cache survive an unrelated invalidation instead of
 * re-lowercasing the whole corpus on every keystroke's re-render. Pinned
 * end to end (react-query + this hook) by `useSearchCorpus.test.tsx`
 * ("a refetch after invalidateRegistry() hands back the SAME object");
 * `unifiedSearchCorpus.test.ts`'s `prepareCorpus` identity test covers only
 * the module-level `WeakMap` half of this, not react-query's part. Nothing
 * else is narrowed: the refetch itself (~10ms parse + compare on the real
 * corpus) is accepted rather than special-cased.
 *
 * `staleTime` keeps a second mount (e.g. re-opening the Library) within the
 * window from re-fetching ~2 MB over IPC for no reason — an external edit
 * (outside the app) can lag behind by up to this long, the same pre-existing
 * limit `read_registry` already has.
 */
export function useSearchCorpus() {
	return useQuery<SearchCorpus>({
		queryKey: qk.searchCorpus(),
		queryFn: () => invoke<SearchCorpus>("read_search_corpus"),
		staleTime: 5 * 60_000,
	});
}
