import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { runHubCmd } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { parseCliJson } from "@/lib/skillPack";
import type {
  UsageFindingsPayload,
  UsageFootprintPayload,
  UsageProjectPayload,
  UsageLoadoutsPayload,
  UsageScanResult,
  UsageSessionPayload,
  UsageWindow,
  UsageTimelinePayload,
} from "@/features/usage/usageAnalyticsTypes";
import { ccusageToHubHarness } from "@/screens/usage/harnessIdentity";
import { rangeBounds, windowBounds } from "@/screens/usage/usageAggregate";
import type { UsageRange } from "@/screens/usage/useUsagePrefs";

export type UsageTimelineRange = UsageRange | { since: string; until: string };
export const TIMELINE_HARNESSES: readonly string[] = ["claude-code", "codex"];

function timelineBounds(range: UsageTimelineRange): { since: string | null; until: string | null } {
  return typeof range === "string" ? rangeBounds(range) : range;
}

export function useUsageTimeline(
  range: UsageTimelineRange,
  harness: string | null,
  enabled = true,
): Omit<UseQueryResult<UsageTimelinePayload>, "status"> & { status: UseQueryResult<UsageTimelinePayload>["status"] | "unsupported" } {
  const bounds = timelineBounds(range);
  const hubHarness = harness === null ? null : ccusageToHubHarness(harness);
  const unsupported = harness !== null && !TIMELINE_HARNESSES.includes(hubHarness ?? "");
  const query = useQuery({
    queryKey: qk.usageTimeline(bounds.since, bounds.until, harness),
    enabled: enabled && !unsupported,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<UsageTimelinePayload> => {
      const args = ["usage", "timeline", "--json"];
      if (bounds.since) args.push("--since", bounds.since);
      if (bounds.until) args.push("--until", bounds.until);
      if (hubHarness) args.push("--harness", hubHarness);
      const result = await runHubCmd(args);
      return parseCliJson<UsageTimelinePayload>(result.output);
    },
  });
  return unsupported ? { ...query, status: "unsupported" } : query;
}

export function useUsageProjectTimeline(
  window: 7 | 30 | 90,
  harness: string | null,
  project: string,
): Omit<UseQueryResult<UsageTimelinePayload>, "status"> & { status: UseQueryResult<UsageTimelinePayload>["status"] | "unsupported" } {
  const bounds = windowBounds(window);
  const unsupported = harness !== null && !TIMELINE_HARNESSES.includes(harness);
  const query = useQuery({
    queryKey: qk.usageProjectTimeline(project, bounds.since, bounds.until, harness),
    enabled: !unsupported,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<UsageTimelinePayload> => {
      const args = ["usage", "timeline", "--json", "--project", project, "--since", bounds.since, "--until", bounds.until];
      if (harness) args.push("--harness", harness);
      const result = await runHubCmd(args);
      return parseCliJson<UsageTimelinePayload>(result.output);
    },
  });
  return unsupported ? { ...query, status: "unsupported" } : query;
}

/**
 * The only place the frontend reads a `hub usage <verb>` ANALYTICS payload
 * (design D14.2) — distinct from the durable-ledger/ccusage reads in
 * `features/usage/useLocalAgentUsage.ts`. Every read goes through `hubCmd`/
 * `runHubCmd` (the one place the frontend spawns `hub_cmd`) and
 * `parseCliJson`, never `JSON.parse` (a `hub` payload is followed by
 * auto-sync chatter). `runHubCmd` — not the throw-nothing `hubCmd` — is used
 * deliberately: these commands always exit 0 and carry their verdict in the
 * payload, so an `{"ok": false, "reason": …}` response is rendered state,
 * never a query error; only a genuinely broken install (a non-zero exit)
 * throws `HubCommandError` and reaches `isError`.
 */

/** Mutation key for `hub usage scan-sessions --json`. Shared so every
 *  rendered `ScanButton` observes ONE mutation via `useMutationState`
 *  (design D14.5, G5) — defined here, re-exported by
 *  `screens/usage/UsageScanAction.tsx`, which is the file every OTHER
 *  consumer actually imports it from. */
export const SCAN_MUTATION_KEY = ["usage", "scan-sessions"] as const;

