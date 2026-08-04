import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

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
		queryKey: ["syncReport"],
		queryFn: async () =>
			(await invoke<SyncReportEnvelope | null>("sync_report")) ?? null,
	});
}
