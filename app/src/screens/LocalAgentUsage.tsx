import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { InfoBanner } from "@/components/InfoBanner";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { normalizeCcusageScan } from "@/features/usage/normalizeUsage";
import { useCaptureOnOpen } from "@/features/usage/useCaptureOnOpen";
import { joinInspectionIndex, useLocalAgentUsage, useUsageHistory } from "@/features/usage/useLocalAgentUsage";
import type { LocalAgentUsageSnapshot } from "@/features/usage/usageTypes";
import { useUsageFindings, useUsageTimeline } from "@/hooks/useUsageAnalytics";
import { useRegistry } from "@/hooks/useRegistry";
import { fromNav, usageBackTarget } from "@/lib/backTarget";
import { UsageCompositionCard, UsageModelsCard } from "./usage/UsageCompositionAndModels";
import { UsageControls } from "./usage/UsageControls";
import { ScanButton, useRunTranscriptScan, useScanBusy } from "./usage/UsageScanAction";
import { UsageScanRecovery } from "./usage/UsageScanRecovery";
import { buildDiagnostic, classifyError, copyDiagnosticToClipboard } from "./usage/usageDiagnostics";
import { UsageHarnessBreakdown } from "./usage/UsageHarnessBreakdown";
import { UsageKpiRow } from "./usage/UsageKpiRow";
import { unpricedModelNames } from "./usage/pricing";
import { UsageProjectsCard } from "./usage/UsageProjectsCard";
import { UsageProjectPicker } from "./usage/UsageProjectPicker";
import { UsagePermissionPresets } from "./usage/UsagePermissionPresets";
import { UsageSessionsCard } from "./usage/UsageSessionsCard";
import { UsageSpendChart } from "./usage/UsageSpendChart";
import { UsageActivityHeatmap } from "./usage/UsageActivityHeatmap";
import { UsagePeriodModal } from "./usage/UsagePeriodModal";
import { heatmapCells } from "./usage/usageHeatmap";
import { useUsagePeriodSelection } from "./usage/useUsagePeriodSelection";
import { isUsageDayKey } from "./usage/usagePeriod";
import {
  UsageErrorState,
  UsageFirstRunEmpty,
  UsageLoadingState,
  UsageNoUsageState,
} from "./usage/UsageStates";
import {
  filterSessionsByHarness,
  filterSessionsByRange,
  rangeScopedDaily,
  recomputeScopedUsage,
  scopeFromDaily,
  type HarnessTotal,
  type ScopedUsage,
} from "./usage/usageAggregate";
import { formatScannedAt, usageRunsLocallyLabel } from "./usage/usageFormat";
import { useUsagePrefs } from "./usage/useUsagePrefs";
import { UsageOverTimeBand } from "./usage/UsageOverTimeBand";
import { defaultBucketFor, type ChartBucket } from "./usage/usageChartColumns";

function isZeroUsage(snapshot: LocalAgentUsageSnapshot): boolean {
  return (
    snapshot.overview.totalTokens === 0 &&
    snapshot.overview.sessions === 0 &&
    snapshot.overview.harnessesDetected === 0
  );
}

