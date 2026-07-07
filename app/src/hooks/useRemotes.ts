import { useMutation, useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type {
	HubResult,
	RemoteDiffPlan,
	RemoteDocsList,
	RemoteImportScan,
	RemoteListEntry,
	RemoteShow,
} from "@/types";
import { invalidateRemotes } from "@/screens/RemotesScreen";

/** All registered remotes (`hub remote list --json`). */
export function useRemotes() {
	return useQuery({
		queryKey: ["remotes"],
		queryFn: () => invoke<RemoteListEntry[]>("remote_list"),
	});
}

/** One remote's config + resolved skills (`hub remote show --json`). */
export function useRemoteShow(id: string | undefined) {
	return useQuery({
		queryKey: ["remote", id, "show"],
		queryFn: () => invoke<RemoteShow>("remote_show", { id }),
		enabled: !!id,
	});
}

/** Read-only drift plan / health shape (`hub remote diff --json`). Lower
 *  staleness because it does real (read-only) remote work; the UI refetches it
 *  explicitly after a resolve/sync. */
export function useRemoteDiff(id: string | undefined, enabled = true) {
	return useQuery({
		queryKey: ["remote", id, "diff"],
		queryFn: () => invoke<RemoteDiffPlan>("remote_diff", { id }),
		enabled: !!id && enabled,
		retry: false,
		staleTime: 10_000,
	});
}

/** Live remote agent docs (`hub remote list-docs <id> --json`) — present on the
 *  box independent of any pending diff plan, so the editor can fetch→edit→push
 *  even when nothing is queued. Network-touching → off-thread; refetch after a
 *  push to refresh present/sha. */
export function useRemoteDocs(id: string | undefined, enabled = true) {
	return useQuery({
		queryKey: ["remote", id, "docs"],
		queryFn: () => invoke<RemoteDocsList>("remote_list_docs", { id }),
		enabled: !!id && enabled,
		retry: false,
		staleTime: 10_000,
	});
}

/** Lazy per-remote health probe (`hub remote health <id> --json`). Off-thread,
 *  opt-in (`enabled`): a card fires it only when it renders so opening the list
 *  stays instant. Returns `{reachable, authenticated, host_key_match, ok, detail}`.
 *  Eager list-level health (a batched probe in `remote_list`) is DEFERRED — it
 *  would be the change's only backend addition, excluded by the mandate. */
export interface RemoteHealthResult {
	ok?: boolean;
	reachable?: boolean;
	authenticated?: boolean;
	host_key_match?: boolean;
	detail?: string;
}

/** A live SSH probe is expensive; hold the result this long before re-probing. */
const REMOTE_HEALTH_STALE_MS = 30_000;

export function useRemoteHealth(id: string | undefined, enabled = true) {
	return useQuery({
		queryKey: ["remote", id, "health"],
		queryFn: () => invoke<RemoteHealthResult>("remote_health", { id }),
		enabled: !!id && enabled,
		retry: false,
		staleTime: REMOTE_HEALTH_STALE_MS,
	});
}

/** Box-native import candidates (`hub remote import-skill --scan --json`).
 *  LAZY by default (`enabled=false`): opening a remote is instant; the scan
 *  (one SSH `find` call) runs on demand when the user clicks "Scan for
 *  importable skills". */
export function useRemoteImportScan(id: string | undefined, enabled = false) {
	return useQuery({
		queryKey: ["remote", id, "scan"],
		queryFn: () => invoke<RemoteImportScan>("remote_scan_imports", { id }),
		enabled: !!id && enabled,
		retry: false,
		staleTime: 10_000,
	});
}

/** Toggle a remote's `apply_global_bundles` flag (D15): opt in/out of inheriting
 *  global-scope bundle skills. Default off — the remote's own bundles+enabled
 *  always apply. Invalidates `["registry"]` + `["remotes"]` + the remote's
 *  queries (via `invalidateRemotes`) so the EQUIPPED list refetches. */
export function useRemoteSetApplyGlobal(id: string) {
	return useMutation({
		mutationFn: (enabled: boolean) =>
			invoke<HubResult>("remote_set_apply_global", { id, enabled }),
		onSuccess: () => invalidateRemotes(id),
	});
}
