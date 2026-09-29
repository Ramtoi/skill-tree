import { seriesColorFor } from "@/components/charts/chartColors";
import type { LineChartSeries } from "@/components/charts/LineChart";
import type { UsageTimelineDay, UsageTimelinePayload } from "@/features/usage/usageAnalyticsTypes";
import type { UsageHistoryDay } from "@/features/usage/usageTypes";
import { parseModelId } from "./modelIdentity";
import { rangeBounds } from "./usageAggregate";
import type { UsageRange } from "./useUsagePrefs";
import { bucketKeyUTC, type ChartBucket } from "./usageChartColumns";

export const OTHER_ID = "__other_activity__";

export function activityTotals(days: UsageTimelineDay[], kind: "skills" | "tools"): [string, number][] {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [id, value] of Object.entries(day[kind])) totals.set(id, (totals.get(id) ?? 0) + value);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface ActivitySelection { ids: readonly string[] }

export function scopeHistoryDays(days: UsageHistoryDay[], range: UsageRange): UsageHistoryDay[] {
  const bounds = rangeBounds(range);
  if (bounds.since === null || bounds.until === null) return days;
  return days.filter((day) => {
    const date = day.date.slice(0, 10);
    return date >= bounds.since! && date <= bounds.until!;
  });
}

export type ActivityBounds = Pick<UsageTimelinePayload, "since" | "until">;

function buckets(days: UsageTimelineDay[], bucket: ChartBucket, bounds?: ActivityBounds): Map<string, UsageTimelineDay[]> {
  const result = new Map<string, UsageTimelineDay[]>();
  for (const day of days) {
    const key = bucketKeyUTC(new Date(`${day.date.slice(0, 10)}T00:00:00Z`), bucket);
    result.set(key, [...(result.get(key) ?? []), day]);
  }
  const dates = days.map((day) => day.date.slice(0, 10)).sort();
  const start = bounds?.since ?? dates[0];
  const end = bounds?.until ?? dates[dates.length - 1];
  if (start && end) {
    const cursor = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    while (cursor <= last) {
      const key = bucketKeyUTC(cursor, bucket);
      if (!result.has(key)) result.set(key, []);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return result;
}

export function buildActivitySeries(days: UsageTimelineDay[], bucket: ChartBucket, kind: "skills" | "tools", selection?: ActivitySelection, bounds?: ActivityBounds): LineChartSeries[] {
  const grouped = buckets(days, bucket, bounds);
  const ranked = activityTotals(days, kind);
  const available = new Set(ranked.map(([id]) => id));
  const keep = selection
    ? [...new Set(selection.ids)].filter((id) => available.has(id))
    : ranked.slice(0, kind === "skills" ? 3 : 8).map(([id]) => id);
  const ids = [...keep, ...(kind === "tools" && ranked.length > keep.length ? [OTHER_ID] : [])];
  const colorIds = ids.map((id) => id === OTHER_ID ? "Other" : id);
  return ids.map((id) => ({
    id,
    label: id === OTHER_ID ? "Other" : id,
    color: seriesColorFor(id === OTHER_ID ? "Other" : id, undefined, colorIds),
    points: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([x, rows]) => ({
      x,
      y: rows.reduce((sum, row) => sum + (id === OTHER_ID
        ? Object.entries(row[kind]).filter(([name]) => !keep.includes(name)).reduce((n, [, value]) => n + value, 0)
        : row[kind][id] ?? 0), 0),
    })),
  }));
}

export interface ModelMixColumn { key: string; values: Record<string, number>; unknown: boolean }
export interface ModelMix { models: string[]; columns: ModelMixColumn[]; unknownBuckets: number; knownCost: number; shares: Record<string, number>; labels: Record<string, string> }

export function buildModelMix(days: UsageHistoryDay[], harness: string | null, bucket: ChartBucket = "week"): ModelMix {
  const buckets = new Map<string, { costs: Map<string, number>; total: number; unknown: boolean }>();
  for (const day of days) {
    const key = bucketKeyUTC(new Date(`${day.date.slice(0, 10)}T00:00:00Z`), bucket);
    const period = buckets.get(key) ?? { costs: new Map(), total: 0, unknown: false };
    for (const agent of day.agents) {
      if (harness && agent.agent !== harness) continue;
      for (const model of agent.models) {
        if (!model.costKnown) period.unknown = true;
        else { period.costs.set(model.model ?? "Unknown", (period.costs.get(model.model ?? "Unknown") ?? 0) + model.costUsd); period.total += model.costUsd; }
      }
    }
    buckets.set(key, period);
  }
  const known = [...buckets.values()].filter((period) => !period.unknown);
  const totals = new Map<string, number>();
  for (const period of known) for (const [model, cost] of period.costs) totals.set(model, (totals.get(model) ?? 0) + cost);
  const keep = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([model]) => model);
  const models = [...keep, ...(totals.size > keep.length ? ["Other"] : [])];
  const knownCost = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const shares = Object.fromEntries(models.map((model) => [model, knownCost > 0
    ? ([...totals.entries()].filter(([name]) => model === "Other" ? !keep.includes(name) : name === model).reduce((sum, [, value]) => sum + value, 0) / knownCost) * 100
    : 0]));
  const labels = Object.fromEntries(models.map((model) => [model, model === "Other" ? "Other" : parseModelId(model).display]));
  const columns = [...buckets.entries()]
    .filter(([, period]) => !period.unknown && period.total > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, period]) => ({
      key,
      unknown: false,
      values: Object.fromEntries(models.map((model) => {
        const cost = [...period.costs.entries()]
          .filter(([name]) => model === "Other" ? !keep.includes(name) : name === model)
          .reduce((sum, [, value]) => sum + value, 0);
        return [model, cost / period.total * 100];
      })),
    }));
  const unknownBuckets = [...buckets.values()].filter((period) => period.unknown).length;
  return { models, columns, unknownBuckets, knownCost, shares, labels };
}
