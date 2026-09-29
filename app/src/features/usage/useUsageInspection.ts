import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { parseCliJson } from "@/lib/skillPack";
import { runHubCmd } from "@/lib/hubCmd";
import type { InspectionBodyPayload, InspectionIndexPayload, InspectionPayload, InspectionPinsPayload, PinMutationPayload } from "./usageInspectionTypes";

type InspectionView = "overview" | "tools" | "changes";
type ToolPage = NonNullable<InspectionPayload["tool_calls"]>;

/** The inspection command keeps the stable overview envelope separate from
 * paged tools and changes responses. Normalize both forms at this boundary so
 * views retain run labels and session evidence without inventing view data. */
export function normalizeInspectionViewPayload(raw: unknown, view: InspectionView, overview?: InspectionPayload): InspectionPayload {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "inspection_unavailable" };
  const value = raw as Record<string, unknown>;
  if (value.ok === false) return raw as InspectionPayload;
  const base: Partial<InspectionPayload> = overview ?? {};
  if (view === "tools") {
    const source = (value.tool_calls && typeof value.tool_calls === "object" ? value.tool_calls : value) as Record<string, unknown>;
    const items = Array.isArray(source.items) ? source.items : [];
    return {
      ...base,
      ...value,
      ok: true,
      tool_calls: {
        items: items as ToolPage["items"],
        next_after: typeof source.next_after === "string" ? source.next_after : null,
        total: typeof source.total === "number" ? source.total : items.length,
        status: source.status === "partial" ? "partial" : "complete",
      },
      evidence: (value.evidence as InspectionPayload["evidence"]) ?? base.evidence,
    };
  }
  if (view === "changes") {
    const changes = Array.isArray(value.changes) ? value.changes : [];
    return { ...base, ...value, ok: true, changes: changes as InspectionPayload["changes"], evidence: (value.evidence as InspectionPayload["evidence"]) ?? base.evidence };
  }
  return raw as InspectionPayload;
}

