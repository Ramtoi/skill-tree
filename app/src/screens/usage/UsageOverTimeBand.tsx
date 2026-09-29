import { useMemo } from "react";
import { seriesColorFor } from "@/components/charts/chartColors";
import { StackedColumnChart, type Series } from "@/components/charts/StackedColumnChart";
import type { UsageTimelinePayload } from "@/features/usage/usageAnalyticsTypes";
import type { UsageHistoryDay } from "@/features/usage/usageTypes";
import { buildModelMix, scopeHistoryDays } from "./usageOverTime";
import { UsageActivityCard } from "./UsageActivityCard";
import { UsagePeaksGrid } from "./UsagePeaksGrid";
import type { UsageRange } from "./useUsagePrefs";
import { bucketLabel, type ChartBucket } from "./usageChartColumns";
import type { UsagePeriodKind } from "./usagePeriod";

const EMPTY_GRID = Array.from({ length: 7 }, () => Array(24).fill(0));

interface UsageOverTimeBandProps {
  timeline: UsageTimelinePayload | undefined;
  history: UsageHistoryDay[];
  range: UsageRange;
  bucket: ChartBucket;
  harness: string | null;
  ready: boolean;
  unsupported?: boolean;
  onSelectPeriod?: (key: string, kind: UsagePeriodKind) => void;
}

export function UsageOverTimeBand({ timeline, history, range, bucket, harness, ready, unsupported = false, onSelectPeriod }: UsageOverTimeBandProps) {
  const empty = timeline !== undefined && timeline.days.length === 0;
  const notice = unsupported ? `No timeline for ${harness}` : empty ? "Codex skill events and Claude MCP events appear after the next transcript scan" : undefined;
  const mix = useMemo(() => buildModelMix(scopeHistoryDays(history, range), harness, bucket), [history, harness, range, bucket]);
  const modelSeries: Series[] = mix.models.map((id) => ({ id, label: mix.labels[id] ?? id, color: seriesColorFor(id, undefined, mix.models) }));
  const columns = mix.columns.map((column) => ({ key: column.key, label: bucketLabel(column.key, bucket).label, tooltipLabel: bucketLabel(column.key, bucket).tooltipLabel, values: column.values }));
  const periodKind: UsagePeriodKind | undefined = bucket === "year" ? undefined : bucket;
  return <section className="usage-over-time" data-ready={ready && !unsupported ? "true" : "false"} aria-label="Over time usage">
    <div className="usage-over-time-main">
      <UsageActivityCard kind="skills" days={timeline?.days ?? []} bucket={bucket} bounds={timeline} notice={notice} onSelectPeriod={onSelectPeriod} />
      <UsageActivityCard kind="tools" days={timeline?.days ?? []} bucket={bucket} bounds={timeline} notice={notice} onSelectPeriod={onSelectPeriod} />
    </div>
    <div className="usage-over-time-side">
      <UsagePeaksGrid grid={timeline?.peaks.grid ?? EMPTY_GRID} since={timeline?.since ?? null} until={timeline?.until ?? null} />
      <section className="usage-card usage-over-time-card usage-model-mix" aria-label="Model mix">
        <span className="usage-kicker">Over time</span><h3>Model mix</h3><p className="usage-note">Cost share by {bucket} · percent</p>
        <div className="chart-legend usage-model-mix-legend">
          {mix.models.map((id) => <div className="chart-legend-item" key={id}>
            <span className="chart-swatch" style={{ background: seriesColorFor(id, undefined, mix.models) }} aria-hidden="true" />
            <span className="chart-legend-label">{mix.labels[id] ?? id}</span>
            <span className="chart-legend-value">{Math.round(mix.shares[id] ?? 0)}%</span>
          </div>)}
        </div>
        <StackedColumnChart series={modelSeries} columns={columns} format={(value) => `${Math.round(value)}%`} ariaLabel={`${bucket} model cost share, percent`} onSelectColumn={onSelectPeriod && periodKind ? (key) => onSelectPeriod(key, periodKind) : undefined} />
        {mix.unknownBuckets > 0 && <p className="usage-note">{mix.unknownBuckets} {mix.unknownBuckets === 1 ? bucket : `${bucket}s`} without a full cost</p>}
      </section>
    </div>
  </section>;
}
