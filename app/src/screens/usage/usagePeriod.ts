import { bucketKeyUTC, dateFmt } from "./usageChartColumns";

export type UsagePeriodKind = "day" | "week" | "month";
export interface UsagePeriod {
  kind: UsagePeriodKind;
  key: string;
  since: string;
  until: string;
}

export function isUsageDayKey(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function periodFromKey(kind: UsagePeriodKind, key: string): UsagePeriod | null {
  const dateKey = kind === "month" ? `${key}-01` : key;
  if (!isUsageDayKey(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00Z`);
  const normalized = bucketKeyUTC(date, kind);
  const since = kind === "month" ? `${normalized}-01` : normalized;
  const end = new Date(`${since}T00:00:00Z`);
  if (kind === "week") end.setUTCDate(end.getUTCDate() + 6);
  if (kind === "month") { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); }
  return { kind, key: normalized, since, until: end.toISOString().slice(0, 10) };
}

export function adjacentUsagePeriod(period: UsagePeriod, offset: number): UsagePeriod {
  const date = new Date(`${period.since}T00:00:00Z`);
  if (period.kind === "month") date.setUTCMonth(date.getUTCMonth() + offset);
  else date.setUTCDate(date.getUTCDate() + offset * (period.kind === "week" ? 7 : 1));
  return periodFromKey(period.kind, bucketKeyUTC(date, period.kind))!;
}

export function usagePeriodTitle(period: UsagePeriod): string {
  const start = new Date(`${period.since}T00:00:00Z`);
  if (period.kind === "day") return dateFmt(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  if (period.kind === "month") return dateFmt(undefined, { month: "long", year: "numeric" }).format(start);
  const fmt = dateFmt(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt.format(start)} – ${fmt.format(new Date(`${period.until}T00:00:00Z`))}`;
}