export function LocalAgentUsage() {
  const navigate = useNavigate();
  const prefs = useUsagePrefs();
  const usage = useLocalAgentUsage({ onlinePricing: prefs.onlinePricing, includeInspection: true });
  const history = useUsageHistory();
  const [showFullPaths, setShowFullPaths] = useState(false);
  const { selectedPeriod, setSelectedPeriod, selectPeriodKey, inspectPeriodSession } = useUsagePeriodSelection();

  // The registered hub project keys — a Projects-card row links only when
  // its `hubProject` names one of these (design D14.8, G3). Read here (the
  // screen did not call `useRegistry()` before this wave) rather than in
  // the card itself, so the card stays a plain presentational component.
  const registry = useRegistry();
  const projectKeys = useMemo(
    () => new Set(Object.keys(registry.data?.projects ?? {})),
    [registry.data],
  );

  // The cheapest global read of `last_scan_at` (no project required) — the
  // Sessions card suppresses every `Timeline` action until the transcript
  // ledger has been scanned at least once (design D14.2/D14.8, G7).
  const findings = useUsageFindings();
  const scanned = Boolean(findings.data?.last_scan_at);

  const onOpenProject = (hubProject: string) => {
    navigate(
      `/usage/project/${encodeURIComponent(hubProject)}`,
      fromNav(usageBackTarget()),
    );
  };
  const onOpenTimeline = (sessionId: string, harness: string) => {
    navigate(
      `/usage/session/${encodeURIComponent(sessionId)}?harness=${encodeURIComponent(harness)}`,
      fromNav(usageBackTarget()),
    );
  };

  // Capture-on-open lives here, and ONLY here — see `useCaptureOnOpen.ts`
  // (review C4). The NavPanel's Agents glance and `useProjectActivity` read
  // `useLocalAgentUsage()` too, but neither calls this — reading the cache
  // must never start a scan as a side effect.
  useCaptureOnOpen(usage);

  // Full paths can only be revealed from a full-fidelity live scan — the
  // on-disk cache is path-redacted, so a stale `showFullPaths=true` must
  // degrade to the anonymized label instead of surfacing a redaction hash.
  const effectiveShowFullPaths = showFullPaths && usage.hasFullFidelityData;

  const snapshot = useMemo(() => {
    if (usage.cachedScan) {
      return joinInspectionIndex(normalizeCcusageScan(usage.cachedScan, { includeFullPaths: effectiveShowFullPaths }), usage.inspectionIndex?.sessions);
    }
    return usage.snapshot;
  }, [usage.cachedScan, usage.snapshot, usage.inspectionIndex?.sessions, effectiveShowFullPaths]);

  const error = usage.scan.error ?? usage.latest.error;
  const loading = usage.latest.isLoading;
  const transcriptBusy = useScanBusy();
  const busy = usage.isScanning || transcriptBusy;
  const runTranscriptScan = useRunTranscriptScan();
  const allScanInFlight = useRef(false);
  const runAllScans = useCallback(async () => {
    if (allScanInFlight.current || usage.isScanning || transcriptBusy) return;
    allScanInFlight.current = true;
    try {
      await usage.runScan();
      await runTranscriptScan();
    } finally {
      allScanInFlight.current = false;
    }
  }, [runTranscriptScan, transcriptBusy, usage]);
  const hasError = Boolean(error);
  const zeroUsage = snapshot ? isZeroUsage(snapshot) : false;

  // W1: a populated durable ledger must not be hidden behind a zero-usage or
  // absent ccusage scan — the exact case the ledger exists for (transcripts
  // pruned, ccusage finds nothing this run, but the history has months of
  // recorded days). `history.daily` is read BEFORE any range/harness filter
  // here — "does the ledger hold anything at all", not "does the current
  // range".
  const hasHistory = history.daily.length > 0;
  const showDashboard = hasHistory || (snapshot !== null && !zeroUsage);

  // The harness filter's own option list — every harness ccusage has ever
  // seen usage from, range-independent so picking a harness never changes
  // what the group itself offers.
  const detectedHarnesses = useMemo(
    () => (snapshot ? snapshot.harnesses.filter((h) => h.status === "detected") : []),
    [snapshot],
  );
  // A stored/picked id the current snapshot no longer detects (a stale
  // localStorage value, a harness that dropped out between scans) degrades
  // to "all" rather than hiding every session on the screen.
  const harnessFilter = useMemo(() => {
    if (prefs.harness === null) return null;
    return detectedHarnesses.some((h) => h.id === prefs.harness) ? prefs.harness : null;
  }, [prefs.harness, detectedHarnesses]);
  const timeline = useUsageTimeline(prefs.range, harnessFilter);

  // The one range-scoped daily source: the durable ledger's own points when
  // it holds anything, else the scan's — handed to BOTH the spend chart and
  // `scopeFromDaily` below, so the chart's column sum and the KPI total can
  // never read two different numbers for the same range.
  const filteredDaily = useMemo(
    () => rangeScopedDaily(history.daily, snapshot?.daily ?? [], prefs.range, harnessFilter),
    [history.daily, snapshot, prefs.range, harnessFilter],
  );
  const effectiveBucket: ChartBucket = prefs.bucket ?? (prefs.range === "7d" || prefs.range === "30d" ? "day"
    : prefs.range === "90d" || prefs.range === "1y" ? "week" : defaultBucketFor([...filteredDaily, ...(timeline.data?.days ?? [])]));
  const filteredSessions = useMemo(() => {
    const byRange = snapshot ? filterSessionsByRange(snapshot.sessions, prefs.range) : [];
    return filterSessionsByHarness(byRange, harnessFilter);
  }, [snapshot, prefs.range, harnessFilter]);
  const heatmapDaily = useMemo(
    () => rangeScopedDaily(history.daily, snapshot?.daily ?? [], "all", harnessFilter),
    [history.daily, snapshot, harnessFilter],
  );
  const heatmapWindowEnd = useMemo(() => {
    const generated = history.query.data?.generated_at?.slice(0, 10) ?? "1970-01-01";
    const last = heatmapDaily
      .map((point) => point.date.slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort()
      .pop() ?? "1970-01-01";
    return generated > last ? generated : last;
  }, [history.query.data?.generated_at, heatmapDaily]);
  const daySessions = useMemo(() => filterSessionsByHarness(snapshot?.sessions ?? [], harnessFilter), [snapshot, harnessFilter]);
  const dayBounds = useMemo(() => {
    const cells = heatmapCells([], heatmapWindowEnd, "daily");
    const dates = [...cells.map((cell) => cell.date), ...heatmapDaily.map((point) => point.date.slice(0, 10)), ...(timeline.data?.days.map((point) => point.date) ?? [])]
      .filter(isUsageDayKey).sort();
    return { first: dates[0], last: dates[dates.length - 1] };
  }, [heatmapDaily, heatmapWindowEnd, timeline.data]);

  // Two independent aggregates over the SAME `filteredDaily` (see above) and
  // `filteredSessions` — `docs/USAGE.md` explains why the split is
  // permanent: tokens/cost cover every recorded day, sessions/projects/tool
  // calls cover only what the transcripts still hold.
  const coverageScope = useMemo(() => scopeFromDaily(filteredDaily), [filteredDaily]);
  const sessionScope = useMemo(() => recomputeScopedUsage(filteredSessions), [filteredSessions]);

  const scoped = useMemo<ScopedUsage | null>(() => {
    // Kept alive by EITHER source (W1): a never-scanned machine whose ledger
    // was seeded purely by `hub usage import-claude-stats` has `snapshot ===
    // null` but real history to show.
    if (!snapshot && !hasHistory) return null;
    const sessionByHarness = new Map(sessionScope.harnesses.map((h) => [h.id, h]));
    const harnesses: HarnessTotal[] = coverageScope.harnesses.map((h) => {
      const sessionHarness = sessionByHarness.get(h.id);
      return {
        id: h.id,
        name: h.name,
        tokens: h.tokens,
        costUsd: h.costUsd,
        sessions: sessionHarness?.sessions ?? 0,
        toolCalls: sessionHarness?.toolCalls ?? 0,
        toolCallsKnown: sessionHarness?.toolCallsKnown,
        toolCallsUnknownSessions: sessionHarness?.toolCallsUnknownSessions,
        topModel: sessionHarness?.topModel,
        costPartial: h.costPartial,
      };
    });
    return {
      tokens: coverageScope.tokens,
      costUsd: coverageScope.costUsd,
      sessions: sessionScope.sessions,
      toolCalls: sessionScope.toolCalls,
      toolCallsKnown: sessionScope.toolCallsKnown,
      toolCallsUnknownSessions: sessionScope.toolCallsUnknownSessions,
      cacheHitRate: coverageScope.cacheHitRate,
      harnesses,
      models: coverageScope.models,
      projects: sessionScope.projects,
    };
  }, [snapshot, hasHistory, coverageScope, sessionScope]);

  const noUsageHarnessNames = useMemo(
    () => (snapshot ? snapshot.harnesses.filter((h) => h.status === "no_usage").map((h) => h.name) : []),
    [snapshot],
  );

  // Computed once here (not inside `UsageKpiRow`, which has no model list of
  // its own) and reused wherever the cost tile needs to know it's covering
  // an unpriced model.
  const unpricedModels = useMemo(() => (scoped ? unpricedModelNames(scoped.models) : []), [scoped]);

  const diagnostic = hasError ? buildDiagnostic(error) : "";

  const claudeStats = history.claudeStats;
  const showImportCta = Boolean(claudeStats?.available && claudeStats.importable_days > 0);
  // W1: reused in the zero-usage/first-run empty states too, not only the
  // dashboard — the machine that most needs the stats-cache import is
  // exactly the one ccusage currently reports nothing for.
  const importCtaBanner =
    showImportCta && claudeStats ? (
      <InfoBanner icon="info" className="usage-import-banner">
        <span className="usage-import-banner-text">
          Claude Code's own stats cover {claudeStats.importable_days}{" "}
          {claudeStats.importable_days === 1 ? "day" : "days"} this scan can't reach anymore —
          tokens only, no cost, marked as backfilled.
        </span>
        <Button
          variant="soft"
          busy={history.importClaudeStats.isPending}
          onClick={() => history.importClaudeStats.mutate()}
        >
          Import {claudeStats.importable_days} {claudeStats.importable_days === 1 ? "day" : "days"} from
          Claude Code's own stats
        </Button>
      </InfoBanner>
    ) : null;

  // W6: the durable ledger degrading silently is worse than a scan-only
  // fallback the user never learns about. `historyWarnings` are `read_rows`
  // drop warnings for a malformed ledger LINE — distinct from the query
  // simply failing, but surfaced through the same banner.
  const historyWarnings = history.query.data?.warnings ?? [];
  const showHistoryUnavailableBanner = history.query.isError || historyWarnings.length > 0;

  return (
    <>
      <ScreenHeader
        icon="usage"
        title="Usage"
        state={
          <StatusBadge channel="info" icon="shield">
            {usageRunsLocallyLabel(prefs.onlinePricing)}
          </StatusBadge>
        }
        subline={`Local token and cost estimates across your coding harnesses · ${
          snapshot ? `last scan ${formatScannedAt(snapshot.scannedAt)}` : "no cached scan yet"
        }`}
        primary={
          <ScanButton
            variant="primary"
            onRun={runAllScans}
            busy={busy}
            title="Reads ccusage totals, then new transcript bytes"
          >
            {snapshot ? "Scan" : "Scan local usage"}
          </ScanButton>
        }
        // Keep navigation available in every loading/error/dashboard state.
        // The primary Scan action already runs the ccusage refresh followed
        // by the transcript scan; Usage D intentionally exposes one scan
        // workflow from the Usage header.
        secondary={
          <span className="usage-header-actions">
            <UsagePermissionPresets />
            <UsageProjectPicker
              projects={scoped?.projects ?? []}
              projectKeys={projectKeys}
              range={prefs.range}
              harness={harnessFilter}
              harnessName={detectedHarnesses.find((item) => item.id === harnessFilter)?.name}
              currency={prefs.currency}
              eurRate={prefs.eurRate}
            />
            <Button variant="ghost" icon="pin" title="Pinned sessions" onClick={() => navigate("/usage/pinned", fromNav(usageBackTarget()))} />
          </span>
        }
      />
      <div className="main-body">
        <section className="screen-pad usage-shell" aria-label="Local agent usage">
          <UsageScanRecovery headerBusy={busy} />
          {loading && <UsageLoadingState />}

          {/* Full-screen error only when there is NO prior good snapshot to
              fall back to AND the durable ledger holds nothing either — a
              populated dashboard (from a snapshot OR from history alone) is
              surfaced non-destructively via the inline banner below /
              inside the dashboard instead. */}
          {!loading && hasError && !snapshot && !hasHistory && (
            <UsageErrorState
              kind={classifyError(error)}
              diagnostic={diagnostic}
              onRetry={usage.runScan}
              onCopyDiagnostic={copyDiagnosticToClipboard}
            />
          )}

          {/* Covers BOTH the pre-existing "refresh over a good snapshot
              failed" case and the case a scan has NEVER succeeded but the
              durable ledger still has days (W1 fallout: without this, a
              scan failure that leaves a populated ledger rendered the full
              dashboard with no indication anything had failed at all). */}
          {!loading && hasError && showDashboard && (
            <InfoBanner icon="warning" className="usage-refresh-banner">
              Refresh failed — showing {snapshot ? "the last successful scan" : "your recorded usage history"}.{" "}
              <span className="usage-refresh-banner-actions">
                <Button variant="ghost" icon="rescan" busy={busy} onClick={usage.runScan}>
                  Retry
                </Button>
                <Button variant="ghost" onClick={() => copyDiagnosticToClipboard(diagnostic)}>
                  Copy diagnostic
                </Button>
              </span>
            </InfoBanner>
          )}

          {!loading && !hasError && !snapshot && !hasHistory && (
            <>
              {importCtaBanner}
              <UsageFirstRunEmpty busy={busy} onScan={runAllScans} />
            </>
          )}

          {!loading && !showDashboard && snapshot && zeroUsage && (
            <>
              {importCtaBanner}
              <UsageNoUsageState busy={busy} onRetry={usage.runScan} />
            </>
          )}

          {!loading && showDashboard && scoped && (
            <div className="usage-dashboard" aria-label="Cached usage summary">
              {usage.ledgerNote && (
                <InfoBanner icon="warning" className="usage-ledger-note-banner">
                  Usage history was not updated for this scan — {usage.ledgerNote}
                </InfoBanner>
              )}

              {showHistoryUnavailableBanner && (
                <InfoBanner icon="warning" className="usage-history-error-banner">
                  Usage history is unavailable — showing the latest scan only.
                  {historyWarnings.length > 0 &&
                    ` ${historyWarnings.length} ${historyWarnings.length === 1 ? "ledger line was" : "ledger lines were"} skipped.`}
                </InfoBanner>
              )}

              {/* zeroUsage here means the dashboard is showing only because
                  the durable history has days — this scan itself found
                  nothing (W1: the "no local usage in this scan" copy,
                  demoted from a full-screen state to a banner). */}
              {zeroUsage && (
                <InfoBanner icon="info" className="usage-noscan-banner">
                  ccusage did not find local harness usage in the latest scan — showing your recorded usage
                  history instead.
                </InfoBanner>
              )}

              {importCtaBanner}

              <UsageControls
                range={prefs.range}
                onRangeChange={prefs.setRange}
                bucket={effectiveBucket}
                onBucketChange={prefs.setBucket}
                harnesses={detectedHarnesses}
                harness={harnessFilter}
                onHarnessChange={prefs.setHarness}
                currency={prefs.currency}
                onCurrencyChange={prefs.setCurrency}
                eurRate={prefs.eurRate}
                onEurRateChange={prefs.setEurRate}
                unpricedModelNames={unpricedModels}
                onlinePricing={prefs.onlinePricing}
                onOnlinePricingChange={prefs.setOnlinePricing}
              />

              <UsageKpiRow
                costUsd={scoped.costUsd}
                tokens={scoped.tokens}
                sessions={scoped.sessions}
                toolCalls={scoped.toolCalls}
                toolCallsKnown={scoped.toolCallsKnown}
                toolCallsUnknownSessions={scoped.toolCallsUnknownSessions}
                cacheHitRate={scoped.cacheHitRate}
                harnesses={scoped.harnesses}
                currency={prefs.currency}
                eurRate={prefs.eurRate}
                coverage={coverageScope.coverage}
                unpricedModels={unpricedModels}
              />

              <UsageSpendChart
                daily={filteredDaily}
                currency={prefs.currency}
                eurRate={prefs.eurRate}
                bucket={effectiveBucket}
                onSelectPeriod={selectPeriodKey}
              />

              <UsageOverTimeBand
                timeline={timeline.data}
                history={history.query.data?.days ?? []}
                range={prefs.range}
                bucket={effectiveBucket}
                harness={harnessFilter}
                unsupported={timeline.status === "unsupported"}
                ready={timeline.status === "success" && !history.query.isLoading}
                onSelectPeriod={selectPeriodKey}
              />

              <div className="usage-band">
                <div className="usage-band-main">
                <UsageHarnessBreakdown
                  harnesses={scoped.harnesses}
                  noUsageNames={noUsageHarnessNames}
                  currency={prefs.currency}
                  eurRate={prefs.eurRate}
                  scannedAt={snapshot?.scannedAt}
                  busy={busy}
                  onScan={runAllScans}
                />
                <UsageActivityHeatmap daily={heatmapDaily} harnessId={harnessFilter} windowEnd={heatmapWindowEnd} onSelectPeriod={selectPeriodKey} />
                </div>
                <div className="usage-band-side">
                  <UsageCompositionCard tokens={scoped.tokens} coverage={coverageScope.coverage} />
                  <UsageModelsCard models={scoped.models} currency={prefs.currency} eurRate={prefs.eurRate} />
                </div>
              </div>

              <UsageProjectsCard
                projects={scoped.projects}
                currency={prefs.currency}
                eurRate={prefs.eurRate}
                projectKeys={projectKeys}
                onOpenProject={onOpenProject}
              />

              <UsageSessionsCard
                allSessions={snapshot?.sessions}
                sessions={filteredSessions}
                effectiveShowFullPaths={effectiveShowFullPaths}
                onShowFullPathsChange={setShowFullPaths}
                hasFullFidelityData={usage.hasFullFidelityData}
                busy={busy}
                onRunFreshScan={usage.runScan}
                currency={prefs.currency}
                eurRate={prefs.eurRate}
                onOpenTimeline={onOpenTimeline}
                scanned={scanned}
                analysedSessions={findings.data?.analysed_sessions}
              />
            </div>
          )}
          <UsagePeriodModal period={selectedPeriod} onPeriodChange={setSelectedPeriod} onClose={() => setSelectedPeriod(null)}
            firstDay={dayBounds.first} lastDay={dayBounds.last} daily={heatmapDaily} sessions={daySessions}
            dailyReady={history.query.isSuccess || snapshot !== null} dailyError={history.query.isError}
            sessionsAvailable={snapshot !== null} scanned={scanned} harness={harnessFilter}
            harnessName={detectedHarnesses.find((item) => item.id === harnessFilter)?.name ?? "All harnesses"}
            currency={prefs.currency} eurRate={prefs.eurRate} onInspect={inspectPeriodSession} />
        </section>
      </div>
    </>
  );
}
