import { useMemo, useState } from "react";
import { ChipRadios } from "@/components/ChipRadios";
import { identityColor } from "@/components/charts/chartColors";
import { StackedColumnChart, type Series } from "@/components/charts/StackedColumnChart";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import type { UsageDailyPoint } from "@/features/usage/usageTypes";
import { plural } from "@/lib/plural";
import { ccusageToHubHarness, harnessColorIndex, orderHarnessIds } from "./harnessIdentity";
import { formatCompact, formatMoney, type UsageCurrency } from "./usageFormat";
import {
  buildStackedColumns,
  harnessOrderFromDaily,
  type ChartBucket,
  type ChartMeasure,
} from "./usageChartColumns";
import type { UsagePeriodKind } from "./usagePeriod";

const MEASURE_OPTIONS = [
  { value: "tokens" as const, label: "Tokens" },
  { value: "cost" as const, label: "Cost" },
  { value: "sessions" as const, label: "Session count" },
  { value: "tokensPerSession" as const, label: "Tokens / session" },
];

export interface UsageSpendChartProps {
  daily: UsageDailyPoint[];
  currency: UsageCurrency;
  eurRate: number;
  /** The viewer's persisted bucket pick — `null` when they have never
   *  picked one, so the chart falls back to {@link defaultBucketFor}. */
  bucket: ChartBucket;
  onSelectPeriod?: (key: string, kind: UsagePeriodKind) => void;
}

/** "Spend over time" — a `StackedColumnChart` with one series per detected
 *  harness (fixed order, identity-ramp colors). Measure (tokens vs cost) is
 *  local UI state, not persisted; the bucket (day/week/month/year) is a
 *  persisted viewer pick, defaulting per {@link defaultBucketFor} until one
 *  is made. */
export function UsageSpendChart({ daily, currency, eurRate, bucket, onSelectPeriod }: UsageSpendChartProps) {
  const [measure, setMeasure] = useState<ChartMeasure>("tokens");

  const harnessNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const point of daily) {
      for (const harness of point.harnesses) {
        if (!names.has(harness.id)) names.set(harness.id, harness.name);
      }
    }
    return names;
  }, [daily]);

  const orderedIds = useMemo(() => orderHarnessIds(harnessOrderFromDaily(daily)), [daily]);

  const series: Series[] = useMemo(
    () =>
      measure === "tokensPerSession"
        ? [{ id: "aggregate", label: "Tokens / session", color: identityColor(0) }]
        : orderedIds.map((id) => {
        const hubHarness = ccusageToHubHarness(id);
        return {
          id,
          label: harnessNames.get(id) ?? id,
          // Keyed on the harness, never on its position in `orderedIds` — a
          // harness dropping out of scope must not re-hue the rest.
          color: identityColor(harnessColorIndex(id)),
          swatch: hubHarness ? <HarnessGlyph id={hubHarness} size={12} decorative /> : undefined,
        };
          }),
    [orderedIds, harnessNames, measure],
  );

  const effectiveBucket = bucket;
  const periodKind: UsagePeriodKind | undefined = effectiveBucket === "year" ? undefined : effectiveBucket;
  const { columns, unavailableBuckets, partialBuckets } = useMemo(
    () => buildStackedColumns(daily, measure, effectiveBucket),
    [daily, measure, effectiveBucket],
  );

  // Counted over the underlying DAYS, not the (possibly week/month-bucketed)
  // columns — "N days" should name real calendar days regardless of how the
  // chart currently groups them.
  const backfilledDays = useMemo(
    () => daily.filter((point) => point.provenance === "backfilled").length,
    [daily],
  );

  const measureLabel = measure === "cost" ? "Spend" : measure === "tokens" ? "Tokens" : measure === "sessions" ? "Session count" : "Tokens per session";
  const format = (value: number) => (measure === "cost" ? formatMoney(value, currency, eurRate) : formatCompact(value));

  return (
    // The section keeps its card name as a STABLE landmark label; only the
    // heading, the chart label and the loading copy follow the measure.
    <section className="usage-card usage-spend-card" aria-label="Spend over time">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Spend over time</span>
          <h3>{measure === "cost" ? "Cost" : measureLabel} by {effectiveBucket}</h3>
        </div>
        <div className="usage-spend-controls">
          <ChipRadios
            name="usage-measure"
            label="Measure"
            value={measure}
            options={MEASURE_OPTIONS}
            onChange={(v) => setMeasure(v)}
          />
        </div>
      </div>
      <StackedColumnChart
        series={series}
        columns={columns}
        format={format}
        ariaLabel={`${measureLabel} over time chart`}
        height={180}
        legend="always"
        onSelectColumn={onSelectPeriod && periodKind ? (key) => onSelectPeriod(key, periodKind) : undefined}
      />
      {unavailableBuckets > 0 && measure === "tokensPerSession" && (
        <p className="usage-note">{unavailableBuckets} {unavailableBuckets === 1 ? "bucket" : "buckets"} without a session count</p>
      )}
      {partialBuckets > 0 && measure === "sessions" && (
        <p className="usage-note">{partialBuckets} {partialBuckets === 1 ? "bucket includes" : "buckets include"} days without a session count</p>
      )}
      {backfilledDays > 0 && (
        <p className="usage-note usage-spend-legend-note">
          {backfilledDays} {plural(backfilledDays, "day")} from Claude Code's own stats (tokens only)
          {measure === "cost" && " · cost unavailable for those days"}
        </p>
      )}
    </section>
  );
}
