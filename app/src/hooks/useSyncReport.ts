import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

/**
 * The `sync_report` read, lifted out of the hook so the missing-refs equip
 * guardrail can share it via `queryClient.fetchQuery({ queryFn: syncReportQueryFn })`
 * instead of holding a second `invoke("sync_report")` call site.
 */
export async function syncReportQueryFn(): Promise<SyncReportEnvelope | null> {
	return (await invoke<SyncReportEnvelope | null>("sync_report")) ?? null;
}

/**
 * Reads the last `hub sync` report + a freshly-computed fingerprint of the live
 * registry (the `sync_report` Tauri command does the hashing). Resolves to
 * `null` when no report exists yet — the honest "run sync" / `unknown` state.
 *
 * Invalidated alongside `["registry"]` by `useRunSync` (and the other sync
 * flows) so the freshness signal refreshes the moment a sync completes.
 */
export function useSyncReport() {
	return useQuery({
		queryKey: qk.syncReport(),
		queryFn: syncReportQueryFn,
	});
}
