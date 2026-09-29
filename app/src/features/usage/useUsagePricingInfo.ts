import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { UsagePricingInfo } from "./usageTypes";

/**
 * The price-transparency source (docs/changes/DESIGN-usage-numbers/PLAN.md §R4): which
 * ccusage ran, whether the last scan fetched a live price list or stayed
 * offline, and any local `ccusage-pricing.json` overrides. Cached forever
 * once fetched (`staleTime: Infinity`) — a completed scan invalidates it
 * explicitly (`useLocalAgentUsage.ts`'s `scan.onSuccess`, REVIEW-W1 #2), so
 * there is no reason to refetch on a window focus or a re-render on its own.
 *
 * `enabled` (REVIEW-W1 #7) defaults to `true` but the Prices popover passes
 * `open`: `usage_pricing_info` shells a `ccusage --version` probe (a 2s
 * timeout) on the Rust side, so an always-on query would fire that probe on
 * every Usage-screen mount whether or not anybody ever opens the popover.
 */
export function useUsagePricingInfo(enabled = true) {
  return useQuery({
    queryKey: qk.usagePricingInfo(),
    queryFn: () => invoke<UsagePricingInfo>("usage_pricing_info"),
    staleTime: Infinity,
    enabled,
  });
}
