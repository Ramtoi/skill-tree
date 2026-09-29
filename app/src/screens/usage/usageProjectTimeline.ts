import type { Column } from "@/components/charts/StackedColumnChart";
import type { LineChartSeries } from "@/components/charts/LineChart";
import type {
  UsageLoadoutRow,
  UsageProjectSessionRow,
  UsageTimelinePayload,
  UsageWindow,
} from "@/features/usage/usageAnalyticsTypes";
import { buildActivitySeries } from "./usageOverTime";
import { windowBounds } from "./usageAggregate";
import { bucketKeyUTC, bucketLabel } from "./usageChartColumns";

function utcDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function buildProjectSessionColumns(
  sessions: UsageProjectSessionRow[],
  loadoutRows: UsageLoadoutRow[],
  window: UsageWindow,
  harnessFilter: string | null,
  now = new Date(),
): Column[] {
  const { since, until } = windowBounds(window, now);
  const bucket = window === 90 ? "week" : "day";
  const keys = new Set<string>();
  const day = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (day <= end) {
    keys.add(bucketKeyUTC(day, bucket));
    day.setUTCDate(day.getUTCDate() + 1);
  }

  const included = (harness: string, date: Date | undefined) => {
    if (date === undefined) return false;
    const dateKey = date.toISOString().slice(0, 10);
    return dateKey >= since && dateKey <= until && (harnessFilter === null || harness === harnessFilter);
  };
  const harnesses = [...new Set(sessions.filter((row) => included(row.harness, utcDate(row.started_at))).map((row) => row.harness))].sort();
  const valuesByKey = new Map<string, Record<string, number>>();
  for (const key of keys) valuesByKey.set(key, Object.fromEntries(harnesses.map((id) => [id, 0])));
  for (const row of sessions) {
    const date = utcDate(row.started_at);
    if (!included(row.harness, date)) continue;
    const key = bucketKeyUTC(date!, bucket);
    const values = valuesByKey.get(key);
    if (values) values[row.harness] = (values[row.harness] ?? 0) + 1;
  }

  const markersByKey = new Map<string, Column["markers"]>();
  for (const row of loadoutRows) {
    const date = utcDate(row.at);
    if (!included(row.harness, date) || row.kind !== "changed") continue;
    const key = bucketKeyUTC(date!, bucket);
    if (!markersByKey.has(key)) markersByKey.set(key, []);
    markersByKey.get(key)!.push({ id: `${row.at}:${row.harness}:${row.hash}`, label: "Loadout changed", harness: row.harness });
  }

  return [...keys].sort().map((key) => ({
    key,
    ...bucketLabel(key, bucket),
    values: valuesByKey.get(key) ?? {},
    markers: markersByKey.get(key),
  }));
}

export function projectActivitySeries(
  payload: UsageTimelinePayload,
  window: UsageWindow,
  kind: "skills" | "tools",
): LineChartSeries[] {
  return buildActivitySeries(payload.days, window === 90 ? "week" : "day", kind);
}