/** `hub usage project <name> --window <window> --json` (design D14.6). */
export function useUsageProject(
  name: string,
  window: UsageWindow,
): UseQueryResult<UsageProjectPayload> {
  return useQuery({
    queryKey: qk.usageProject(name, window),
    staleTime: 30_000,
    queryFn: async (): Promise<UsageProjectPayload> => {
      const result = await runHubCmd(["usage", "project", name, "--window", String(window), "--json"]);
      return parseCliJson<UsageProjectPayload>(result.output);
    },
  });
}

/** `hub usage session <id> [--harness <harness>] --json` (design D14.7).
 *  `harness` is normalized to `harness ?? null` at this boundary (G17) so
 *  one read is one cache entry — without it, `undefined` and `null` would
 *  produce two cache entries for what is really one read. */
export function useUsageSession(
  id: string,
  harness?: string,
): UseQueryResult<UsageSessionPayload> {
  const normalizedHarness = harness ?? null;
  return useQuery({
    queryKey: qk.usageSession(id, normalizedHarness),
    queryFn: async (): Promise<UsageSessionPayload> => {
      const args = ["usage", "session", id];
      if (normalizedHarness) args.push("--harness", normalizedHarness);
      args.push("--json");
      const result = await runHubCmd(args);
      return parseCliJson<UsageSessionPayload>(result.output);
    },
  });
}

/** `hub usage footprint <name> --json` — wave 3's footprint drill-down. */
export function useUsageFootprint(name: string): UseQueryResult<UsageFootprintPayload> {
  return useQuery({
    queryKey: qk.usageFootprint(name),
    staleTime: 30_000,
    queryFn: () => fetchUsageFootprint(name),
  });
}

export async function fetchUsageFootprint(name: string): Promise<UsageFootprintPayload> {
  const result = await runHubCmd(["usage", "footprint", name, "--json"]);
  return parseCliJson<UsageFootprintPayload>(result.output);
}

/** `hub usage findings [--project <project>] --json`. Also the cheapest
 *  global read of `last_scan_at` (no project required) — the Overview uses
 *  it to suppress a `Timeline` action before the first scan (design D14.2,
 *  G7). `project` is normalized the same way `harness` is above. */
export function useUsageFindings(project?: string): UseQueryResult<UsageFindingsPayload> {
  const normalizedProject = project ?? null;
  return useQuery({
    queryKey: qk.usageFindings(normalizedProject),
    queryFn: async (): Promise<UsageFindingsPayload> => {
      const args = ["usage", "findings"];
      if (normalizedProject) args.push("--project", normalizedProject);
      args.push("--json");
      const result = await runHubCmd(args);
      return parseCliJson<UsageFindingsPayload>(result.output);
    },
  });
}

/** `hub usage loadouts <project> --json` — projected, redacted history. */
export function useUsageLoadouts(project: string): UseQueryResult<UsageLoadoutsPayload> {
  return useQuery({
    queryKey: qk.usageLoadouts(project),
    queryFn: async (): Promise<UsageLoadoutsPayload> => {
      const result = await runHubCmd(["usage", "loadouts", project, "--json"]);
      return parseCliJson<UsageLoadoutsPayload>(result.output);
    },
  });
}

/** `hub usage scan-sessions --json` — the transcript-scan mutation (design
 *  D14.5). `mutationKey: SCAN_MUTATION_KEY` identifies this shared action;
 *  its latest settled payload is written to the bounded recovery query key.
 *  `onSuccess` invalidates only the `usage` family prefix
 *  (`qk.usageAnalytics()`) — never `invalidateRegistry()`, because the scan
 *  writes no registry and no sync report. */
export function useScanSessions(): UseMutationResult<UsageScanResult, unknown, void> {
  const queryClient = useQueryClient();
  const recoveryKey = qk.usageScanRecovery();
  // Keep one bounded latest-result entry alive even while every route has
  // unmounted. This is deliberately a query cache entry rather than mutation
  // history, so repeated scans overwrite one payload instead of accumulating.
  queryClient.setQueryDefaults(recoveryKey, { gcTime: Infinity });
  return useMutation({
    mutationKey: SCAN_MUTATION_KEY,
    mutationFn: async (): Promise<UsageScanResult> => {
      const result = await runHubCmd(["usage", "scan-sessions", "--json"]);
      return parseCliJson<UsageScanResult>(result.output);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(recoveryKey, result);
      queryClient.invalidateQueries({ queryKey: qk.usageAnalytics() });
    },
  });
}
