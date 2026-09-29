import { useCallback, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hubCmd } from "@/lib/hubCmd";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { parseCliJson } from "@/lib/skillPack";
import { trackProcess } from "@/lib/trackProcess";
import { normalizeCcusageScan, normalizeUsageHistory } from "./normalizeUsage";
import { canonicalHarness, sessionKey } from "./sessionIdentity";
import type { InspectionScope } from "./usageInspectionTypes";
import { applyNativeProjection, hasCompleteToolCount } from "./usageNative";
import { useUsageInspectionIndex } from "./useUsageInspection";
import type {
  LocalAgentUsageSnapshot,
  UsageClaudeStatsProbe,
  UsageDailyPoint,
  UsageHistoryPayload,
  UsageImportClaudeStatsResult,
  UsageScan,
} from "./usageTypes";

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

/** Process-card target id for a ccusage scan. */
export const USAGE_SCAN_TARGET = "usage:scan";

function identityKey(harness: unknown, value: string | undefined): string | undefined {
  return value ? sessionKey(harness, value) : undefined;
}
const unavailableScope = (): InspectionScope => ({ tokens: { input: null, output: null, cache_creation: null, cache_read: null, total: null, status: "unavailable" }, cost: { currency: "USD", value: null, status: "unavailable" }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" } });

export function expandInspectionIndexRows(rows: import("./usageInspectionTypes").InspectionIndexSession[]): import("./usageInspectionTypes").InspectionIndexSession[] {
  const expanded = [...rows];
  for (const root of rows) {
    for (const agent of root.agents ?? []) {
      const agentKey = identityKey(root.harness, agent.session_id);
      if (agentKey && expanded.some((row) => identityKey(row.harness, row.session_id) === agentKey && row.run_id === agent.run_id)) continue;
      expanded.push({
        ...root,
        session_id: agent.session_id,
        root_session_id: root.root_session_id,
        run_id: agent.run_id,
        pinned: false,
        summary_provenance: agent.summary_provenance !== undefined ? agent.summary_provenance : root.summary_provenance ?? null,
        capture_coverage: agent.capture_coverage !== undefined ? agent.capture_coverage : root.capture_coverage ?? null,
        native: agent.native,
        status: agent.status ?? "unavailable",
        scopes: agent.scopes ?? { own: unavailableScope(), children: unavailableScope(), subtree: unavailableScope() },
        agents: [],
        latest_pr: agent.latest_pr ?? null,
        prs: agent.prs ?? [],
        additional_pr_count: agent.additional_pr_count ?? 0,
      });
    }
  }
  return expanded;
}

function providerInspectionKey(harness: string, value: string | undefined): string | undefined {
  const direct = identityKey(harness, value);
  if (direct || canonicalHarness(harness) !== "claude-code" || !value) return direct;
  // ccusage may identify a Claude transcript by path. Decode that provider
  // representation without accepting paths as canonical Inspection IDs.
  const basename = value.replace(/\\/g, "/").split("/").pop();
  return identityKey(harness, basename);
}

export function joinInspectionIndex(snapshot: LocalAgentUsageSnapshot | null, rows: import("./usageInspectionTypes").InspectionIndexSession[] | undefined): LocalAgentUsageSnapshot | null {
  if (!snapshot || !rows) return snapshot;
  const expandedRows = expandInspectionIndexRows(rows);
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const row of expandedRows) {
    const key = identityKey(row.harness, row.session_id);
    if (key) byKey.set(key, row);
  }
  const sessions = snapshot.sessions.map((session) => {
    const inspection = [providerInspectionKey(session.harnessId, session.id), providerInspectionKey(session.harnessId, session.period)]
      .filter((key): key is string => Boolean(key)).map((key) => byKey.get(key)).find(Boolean);
    return inspection ? applyNativeProjection(session, inspection) : session;
  });
  const known = (key: "toolCalls" | "linesAdded" | "linesRemoved") => sessions.length > 0 && sessions.every((item) => item[key] !== undefined);
  const total = (key: "toolCalls" | "linesAdded" | "linesRemoved") => sessions.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const unknown = (key: "toolCalls" | "linesAdded" | "linesRemoved") => sessions.filter((item) => key === "toolCalls" ? !hasCompleteToolCount(item) : item[key] === undefined).length;
  const overview = { ...snapshot.overview };
  overview.toolCalls = total("toolCalls");
  overview.toolCallsKnown = unknown("toolCalls") === 0;
  overview.toolCallsUnknownSessions = unknown("toolCalls");
  overview.linesAdded = total("linesAdded");
  overview.linesAddedKnown = known("linesAdded");
  overview.linesRemoved = total("linesRemoved");
  overview.linesRemovedKnown = known("linesRemoved");
  const harnesses = snapshot.harnesses.map((harness) => {
    const members = sessions.filter((item) => (canonicalHarness(item.harnessId) ?? item.harnessId) === (canonicalHarness(harness.id) ?? harness.id));
    return { ...harness, toolCalls: members.reduce((sum, item) => sum + (item.toolCalls ?? 0), 0), toolCallsKnown: members.every(hasCompleteToolCount), toolCallsUnknownSessions: members.filter((item) => !hasCompleteToolCount(item)).length };
  });
  const projects = snapshot.projects.map((project) => {
    const members = sessions.filter((item) => (item.hubProject ?? item.project?.label ?? "unknown") === project.key);
    return { ...project, toolCalls: members.reduce((sum, item) => sum + (item.toolCalls ?? 0), 0), toolCallsKnown: members.every(hasCompleteToolCount), toolCallsUnknownSessions: members.filter((item) => !hasCompleteToolCount(item)).length };
  });
  return { ...snapshot, overview, harnesses, projects, sessions };
}

/** A live `ccusage` run over the local transcripts — seconds of real work on a
 *  busy machine, so it reports through the shared process banner.
 *  `onlinePricing` threads straight to the `usage_scan_ccusage` Rust
 *  parameter (Plan A Addendum A3): `undefined`/`false` keeps the scan
 *  `--offline` (the default everywhere except the Usage screen's own opt-in
 *  toggle); `true` fetches LiteLLM's public price list over the network. */
async function scanCcusage(onlinePricing?: boolean): Promise<LocalAgentUsageCache> {
  return trackProcess(
    {
      title: "Scanning agent usage",
      body: "running ccusage over local transcripts",
      kind: "local",
      target: USAGE_SCAN_TARGET,
    },
    async () => {
      const scan = await invoke<UsageScan>("usage_scan_ccusage", { onlinePricing });
      return normalizeCachedScan(scan, "live");
    },
    { successBody: "scan complete" },
  );
}

/** Loads the cached/live ccusage scan and exposes the scan mutation the
 *  Usage header and `useCaptureOnOpen` both drive.
 *
 *  Capture-on-open does NOT live here (review C4) — it used to, and every
 *  consumer of this hook (the NavPanel's Agents glance, `useProjectActivity`)
 *  got its own automatic scan as a side effect of just reading the cache.
 *  See `./useCaptureOnOpen.ts`, called only by the Usage screen.
 *
 *  `onlinePricing` (Plan A Addendum A3) is a hook PARAMETER, not a mutate()
 *  variable — every existing `.mutate()` call site (this file's other
 *  consumers included) keeps calling it with no arguments; only the Usage
 *  screen itself, which holds the toggle's current value, passes one. */
export function useLocalAgentUsage(options?: { onlinePricing?: boolean; includeInspection?: boolean }) {
  const onlinePricing = options?.onlinePricing;
  const queryClient = useQueryClient();
  const inspectionIndex = useUsageInspectionIndex(options?.includeInspection ?? false);
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
    mutationFn: () => scanCcusage(onlinePricing),
    onSuccess: (data) => {
      queryClient.setQueryData(localAgentUsageQueryKey, data);
      // A successful scan is what GROWS the durable ledger (the Rust side
      // runs `hub usage record --from-cache` right after the cache write —
      // see `docs/USAGE.md`), and every range-scoped card on the Usage
      // screen reads that ledger whenever it holds anything. Without this,
      // The header scan visibly does nothing: the chart, the KPI cost/token
      // tiles, the composition bar, Top Models and the harness breakdown all
      // kept showing the PRE-scan history until the screen remounted
      // (review C2).
      void queryClient.invalidateQueries({ queryKey: qk.usageHistory() });
      void queryClient.invalidateQueries({ queryKey: qk.usageInspectionIndex() });
      void queryClient.invalidateQueries({ queryKey: qk.usageInspectionRoot() });
      void queryClient.invalidateQueries({ queryKey: qk.usagePins() });
      // REVIEW-W1 #2: `usage_pricing_info`'s `offline` field names the LAST
      // scan's own mode — a scan that just ran with `onlinePricing: true`
      // makes the Prices popover's stale-forever (`staleTime: Infinity`)
      // cached read wrong the moment it reopens, since nothing else ever
      // invalidates it.
      void queryClient.invalidateQueries({ queryKey: qk.usagePricingInfo() });
    },
  });

  // Synchronous in-flight guard shared by EVERY scan control (header Refresh,
  // the breakdown's Scan, the empty/error states' retries, capture-on-open).
  // `scan.isPending` only flips after React commits, so two clicks inside one
  // frame — or two controls fired before the rerender — would each create a
  // TanStack mutation, a process card and a ccusage run (review A, medium).
  // The ref closes that window; the Rust mutex only serialises, never dedupes.
  const scanInFlight = useRef(false);
  const runScan = useCallback(async (): Promise<void> => {
    if (scanInFlight.current || scan.isPending) return;
    scanInFlight.current = true;
    try {
      await scan.mutateAsync();
    } catch {
      // The error state and process card carry the failure; callers only need
      // to know that this scan has settled before starting the next step.
    } finally {
      scanInFlight.current = false;
    }
    // `scan` changes identity on every status transition; the two members read
    // here (`isPending`, `mutate`) are what the guard depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.isPending, scan.mutate]);

  const indexedSnapshot = useMemo(() => {
    return joinInspectionIndex(latest.data?.snapshot ?? null, inspectionIndex.data?.sessions);
  }, [latest.data?.snapshot, inspectionIndex.data?.sessions]);

  return {
    latest,
    scan,
    /** The one way to start a scan from UI: ignores a second call while one
     *  is in flight. Call sites never reach for `scan.mutate` directly. */
    runScan,
    snapshot: indexedSnapshot,
    inspectionIndex: inspectionIndex.data,
    cachedScan: latest.data?.scan ?? null,
    isScanning: scan.isPending,
    hasFullFidelityData: latest.data?.source === "live",
    // Only ever meaningful right after a LIVE scan — `redact_scan_for_cache`
    // always strips it back to `null` before the scan reaches the on-disk
    // cache, so the cached-load path never carries one.
    ledgerNote: scan.data?.scan?.ledger_note ?? null,
  };
}

/** Process-card target id for the one-click Claude Code stats-cache import. */
export const USAGE_IMPORT_TARGET = "usage:import";

/** The durable usage ledger (`hub usage history --json`) and the one-time
 *  stats-cache import that backfills it — independent of the ccusage
 *  scan/cache above, but read alongside it: every range-scoped token/cost
 *  aggregate on the Usage screen reads this query's `daily` (falling back to
 *  the scan's own `daily` when the ledger holds nothing yet), while
 *  session-derived cards keep reading the scan. */
export function useUsageHistory() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.usageHistory(),
    queryFn: async (): Promise<UsageHistoryPayload> => {
      const result = await hubCmd(["usage", "history", "--json"]);
      return parseCliJson<UsageHistoryPayload>(result.output);
    },
    // Mirrors the cached-scan query above: nothing here changes on its own
    // between visits, so a background window-focus refetch would only add
    // an unexplained loading flicker.
    refetchOnWindowFocus: false,
  });

  const importClaudeStats = useMutation({
    mutationFn: (): Promise<UsageImportClaudeStatsResult> =>
      trackProcess(
        {
          title: "Importing Claude Code's own stats",
          body: "reading stats-cache.json",
          kind: "local",
          target: USAGE_IMPORT_TARGET,
        },
        async () => {
          const result = await hubCmd(["usage", "import-claude-stats", "--json"]);
          const parsed = parseCliJson<UsageImportClaudeStatsResult & { ok?: boolean; error?: string }>(
            result.output,
          );
          // `hub_cli/usage.py`'s failure path (`_usage_fail`) prints
          // `{"ok": false, "error": …}` to stdout and exits non-zero — a
          // shape `parseCliJson` parses without complaint, so `result.success`
          // alone must not be trusted blind, and neither must the parsed
          // JSON alone (review C3): fail on EITHER signal so a missing or
          // unreadable stats cache never reports "imported 0 days" as a
          // success.
          if (!result.success || parsed.ok === false) {
            throw new Error(parsed.error ?? "hub usage import-claude-stats failed");
          }
          return parsed;
        },
        {
          successBody: (result) => {
            const n = result.inserted ?? 0;
            const base = `imported ${n} ${n === 1 ? "day" : "days"}`;
            const warningCount = result.warnings?.length ?? 0;
            return warningCount > 0
              ? `${base}, ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`
              : base;
          },
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.usageHistory() });
    },
  });

  const daily: UsageDailyPoint[] = useMemo(
    () => (query.data ? normalizeUsageHistory(query.data) : []),
    [query.data],
  );

  const claudeStats: UsageClaudeStatsProbe | null = query.data?.claude_stats ?? null;

  return {
    query,
    daily,
    claudeStats,
    importClaudeStats,
  };
}
