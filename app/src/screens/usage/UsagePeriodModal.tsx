import { useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { StatCard } from "@/components/StatCard";
import { seriesColorFor } from "@/components/charts/chartColors";
import type { UsageDailyPoint, UsageSessionRow } from "@/features/usage/usageTypes";
import { useUsageTimeline } from "@/hooks/useUsageAnalytics";
import { ModelName } from "./ModelName";
import { TokenCompositionBars } from "./TokenCompositionBars";
import { UsagePeriodSessions } from "./UsagePeriodSessions";
import { usagePeriodDetail } from "./usagePeriodDetail";
import { adjacentUsagePeriod, periodFromKey, usagePeriodTitle, type UsagePeriod } from "./usagePeriod";
import { isUnpriced } from "./pricing";
import { formatCompact, formatCount, formatMoney, type UsageCurrency } from "./usageFormat";
import "@/styles/screens/usage-day.css";

interface Props {
  period: UsagePeriod | null;
  onPeriodChange: (period: UsagePeriod) => void;
  onClose: () => void;
  firstDay: string;
  lastDay: string;
  daily: UsageDailyPoint[];
  sessions: UsageSessionRow[];
  dailyReady: boolean;
  dailyError: boolean;
  sessionsAvailable: boolean;
  scanned: boolean;
  harness: string | null;
  harnessName: string;
  currency: UsageCurrency;
  eurRate: number;
  onInspect: (session: UsageSessionRow) => void;
}

export function UsagePeriodModal({ period, onPeriodChange, onClose, firstDay, lastDay, daily, sessions,
  dailyReady, dailyError, sessionsAvailable, scanned, harness, harnessName, currency, eurRate, onInspect }: Props) {
  const selected = useMemo(() => period ?? periodFromKey("day", lastDay)!, [period, lastDay]);
  const { kind, since, until } = selected;
  const detail = useMemo(() => usagePeriodDetail(selected, daily, sessions), [selected, daily, sessions]);
  const timeline = useUsageTimeline({ since, until }, harness, period !== null);
  const rows = timeline.data?.days.filter(item => item.date >= since && item.date <= until) ?? [];
  const totals = new Map<string, number>();
  for (const row of rows) for (const [name, count] of Object.entries(row.tools)) totals.set(name, (totals.get(name) ?? 0) + count);
  const toolsAvailable = timeline.status === "success" && (rows.length > 0 || (scanned && !detail.historyOnly));
  const tools = [...totals].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const calls = tools.reduce((sum, [, count]) => sum + count, 0);
  const haveSessions = sessionsAvailable && !detail.historyOnly;
  const title = usagePeriodTitle(selected);
  const first = since <= firstDay;
  const last = until >= lastDay;
  const frequency = kind === "day" ? "Daily" : kind === "week" ? "Weekly" : "Monthly";
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [since, until]);
  const cost = !dailyReady || detail.costUnavailable ? "Unknown" : `${detail.costPartial ? "~" : ""}${formatMoney(detail.costUsd, currency, eurRate)}`;
  const loadingTools = timeline.status === "pending";
  const toolNote = timeline.status === "error" ? "Tool activity could not be loaded." : timeline.status === "unsupported" ? `No tool timeline for ${harnessName}.` : loadingTools ? "Loading tool activity…" : `Tool activity is unavailable for this ${kind}.`;
  const empty = dailyReady && detail.tokens.total === 0 && haveSessions && detail.sessions.length === 0 && toolsAvailable && calls === 0;

  return <Modal open={period !== null} onClose={onClose} width={960} className="usage-day-modal" bodyRef={bodyRef}
    aria-label={`Usage for ${title}`} title={<span className="usage-day-header">
      <span className="usage-day-heading"><span className="usage-kicker">{kind === "day" ? "Day" : kind === "week" ? "Week" : "Month"} details</span><span role="heading" aria-level={2} className="usage-day-title">{title}</span><span className="usage-day-scope">{harnessName} · {frequency} usage</span></span>
      <span className="usage-day-nav"><Button icon="chevron-left" size="sm" title={`Previous ${kind}`} aria-label={`Previous ${kind}`} disabled={first} disabledReason={first ? `First available ${kind}` : undefined} onClick={() => onPeriodChange(adjacentUsagePeriod(selected, -1))} /><Button icon="chevron-right" size="sm" title={`Next ${kind}`} aria-label={`Next ${kind}`} disabled={last} disabledReason={last ? `Latest available ${kind}` : undefined} onClick={() => onPeriodChange(adjacentUsagePeriod(selected, 1))} /></span>
    </span>} footer={<><span>History uses source dates. Sessions and tools use UTC.</span><span><kbd>Esc</kbd> Close</span></>}>
    {!dailyReady && <p className="usage-day-notice" role="status">{dailyError ? "Daily usage could not be loaded. Available session and tool data is shown below." : "Loading daily usage…"}</p>}
    {detail.historyOnly && <p className="usage-day-notice">This {kind} includes imported token history. Cost and session details may be unavailable.</p>}
    <div className="usage-day-metrics">
      <StatCard label="Tokens" value={dailyReady ? formatCompact(detail.tokens.total) : "Unknown"} title={dailyReady ? formatCount(detail.tokens.total) : undefined} sub="Daily usage history" />
      <StatCard label="Estimated cost" value={cost} sub={detail.costPartial ? "Partial API-equivalent cost" : currency === "EUR" ? `API-equivalent · ${eurRate} EUR/USD` : "API-equivalent"} />
      <StatCard label="Sessions" value={haveSessions ? formatCount(detail.sessions.length) : "Unknown"} sub="From the latest scan" />
      <StatCard label="Tool calls" value={toolsAvailable ? formatCount(calls) : loadingTools ? "Loading…" : "Unknown"} sub="Dated tool events" />
    </div>
    {empty ? <div className="usage-day-empty"><h3>No recorded activity</h3><p>There is no usage in the current data for this {kind}. Try another {kind} or return to the charts.</p></div> : <>
      <section className="usage-day-composition" aria-label={`${kind} token composition`}><div className="usage-day-section-head"><h3>Token composition</h3><span>Includes cached tokens</span></div>
        {!dailyReady || detail.splitUnavailable ? <p className="usage-note">Token composition is unavailable for all or part of this {kind}.</p> : <TokenCompositionBars tokens={detail.tokens} ariaLabel={`${kind} token composition`} showZoom={false} />}
      </section>
      <div className="usage-day-breakdowns">
        <section aria-label={`${kind} models`}><div className="usage-day-section-head"><h3>Models <span className="usage-day-count">{detail.models.length}</span></h3><span>This {kind}</span></div>
          {detail.models.length === 0 ? <p className="usage-day-unavailable">No model breakdown available for this {kind}.</p> : <table className="usage-day-models"><thead><tr><th>Model</th><th>Tokens</th><th>Est. cost</th></tr></thead><tbody>{detail.models.map((model) => <tr key={model.modelName}>
            <td><span className="usage-day-model-name"><span className="chart-swatch" style={{ background: seriesColorFor(model.modelName) }} aria-hidden="true" /><ModelName model={model.modelName} /></span></td><td title={formatCount(model.tokens.total)}>{formatCompact(model.tokens.total)}</td><td>{model.costKnown === false ? "Unknown" : isUnpriced(model) ? "Unpriced" : `${model.costPartial ? "~" : ""}${formatMoney(model.costUsd, currency, eurRate)}`}</td>
          </tr>)}</tbody></table>}
        </section>
        <section aria-label={`${kind} tool calls`}><div className="usage-day-section-head"><h3>Tool calls</h3><span>By server · UTC {kind}</span></div>
          {!toolsAvailable ? <div className="usage-day-unavailable" role="status">{toolNote}{timeline.status === "error" && <Button size="sm" onClick={() => void timeline.refetch()}>Retry tool activity</Button>}</div> : tools.length === 0 ? <p className="usage-day-unavailable">No recorded tool calls.</p> : <ul className="usage-day-tools">{tools.map(([name, count]) => <li key={name}><span className="usage-day-tool-name" title={name}><span className="chart-swatch" style={{ background: seriesColorFor(name) }} aria-hidden="true" />{name}</span><span className="usage-day-tool-track" aria-hidden="true"><span style={{ width: `${100 * count / tools[0][1]}%`, background: seriesColorFor(name) }} /></span><span>{formatCount(count)}</span></li>)}</ul>}
        </section>
      </div>
      <UsagePeriodSessions key={`${kind}:${since}:${harness}`} kind={kind} sessions={detail.sessions} available={haveSessions} currency={currency} eurRate={eurRate} onInspect={onInspect} />
    </>}
  </Modal>;
}
