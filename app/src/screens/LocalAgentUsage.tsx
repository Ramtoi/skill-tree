import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { InfoBanner } from "@/components/InfoBanner";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchInput } from "@/components/SearchInput";
import { StatusBadge } from "@/components/StatusBadge";
import { Toggle } from "@/components/Toggle";
import { normalizeCcusageScan, redactPathsInText } from "@/features/usage/normalizeUsage";
import { useLocalAgentUsage } from "@/features/usage/useLocalAgentUsage";
import type {
  LocalAgentUsageSnapshot,
  UsageDailyPoint,
  UsageDiagnostic,
  UsageErrorKind,
  UsageSessionRow,
} from "@/features/usage/usageTypes";

type DateFilter = "all" | "7d" | "30d";
type SortMode = "tokens" | "cost";

const MAX_DAILY_BARS = 60;
// .usage-chart-day is a fixed 120px grid cell (bar row + ~14.5px date-label line
// [10px font × inherited line-height:1.45] + 6px gap). 120 - 14.5 - 6 ≈ 99.5,
// buffered to 96. Keep this in sync with .usage-chart-day's height and
// .usage-chart-bar's min-height in App.css if either changes.
const MAX_BAR_HEIGHT_PX = 96;
// matches App.css `.usage-chart-bar { min-height: 8px }` — do not lower this
// without also editing that CSS rule, since CSS min-height always wins over a
// smaller inline height.
const MIN_BAR_HEIGHT_PX = 8;

const SESSIONS_COLLAPSED_LIMIT = 10;
const SESSIONS_EXPANDED_LIMIT = 100;

type ChartBar = { key: string; label: string; tooltipLabel: string; tokensTotal: number; costUsd: number };