export function useUsageInspectionIndex(enabled = true) {
  return useQuery({
    queryKey: qk.usageInspectionIndex(),
    enabled,
    queryFn: async (): Promise<InspectionIndexPayload> => {
      const result = await runHubCmd(["usage", "inspect-index", "--json"]);
      return parseCliJson<InspectionIndexPayload>(result.output);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Tool calls stream in pages of this size. The store accepts up to 10,000;
 * 500 keeps one page under a second on a large session while the first page
 * renders long before the rest arrive. */
export const TOOL_PAGE_LIMIT = 500;
type ToolPageParam = string | null;

/** The overview is the slow read. Serve Tool calls and Changes from the
 * cached timeline overview when it is fresh instead of reading it again. */
function fetchInspectionOverview(client: QueryClient, harness: string, sessionId: string): Promise<InspectionPayload> {
  return client.fetchQuery({
    queryKey: qk.usageInspection(harness, sessionId, "overview", null),
    queryFn: async () => parseCliJson<InspectionPayload>((await runHubCmd(["usage", "inspect", sessionId, "--harness", harness, "--view", "overview", "--json"])).output),
    staleTime: 30_000,
    retry: false,
  });
}

export type UsageInspectionQuery = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: InspectionPayload | undefined;
  refetch: () => Promise<unknown>;
  /** Tool calls pages are still arriving behind the pages already shown. */
  isLoadingMore: boolean;
};

/** Merge the tool pages fetched so far into one payload. A later page that
 * failed, or a cursor that did not advance, marks the payload partial with the
 * same notices the one-shot loader used, so the panel's retry stays the same. */
export function mergeToolPages(pages: InspectionPayload[] | undefined, params: ToolPageParam[] | undefined, nextPageFailed: boolean, hasNextPage: boolean): InspectionPayload | undefined {
  if (!pages?.length) return undefined;
  const first = pages[0];
  if (!first.ok || !first.tool_calls) return first;
  const failedIndex = pages.findIndex((page) => !page.ok);
  const good = failedIndex === -1 ? pages : pages.slice(0, failedIndex);
  const items = good.flatMap((page) => page.tool_calls?.items ?? []);
  const last = good[good.length - 1];
  const lastCursor = last?.tool_calls?.next_after ?? null;
  if (failedIndex !== -1) return partialToolPayload(first, items, params?.[failedIndex] ?? lastCursor ?? "", "A retained Tool calls page could not be read; showing the captured pages.");
  if (nextPageFailed) return partialToolPayload(first, items, lastCursor ?? "", "A retained Tool calls page could not be read; showing the captured pages.");
  if (lastCursor !== null && lastCursor === params?.[params.length - 1]) return partialToolPayload(first, items, lastCursor, "Tool calls pagination stopped because the source returned the same page cursor.");
  return { ...first, tool_calls: { ...first.tool_calls, items, next_after: hasNextPage ? lastCursor : null, total: Math.max(first.tool_calls.total, items.length) } };
}

export function useUsageInspection(harness: string, sessionId: string, view: "overview" | "tools" | "changes", runId?: string | null, enabled = true): UsageInspectionQuery {
  const client = useQueryClient();
  const active = enabled && !!harness && !!sessionId;
  const single = useQuery({
    queryKey: qk.usageInspection(harness, sessionId, view, view === "overview" ? runId : null),
    enabled: active && view !== "tools",
    queryFn: async (): Promise<InspectionPayload> => {
      if (view === "overview") {
        const args = ["usage", "inspect", sessionId, "--harness", harness, "--view", "overview"];
        if (runId) args.push("--run", runId);
        args.push("--json");
        return parseCliJson<InspectionPayload>((await runHubCmd(args)).output);
      }
      const overview = await fetchInspectionOverview(client, harness, sessionId);
      if (!overview.ok) return overview;
      const result = await runHubCmd(["usage", "inspect", sessionId, "--harness", harness, "--view", "changes", "--json"]);
      return normalizeInspectionViewPayload(parseCliJson<unknown>(result.output), "changes", overview);
    },
    staleTime: 30_000,
    retry: false,
  });
  // Tools are fetched as the complete session chronology. Agent filtering is
  // a presentation concern because the backend page has no run list. Each
  // page renders as it lands instead of waiting for the whole chronology.
  const pages = useInfiniteQuery({
    queryKey: qk.usageInspection(harness, sessionId, "tools", null),
    enabled: active && view === "tools",
    initialPageParam: null as ToolPageParam,
    queryFn: async ({ pageParam }): Promise<InspectionPayload> => {
      const overview = await fetchInspectionOverview(client, harness, sessionId);
      if (!overview.ok) return overview;
      const args = ["usage", "inspect", sessionId, "--harness", harness, "--view", "tools", "--limit", String(TOOL_PAGE_LIMIT)];
      if (pageParam) args.push("--after", pageParam);
      args.push("--json");
      return normalizeInspectionViewPayload(parseCliJson<unknown>((await runHubCmd(args)).output), "tools", overview);
    },
    getNextPageParam: (last, _all, lastParam) => {
      const cursor = last.ok ? last.tool_calls?.next_after ?? null : null;
      // A cursor equal to the one just used would page forever; stop and let
      // mergeToolPages report the stall.
      return cursor && cursor !== lastParam ? cursor : undefined;
    },
    staleTime: 30_000,
    retry: false,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = pages;
  useEffect(() => {
    if (view === "tools" && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [view, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const merged = useMemo(() => mergeToolPages(pages.data?.pages, pages.data?.pageParams as ToolPageParam[] | undefined, isFetchNextPageError, hasNextPage), [pages.data, isFetchNextPageError, hasNextPage]);
  if (view !== "tools") return { isPending: single.isPending, isError: single.isError, error: single.error, data: single.data, refetch: single.refetch, isLoadingMore: false };
  return {
    isPending: pages.isPending,
    isError: pages.isError && !isFetchNextPageError,
    error: pages.error,
    data: merged,
    refetch: () => isFetchNextPageError ? fetchNextPage() : pages.refetch(),
    isLoadingMore: hasNextPage && !isFetchNextPageError,
  };
}

export function useUsageInspectionBody(harness: string, sessionId: string, bodyId: string | null, afterChunk: number | null = null) {
  return useQuery({
    queryKey: qk.usageInspectionBody(harness, sessionId, bodyId ?? "", afterChunk),
    enabled: !!bodyId && !!harness && !!sessionId,
    queryFn: async (): Promise<InspectionBodyPayload> => {
      const args = ["usage", "inspect", sessionId, "--harness", harness, "--view", "body", "--body", bodyId!, "--limit-chunks", "32"];
      if (afterChunk !== null) args.push("--after-chunk", String(afterChunk));
      args.push("--json");
      let result = await runHubCmd(args);
      const first = parseCliJson<InspectionBodyPayload>(result.output);
      if (!first.ok || !first.chunks || first.next_after_chunk == null) return first;
      const chunks = [...first.chunks];
      let cursor: number | null = first.next_after_chunk;
      while (cursor != null) {
        const pageArgs = ["usage", "inspect", sessionId, "--harness", harness, "--view", "body", "--body", bodyId!, "--after-chunk", String(cursor), "--limit-chunks", "32", "--json"];
        result = await runHubCmd(pageArgs);
        const page = parseCliJson<InspectionBodyPayload>(result.output);
        // A body can be pruned after its first page was read.  The retention
        // tombstone is authoritative: preserve the pruned verdict and date
        // so the panel can name the side and avoid offering a useless retry.
        if (!page.ok && page.reason === "pruned") {
          return {
            ...page,
            body_id: page.body_id ?? bodyId!,
            status: "pruned",
            chunks,
          };
        }
        if (!page.ok || !page.chunks) return { ...first, retrieval_status: "failed", retrieval_error: "A retained body page could not be read.", reason: "body_page_unavailable", chunks, next_after_chunk: cursor };
        if (page.next_after_chunk === cursor) return { ...first, retrieval_status: "partial", retrieval_error: "Body pagination stopped because the source returned the same page cursor.", reason: "body_pagination_stalled", chunks: chunks.concat(page.chunks), next_after_chunk: cursor };
        chunks.push(...page.chunks);
        cursor = page.next_after_chunk ?? null;
      }
      return { ...first, chunks, next_after_chunk: null };
    },
    // A body can be pruned while the inspector is closed. Keep the cached
    // value available for the initial render, but mark it stale so enabling
    // the same key after Close always checks the store again.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

function partialToolPayload(first: InspectionPayload, items: NonNullable<InspectionPayload["tool_calls"]>["items"], cursor: string, notice: string): InspectionPayload {
  return { ...first, tool_calls: { ...first.tool_calls!, items, next_after: cursor, status: "partial" }, evidence: { status: "partial", notices: [...(first.evidence?.notices ?? []), notice] } };
}

export async function fetchUsageInspectionPins(): Promise<InspectionPinsPayload> {
  let result = await runHubCmd(["usage", "pin", "list", "--limit", "100", "--json"]);
  const first = parseCliJson<InspectionPinsPayload>(result.output);
  if (!first.ok || !first.items) return first;
  const items = [...first.items];
  let cursor = first.next_after;
  while (cursor) {
    result = await runHubCmd(["usage", "pin", "list", "--after", cursor, "--limit", "100", "--json"]);
    const page = parseCliJson<InspectionPinsPayload>(result.output);
    if (!page.ok || !page.items) return { ...first, items, next_after: cursor, evidence: { status: "partial", notices: [...(first.evidence?.notices ?? []), "Some pinned sessions could not be read."] } };
    if (page.next_after === cursor) return { ...first, items: items.concat(page.items), next_after: cursor, evidence: { status: "partial", notices: [...(first.evidence?.notices ?? []), "Pinned session pagination stopped because the source returned the same page cursor."] } };
    items.push(...page.items);
    cursor = page.next_after;
  }
  return { ...first, items, next_after: null };
}

export function useUsageSessionPins() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: qk.usagePins(), queryFn: fetchUsageInspectionPins, staleTime: 30_000, refetchOnWindowFocus: false });
  const mutation = useMutation({
    mutationFn: async (input: { action: "add" | "remove"; harness: string; sessionId: string; runId?: string | null }): Promise<PinMutationPayload> => {
      const args = ["usage", "pin", input.action, input.sessionId, "--harness", input.harness];
      if (input.runId) args.push("--run", input.runId);
      args.push("--json");
      const result = await runHubCmd(args);
      const payload = parseCliJson<PinMutationPayload>(result.output);
      if (!payload.ok) throw new Error(payload.reason ?? `Could not ${input.action} usage pin.`);
      return payload;
    },
    onSuccess: (payload, input) => {
      const pin = payload.pin;
      if (pin) {
        queryClient.setQueryData<InspectionPinsPayload>(qk.usagePins(), (current) => {
          const items = current?.items ?? [];
          const matches = (item: typeof pin) => item.harness === pin.harness && item.session_id === pin.session_id && item.run_id === pin.run_id;
          const nextItems = input.action === "remove"
            ? items.filter((item) => !matches(item))
            : items.some(matches) ? items : [...items, pin];
          return { ...(current ?? { ok: true }), items: nextItems };
        });
      }
      void queryClient.invalidateQueries({ queryKey: qk.usagePins() });
      void queryClient.invalidateQueries({ queryKey: qk.usageInspectionIndex() });
    },
  });
  const isPinned = (harness: string, sessionId: string, runId: string | null = null) =>
    query.data?.items?.some((item) => item.harness === harness && item.session_id === sessionId && item.run_id === runId) ?? false;
  return { ...query, mutate: mutation.mutate, mutation, isMutating: mutation.isPending, isPinned };
}
