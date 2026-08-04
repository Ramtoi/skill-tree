import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { normalizeCcusageScan } from "./normalizeUsage";
import type { LocalAgentUsageSnapshot, UsageScan } from "./usageTypes";

export type LocalAgentUsageCache = {
  scan: UsageScan | null;
  snapshot: LocalAgentUsageSnapshot | null;
  /** Provenance of the held scan. The Rust side redacts paths only in the bytes
   *  it writes to the on-disk cache, so a `"cache"`-sourced scan has redacted
   *  paths (nothing to reveal), while a `"live"` scan is full-fidelity for this
   *  session. `"none"` = no scan at all. */
  source: "cache" | "live" | "none";
};

export const localAgentUsageQueryKey = ["usage", "ccusage", "latest"] as const;

function normalizeCachedScan(scan: UsageScan | null, source: "cache" | "live"): LocalAgentUsageCache {
  return {
    scan,
    snapshot: scan ? normalizeCcusageScan(scan) : null,
    source: scan ? source : "none",
  };
}

async function loadLatestCcusage(): Promise<LocalAgentUsageCache> {
  const scan = await invoke<UsageScan | null>("usage_load_latest_ccusage");
  return normalizeCachedScan(scan, "cache");
}

async function scanCcusage(): Promise<LocalAgentUsageCache> {
  const scan = await invoke<UsageScan>("usage_scan_ccusage");
  return normalizeCachedScan(scan, "live");
}

export function useLocalAgentUsage() {
  const queryClient = useQueryClient();
  const latest = useQuery({
    queryKey: localAgentUsageQueryKey,
    queryFn: loadLatestCcusage,
    // The on-disk cache is redacted; a background refetch on window-focus would
    // silently flip provenance back to "cache" mid-session (contradicting the
    // user's "reveal for this session" intent), so pin these off — mirrors the
    // established pattern in useRemotes.ts / usePermissions.ts.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const scan = useMutation({
    mutationFn: scanCcusage,
    onSuccess: (data) => {
      queryClient.setQueryData(localAgentUsageQueryKey, data);
    },
  });

  return {
    latest,
    scan,
    snapshot: latest.data?.snapshot ?? null,
    cachedScan: latest.data?.scan ?? null,
    isScanning: scan.isPending,
    hasFullFidelityData: latest.data?.source === "live",
  };
}
