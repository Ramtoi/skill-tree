import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSearchCorpus } from "@/hooks/useSearchCorpus";
import { invalidateRegistry } from "@/lib/invalidate";
import { makeQueryClient } from "./helpers";

function wrapperFor(client = makeQueryClient()) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { wrapper, client };
}

// M3 (REVIEW-3): §12.3's load-bearing claim — react-query's structural
// sharing hands back the SAME `SearchCorpus` object across a refetch when
// the bodies are byte-for-byte unchanged, which is what lets
// `unifiedSearch.ts`'s per-corpus `WeakMap` cache survive an unrelated
// `invalidateRegistry()` (an equip, a sync with no body edit, …) instead of
// re-lowercasing the whole corpus. `unifiedSearchCorpus.test.ts`'s
// `prepareCorpus(corpus) === prepareCorpus(corpus)` test alone does NOT
// prove this — it never touches react-query. This one does, end to end.
describe("useSearchCorpus — corpus reference stability (M3)", () => {
	it("a refetch after invalidateRegistry() hands back the SAME object when the bodies are byte-equal", async () => {
		const { wrapper, client } = wrapperFor();
		// A fresh object every call — exactly what deserialising an IPC
		// response does. If react-query didn't structurally-share, `data`
		// would change reference on every refetch regardless of content.
		vi.mocked(invoke).mockImplementation(
			(() => Promise.resolve({ skills: { a: "body one" }, snippets: {} })) as never,
		);

		const { result } = renderHook(() => useSearchCorpus(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const first = result.current.data;
		expect(first).toEqual({ skills: { a: "body one" }, snippets: {} });

		await invalidateRegistry(client);
		await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.data).toBe(first));
	});

	it("a refetch whose body actually changed hands back a DIFFERENT object", async () => {
		const { wrapper, client } = wrapperFor();
		vi.mocked(invoke).mockImplementationOnce(
			(() => Promise.resolve({ skills: { a: "body one" }, snippets: {} })) as never,
		);

		const { result } = renderHook(() => useSearchCorpus(), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const first = result.current.data;

		vi.mocked(invoke).mockImplementationOnce(
			(() => Promise.resolve({ skills: { a: "body one — edited" }, snippets: {} })) as never,
		);
		await invalidateRegistry(client);
		await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.data).not.toBe(first));
		expect(result.current.data).toEqual({ skills: { a: "body one — edited" }, snippets: {} });
	});
});