function isWithinDateFilter(dateLike: string | undefined, filter: DateFilter): boolean {
  if (filter === "all") return true;
  if (!dateLike) return true;
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return true;
  const days = filter === "7d" ? 7 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

// Monday-start ISO week key, computed in UTC (date-only "YYYY-MM-DD" strings
// parse as UTC midnight — using local getDay()/getDate() would misbucket by one
// day for negative-UTC-offset users).
function isoWeekStartUTC(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
  return monday.toISOString().slice(0, 10);
}

function buildChartBars(daily: UsageDailyPoint[]): ChartBar[] {
  // Drops "Unknown date"-style unparseable rows from the CHART only; they remain
  // visible in the sessions table.
  const valid = daily.filter((p) => !Number.isNaN(new Date(p.date).getTime()));
  if (valid.length <= MAX_DAILY_BARS) {
    return valid.map((p) => ({
      key: p.date,
      label: p.date.slice(5),
      tooltipLabel: p.date,
      tokensTotal: p.tokens.total,
      costUsd: p.estimatedCost.usd,
    }));
  }
  const weeks = new Map<string, { tokensTotal: number; costUsd: number }>();
  for (const p of valid) {
    const weekStart = isoWeekStartUTC(new Date(p.date));
    const bucket = weeks.get(weekStart) ?? { tokensTotal: 0, costUsd: 0 };
    bucket.tokensTotal += p.tokens.total;
    bucket.costUsd += p.estimatedCost.usd;
    weeks.set(weekStart, bucket);
  }
  return Array.from(weeks.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, bucket]) => ({
      key: weekStart,
      label: weekStart.slice(5),
      tooltipLabel: `Week of ${weekStart}`,
      tokensTotal: bucket.tokensTotal,
      costUsd: bucket.costUsd,
    }));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatScannedAt(value: string | undefined): string {
  if (!value) return "No cached scan";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function isZeroUsage(snapshot: LocalAgentUsageSnapshot): boolean {
  return snapshot.overview.totalTokens === 0 && snapshot.overview.sessions === 0 && snapshot.overview.harnessesDetected === 0;
}

const USAGE_ERROR_KINDS: readonly UsageErrorKind[] = [
  "no_usage",
  "access",
  "process_failure",
  "timeout",
  "parse_failure",
];

/** True when the rejected value is a structured `UsageDiagnostic` from the Rust
 *  `usage_*` commands (they reject with the deserialized struct as-is). */
function isUsageDiagnostic(error: unknown): error is UsageDiagnostic {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" && (USAGE_ERROR_KINDS as readonly string[]).includes(kind);
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (isUsageDiagnostic(error)) return redactPathsInText(error.message);
  if (error instanceof Error) return error.message;
  try {
    return redactPathsInText(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

function classifyError(error: unknown): "permission" | "no_usage" | "ccusage" {
  // Prefer the typed, structured diagnostic the Rust layer already classified.
  if (isUsageDiagnostic(error)) {
    if (error.kind === "access") return "permission";
    if (error.kind === "no_usage") return "no_usage";
    // process_failure | timeout | parse_failure all map to the ccusage bucket.
    return "ccusage";
  }
  // Fallback: substring sniffing for a JS-side / runtime error that is NOT a
  // UsageDiagnostic (e.g. an unexpected IPC or network failure).
  const text = errorText(error).toLowerCase();
  if (text.includes("permission") || text.includes("access") || text.includes("eacces") || text.includes("sandbox")) {
    return "permission";
  }
  if (text.includes("no_usage") || text.includes("no usage") || text.includes("not detected")) {
    return "no_usage";
  }
  return "ccusage";
}

const DIAGNOSTIC_HEADER =
  "Skill Tree Local Agent Usage diagnostic\nCommand: ccusage --sections daily,weekly,monthly,session --by-agent --json --offline";

/** Build the copyable diagnostic string. For a structured `UsageDiagnostic` the
 *  free-form stdout/stderr/detail/command fields can carry local absolute
 *  paths, so every such field is path-redacted before inclusion — the copy
 *  output must never leak a real local path. */
function buildDiagnostic(error: unknown): string {
  if (!isUsageDiagnostic(error)) {
    return `${DIAGNOSTIC_HEADER}\nError: ${errorText(error)}`;
  }
  const lines = [DIAGNOSTIC_HEADER, `Kind: ${error.kind}`, `Error: ${redactPathsInText(error.message)}`];
  if (error.detail) lines.push(`Detail: ${redactPathsInText(error.detail)}`);
  if (typeof error.exit_code === "number") lines.push(`Exit code: ${error.exit_code}`);
  if (error.source?.command) lines.push(`Runner: ${redactPathsInText(error.source.command)}`);
  if (error.stdout) lines.push(`stdout: ${redactPathsInText(error.stdout)}`);
  if (error.stderr) lines.push(`stderr: ${redactPathsInText(error.stderr)}`);
  return lines.join("\n");
}

function inDateRange(session: UsageSessionRow, filter: DateFilter): boolean {
  return isWithinDateFilter(session.startedAt ?? session.period, filter);
}

function copyDiagnostic(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function LocalAgentUsage() {
  const usage = useLocalAgentUsage();
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [harnessFilter, setHarnessFilter] = useState("all");
  const [sortMode, setSortMode] = useState<SortMode>("tokens");
  const [showFullPaths, setShowFullPaths] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  // Full paths can only be revealed from a full-fidelity live scan — the on-disk
  // cache is path-redacted, so a stale `showFullPaths=true` must degrade to the
  // anonymized label instead of surfacing a redaction hash.
  const effectiveShowFullPaths = showFullPaths && usage.hasFullFidelityData;

  const snapshot = useMemo(() => {
    if (usage.cachedScan) {
      return normalizeCcusageScan(usage.cachedScan, { includeFullPaths: effectiveShowFullPaths });
    }
    return usage.snapshot;
  }, [usage.cachedScan, usage.snapshot, effectiveShowFullPaths]);

  const error = usage.scan.error ?? usage.latest.error;
  const loading = usage.latest.isLoading;
  const busy = usage.isScanning;
  const hasError = Boolean(error);
  const zeroUsage = snapshot ? isZeroUsage(snapshot) : false;
  const detectedHarnesses = snapshot?.harnesses.filter((harness) => harness.status === "detected") ?? [];

  const filteredDaily = useMemo(
    () => (snapshot?.daily ?? []).filter((p) => isWithinDateFilter(p.date, dateFilter)),
    [snapshot?.daily, dateFilter],
  );
  const chartBars = useMemo(() => buildChartBars(filteredDaily), [filteredDaily]);
  const chartMaxTokens = useMemo(() => Math.max(1, ...chartBars.map((b) => b.tokensTotal)), [chartBars]);
  const isWeeklyChart = chartBars.length !== filteredDaily.length;

  const availableModels = useMemo(
    () => Array.from(new Set((snapshot?.sessions ?? []).flatMap((s) => s.models))).sort(),
    [snapshot?.sessions],
  );

  const matchingSessions = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return (snapshot?.sessions ?? [])
      .filter((session) => harnessFilter === "all" || session.harnessId === harnessFilter)
      .filter((session) => inDateRange(session, dateFilter))
      .filter((session) => modelFilter === "all" || session.models.includes(modelFilter))
      .filter((session) => {
        if (!needle) return true;
        // Use session.project?.label (the always-anonymized "Project A" style
        // label) — NEVER redactedPath/fullPath — so the search box can't be used
        // to fish for real paths regardless of the full-paths toggle state.
        const haystack = [session.period, session.harnessName, session.project?.label, ...session.models]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) =>
        sortMode === "cost"
          ? b.estimatedCost.usd - a.estimatedCost.usd
          : b.tokens.total - a.tokens.total,
      );
  }, [dateFilter, harnessFilter, snapshot?.sessions, sortMode, modelFilter, searchText]);

  const expandTarget = Math.min(matchingSessions.length, SESSIONS_EXPANDED_LIMIT);
  const filteredSessions = matchingSessions.slice(0, sessionsExpanded ? expandTarget : SESSIONS_COLLAPSED_LIMIT);

  const diagnostic = hasError ? buildDiagnostic(error) : "";

  return (
    <>
      <ScreenHeader
        leading={<Icon name="agent" />}
        title="Local Agent Usage"
        meta={
          <StatusBadge channel="info" icon="shield">
            Runs locally · No raw prompts uploaded
          </StatusBadge>
        }
        subline="Token and cost estimates from your installed coding harnesses. Powered by ccusage."
        primary={
          <Button
            variant="primary"
            icon="rescan"
            busy={busy}
            onClick={() => usage.scan.mutate()}
          >
            {snapshot ? "Refresh scan" : "Scan local usage"}
          </Button>
        }
      />
      <div className="main-body">
        <section className="screen-pad usage-shell" aria-label="Local agent usage">
          <div className="usage-privacy">
            <Icon name="shield" size={18} />
            <div>
              <strong>Runs locally</strong>
              <span>No raw prompts or code are uploaded or displayed. Full project paths stay hidden until you opt in.</span>
            </div>
          </div>

          {loading && (
            <div className="usage-state usage-state-loading" role="status">
              <div className="usage-spinner" aria-hidden="true" />
              <div>
                <h3>Loading latest cached scan…</h3>
                <p>The dashboard opens from the local cache first, then you can refresh with a new ccusage scan.</p>
              </div>
            </div>
          )}

          {/* Full-screen error only when there is NO prior good snapshot to
              fall back to. A refresh failure over a populated dashboard is
              surfaced non-destructively via the inline banner below. */}
          {!loading && hasError && !snapshot && (
            <UsageErrorState
              kind={classifyError(error)}
              diagnostic={diagnostic}
              onRetry={() => usage.scan.mutate()}
            />
          )}

          {!loading && hasError && snapshot && (
            <InfoBanner icon="warning" className="usage-refresh-banner">
              Refresh failed — showing the last successful scan.{" "}
              <span className="usage-refresh-banner-actions">
                <Button variant="ghost" icon="rescan" busy={busy} onClick={() => usage.scan.mutate()}>
                  Retry
                </Button>
                <Button variant="ghost" onClick={() => copyDiagnostic(diagnostic)}>
                  Copy diagnostic
                </Button>
              </span>
            </InfoBanner>
          )}

          {!loading && !hasError && !snapshot && (
            <div className="usage-state usage-empty">
              <span className="usage-kicker">First run</span>
              <h3>No cached usage scan yet</h3>
              <p>Scan local usage to summarize token and estimated API-equivalent cost from coding harness logs ccusage can detect on this machine.</p>
              <Button variant="primary" icon="rescan" busy={busy} onClick={() => usage.scan.mutate()}>
                Scan local usage
              </Button>
            </div>
          )}

          {!loading && snapshot && zeroUsage && (
            <div className="usage-state usage-empty" role="status">
              <span className="usage-kicker">No usage found</span>
              <h3>No local harness usage was detected yet</h3>
              <p>ccusage ran locally, but did not find supported harness logs with usage data. Try again after using Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Qwen, Kimi, Goose, Hermes, or another supported harness.</p>
              <Button variant="soft" icon="rescan" busy={busy} onClick={() => usage.scan.mutate()}>
                Retry scan
              </Button>
            </div>
          )}

          {!loading && snapshot && !zeroUsage && (
            <div className="usage-dashboard" aria-label="Cached usage summary">
              <div className="usage-summary-head usage-card">
                <div>
                  <span className="usage-kicker">Last scanned</span>
                  <h3>{formatScannedAt(snapshot.scannedAt)}</h3>
                  <p className="usage-note">{snapshot.privacy.costCaveat}</p>
                </div>
                <StatusBadge channel="neutral" shape="ring">
                  {snapshot.runner.resolved_from}
                </StatusBadge>
              </div>

              <dl className="usage-metrics" aria-label="Usage overview metrics">
                <Metric label="Total tokens" value={formatCount(snapshot.overview.totalTokens)} />
                <Metric label="Estimated API-equivalent cost" value={formatCurrency(snapshot.overview.estimatedCost.usd)} />
                <Metric label="Sessions" value={formatCount(snapshot.overview.sessions)} />
                <Metric label="Top harness" value={snapshot.overview.topHarness ?? "None"} />
              </dl>

              <section className="usage-card" aria-label="Harness breakdown">
                <div className="usage-section-head">
                  <div>
                    <span className="usage-kicker">Harness breakdown</span>
                    <h3>Installed agents ccusage can report</h3>
                  </div>
                  <span className="usage-note">Detected, no usage, and local source states</span>
                </div>
                <div className="usage-harness-list">
                  {snapshot.harnesses.slice(0, 12).map((harness) => (
                    <div className="usage-harness-row" key={harness.id} data-state={harness.status}>
                      <div>
                        <strong>{harness.name}</strong>
                        <span>{harness.status === "detected" ? `${formatCount(harness.sessions)} sessions · ${harness.models.join(", ") || "models unknown"}` : "No local usage detected"}</span>
                      </div>
                      <div className="usage-row-numbers">
                        <b>{formatCount(harness.tokens.total)}</b>
                        <span>{formatCurrency(harness.estimatedCost.usd)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="usage-card" aria-label="Detected harness sources">
                <div className="usage-section-head">
                  <div>
                    <span className="usage-kicker">Detected sources</span>
                    <h3>Local harness/source list</h3>
                  </div>
                </div>
                <div className="usage-source-chips">
                  {snapshot.detectedSources.slice(0, 14).map((source) => (
                    <span className="usage-source-chip" key={source.id} data-state={source.status}>
                      {source.name}: {source.status === "detected" ? "detected" : "no usage"}
                    </span>
                  ))}
                </div>
              </section>

              <section className="usage-card" aria-label="Daily usage chart">
                <div className="usage-controls">
                  <label>
                    Date range
                    <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value as DateFilter)}>
                      <option value="all">All dates</option>
                      <option value="7d">Last 7 days</option>
                      <option value="30d">Last 30 days</option>
                    </select>
                  </label>
                </div>
                <div className="usage-section-head">
                  <div>
                    <span className="usage-kicker">Daily usage</span>
                    <h3>Tokens by day{isWeeklyChart ? " (weekly)" : ""}</h3>
                  </div>
                </div>
                <div className="usage-chart">
                  {chartBars.map((bar) => {
                    const height = Math.max(
                      MIN_BAR_HEIGHT_PX,
                      Math.round((bar.tokensTotal / chartMaxTokens) * MAX_BAR_HEIGHT_PX),
                    );
                    return (
                      <div className="usage-chart-day" key={bar.key}>
                        <div
                          className="usage-chart-bar-wrap"
                          tabIndex={0}
                          aria-label={`${bar.tooltipLabel}: ${formatCount(bar.tokensTotal)} tokens, ${formatCurrency(bar.costUsd)}`}
                        >
                          <div className="usage-chart-bar" style={{ height }} />
                          <span className="usage-chart-tip" role="tooltip">
                            {bar.tooltipLabel}
                            <br />
                            {formatCount(bar.tokensTotal)} tokens · {formatCurrency(bar.costUsd)}
                          </span>
                        </div>
                        <span>{bar.label}</span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="usage-card" aria-label="Largest sessions">
                <div className="usage-session-search">
                  <SearchInput value={searchText} onChange={setSearchText} placeholder="Search sessions…" screenSearch />
                </div>
                <div className="usage-section-head usage-session-head">
                  <div>
                    <span className="usage-kicker">Largest sessions</span>
                    <h3>Sortable local sessions</h3>
                  </div>
                  <div className="usage-controls" aria-label="Usage filters">
                    <label>
                      Harness
                      <select value={harnessFilter} onChange={(event) => setHarnessFilter(event.target.value)}>
                        <option value="all">All harnesses</option>
                        {detectedHarnesses.map((harness) => (
                          <option value={harness.id} key={harness.id}>{harness.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Model
                      <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}>
                        <option value="all">All models</option>
                        {availableModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Sort
                      <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                        <option value="tokens">Tokens</option>
                        <option value="cost">Estimated cost</option>
                      </select>
                    </label>
                    <Toggle
                      className="usage-toggle"
                      variant="switch"
                      size="sm"
                      checked={effectiveShowFullPaths}
                      onChange={setShowFullPaths}
                      disabled={!usage.hasFullFidelityData}
                      ariaLabel="Show full paths"
                      label="Show full paths"
                    />
                  </div>
                </div>
                {!usage.hasFullFidelityData ? (
                  <p className="usage-note usage-fullpath-hint">
                    Cached data hides full paths for privacy.{" "}
                    <button type="button" className="usage-inline-link" disabled={busy} onClick={() => usage.scan.mutate()}>
                      Run a fresh scan
                    </button>{" "}
                    to reveal them for this session. Full paths are available only for harnesses that
                    report a project path (currently Claude Code and pi-agent).
                  </p>
                ) : (
                  <p className="usage-note usage-fullpath-hint">
                    Full paths are available only for harnesses that report a project path (currently Claude Code and pi-agent).
                  </p>
                )}
                <div className="usage-table" role="table">
                  <div className="usage-table-row usage-table-head" role="row">
                    <span>Session</span>
                    <span>Harness</span>
                    <span>Project</span>
                    <span>Tokens</span>
                    <span>Est. cost</span>
                  </div>
                  {filteredSessions.map((session) => (
                    <div className="usage-table-row" role="row" key={session.id}>
                      <span>{session.period}</span>
                      <span>{session.harnessName}</span>
                      <span>{effectiveShowFullPaths ? (session.project?.fullPath ?? session.project?.redactedPath ?? "Local project") : (session.project?.label ?? "Local project")}</span>
                      <span>{formatCount(session.tokens.total)}</span>
                      <span>{formatCurrency(session.estimatedCost.usd)}</span>
                    </div>
                  ))}
                  {filteredSessions.length === 0 && <p className="usage-note">No sessions match the selected filters.</p>}
                </div>
                {matchingSessions.length > filteredSessions.length || filteredSessions.length < expandTarget ? (
                  <div className="usage-sessions-footer">
                    <span className="usage-note">
                      Showing {filteredSessions.length} of {matchingSessions.length} sessions
                    </span>
                    {filteredSessions.length < expandTarget && (
                      <button
                        type="button"
                        className="usage-show-more"
                        onClick={() => setSessionsExpanded(true)}
                      >
                        Show {expandTarget - filteredSessions.length} more
                      </button>
                    )}
                    {sessionsExpanded && matchingSessions.length > SESSIONS_EXPANDED_LIMIT && (
                      <p className="usage-note">
                        Showing the first {SESSIONS_EXPANDED_LIMIT} matches — narrow your search or filters to see the rest.
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UsageErrorState({ kind, diagnostic, onRetry }: { kind: "permission" | "no_usage" | "ccusage"; diagnostic: string; onRetry: () => void }) {
  const copy = {
    permission: {
      title: "Skill Tree cannot access local usage logs",
      body: "This looks like a permission or sandbox access issue. The scan runs locally, so Skill Tree needs access to the harness log locations on this machine.",
    },
    no_usage: {
      title: "No usage found",
      body: "ccusage ran locally but did not find supported harness usage yet. Use a coding harness, then retry the scan.",
    },
    ccusage: {
      title: "ccusage could not finish the scan",
      body: "The bundled ccusage runner returned a failure. Copy the diagnostic if you need to troubleshoot the local machine setup.",
    },
  }[kind];

  return (
    <div className="usage-state usage-state-error" role="alert">
      <span className="usage-kicker">Local scan issue</span>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <div className="usage-error-actions">
        <Button variant="soft" icon="rescan" onClick={onRetry}>Retry scan</Button>
        <Button variant="ghost" onClick={() => copyDiagnostic(diagnostic)}>Copy diagnostic</Button>
      </div>
    </div>
  );
}
