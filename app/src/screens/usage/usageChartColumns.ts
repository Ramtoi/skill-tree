import type { Column } from "@/components/charts/StackedColumnChart";
import type { UsageDailyPoint, UsageDayProvenance } from "@/features/usage/usageTypes";
import { parseUsageDate } from "./usageAggregate";

export type ChartMeasure = "tokens" | "cost" | "sessions" | "tokensPerSession";

/** The Spend-over-time bucket size — `ChartBucket` because the KPI band's
 *  own "Range" (7d/30d/all) is a different axis (how much history is in
 *  scope) from this one (how that history is grouped into bars). */
export type ChartBucket = "day" | "week" | "month" | "year";

const MAX_DAILY_COLUMNS = 60;

// Monday-start ISO week key, computed in UTC (date-only "YYYY-MM-DD" strings
// parse as UTC midnight — using local getDay()/getDate() would misbucket by
// one day for negative-UTC-offset users).
function isoWeekStartUTC(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
  return monday.toISOString().slice(0, 10);
}

function monthKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function yearKeyUTC(d: Date): string {
  return String(d.getUTCFullYear());
}

function valueOf(
  point: { tokens: { total: number }; estimatedCost: { usd: number }; sessions?: number; sessionsKnown?: boolean },
  measure: ChartMeasure,
): number {
  if (measure === "cost") return point.estimatedCost.usd;
  if (measure === "sessions") return point.sessionsKnown === true ? point.sessions ?? 0 : 0;
  return point.tokens.total;
}

/** `Intl.DateTimeFormat` pinned to UTC, so a column's label/tooltip can never
 *  shift by a day depending on the viewer's machine timezone — the bucket
 *  keys above are all UTC-derived, and the formatter has to agree with them. */
export function dateFmt(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
}

/** Automatic all-time resolution follows the calendar span, including quiet days. */
export function defaultBucketFor(daily: readonly Pick<UsageDailyPoint, "date">[]): "day" | "week" | "month" {
  const dates = daily.map((point) => parseUsageDate(point.date)).filter((date): date is number => date !== undefined);
  const span = dates.length ? (Math.max(...dates) - Math.min(...dates)) / 86_400_000 + 1 : 0;
  return span <= MAX_DAILY_COLUMNS ? "day" : span <= 400 ? "week" : "month";
}

export function bucketKeyUTC(date: Date, bucket: ChartBucket): string {
  if (bucket === "day") return date.toISOString().slice(0, 10);
  if (bucket === "week") return isoWeekStartUTC(date);
  if (bucket === "month") return monthKeyUTC(date);
  return yearKeyUTC(date);
}

export function bucketLabel(key: string, bucket: ChartBucket, locale?: string): { label: string; tooltipLabel: string } {
  const date = new Date(`${key}${bucket === "month" ? "-01" : bucket === "year" ? "-01-01" : "T00:00:00Z"}`);
  if (bucket === "day") return { label: dateFmt(locale, { month: "short", day: "numeric" }).format(date), tooltipLabel: dateFmt(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date) };
  if (bucket === "week") return { label: dateFmt(locale, { month: "short", day: "numeric" }).format(date), tooltipLabel: `Week of ${dateFmt(locale, { month: "short", day: "numeric", year: "numeric" }).format(date)}` };
  if (bucket === "month") return { label: dateFmt(locale, { month: "short", year: "numeric" }).format(date), tooltipLabel: dateFmt(locale, { month: "long", year: "numeric" }).format(date) };
  return { label: key, tooltipLabel: key };
}

/**
 * Builds one `StackedColumnChart` column per `bucket` with one value per
 * detected harness — generalizing the original single-series
 * `buildChartBars` to a per-harness stack. Rows whose `date` doesn't parse
 * are dropped (they stay visible in the sessions list; they were never
 * chartable). The caller's `series` list (see `harnessOrderFromDaily` +
 * `orderHarnessIds`) decides which of a column's per-harness values
 * actually render — an id with no matching series is simply never drawn.
 *
 * Labels are short and locale-aware (`locale` defaults to the viewer's own,
 * `undefined`). Every bucket also marks a "you're here in the calendar"
 * boundary column — a month change for `day`, January for `month` — with
 * `labelEmphasis` (dimmer-but-visible ink) and `labelPinned` (survives the
 * chart's own label-thinning), so a long axis still reads without a tooltip.
 */
export function buildStackedColumns(
  daily: UsageDailyPoint[],
  measure: ChartMeasure,
  bucket: ChartBucket,
  locale?: string,
): { columns: Column[]; unavailableBuckets: number; partialBuckets: number } {
  // Shape-checked, like the range filter — `new Date()` on its own invents a
  // date out of an id-shaped value (see `parseUsageDate`), which would put a
  // phantom 2001 column on the axis.
  const valid = daily.filter((point) => parseUsageDate(point.date) !== undefined);

  function harnessValues(point: UsageDailyPoint): Record<string, number> {
    const values: Record<string, number> = {};
    for (const harness of point.harnesses) {
      values[harness.id] = (values[harness.id] ?? 0) + valueOf(harness, measure);
    }
    return values;
  }

  function sessionStatus(points: UsageDailyPoint[]) {
    const unknown = points.some((point) => point.sessionsKnown !== true);
    const tokens = points.reduce((sum, point) => sum + point.tokens.total, 0);
    const sessions = points.reduce((sum, point) => sum + (point.sessionsKnown === true ? point.sessions ?? 0 : 0), 0);
    return { unknown, tokens, sessions };
  }

  function sessionResult(columns: Column[], pointsForKey: (key: string) => UsageDailyPoint[]) {
    const ratio = columns.map((column) => {
      const status = sessionStatus(pointsForKey(column.key));
      const unavailable = status.tokens > 0 && (status.unknown || status.sessions <= 0);
      return {
        ...column,
        values: { aggregate: unavailable || status.sessions <= 0 ? 0 : status.tokens / status.sessions },
      };
    });
    return {
      columns: ratio,
      unavailableBuckets: ratio.filter((column) => {
        const status = sessionStatus(pointsForKey(column.key));
        return status.tokens > 0 && (status.unknown || status.sessions <= 0);
      }).length,
      partialBuckets: 0,
    };
  }

  if (bucket === "day") {
    const dayOnly = dateFmt(locale, { day: "numeric" });
    const monthDay = dateFmt(locale, { month: "short", day: "numeric" });
    const tooltipFmt = dateFmt(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    let prevMonth: number | undefined;
    const columns = valid.map((point) => {
      const date = new Date(parseUsageDate(point.date)!);
      const month = date.getUTCMonth();
      const isMonthMarker = prevMonth === undefined || month !== prevMonth;
      prevMonth = month;
      return {
        key: point.date,
        label: isMonthMarker ? monthDay.format(date) : dayOnly.format(date),
        tooltipLabel: tooltipFmt.format(date),
        labelEmphasis: isMonthMarker,
        labelPinned: isMonthMarker,
        values: harnessValues(point),
        provenance: point.provenance ?? "scanned",
      };
    });
    if (measure === "tokensPerSession") {
      return sessionResult(columns, (key) => valid.filter((point) => point.date === key));
    }
    return {
      columns,
      unavailableBuckets: 0,
      partialBuckets: measure === "sessions" ? columns.filter((column) => sessionStatus(valid.filter((point) => point.date === column.key)).unknown).length : 0,
    };
  }

  const keyOf = bucket === "week" ? isoWeekStartUTC : bucket === "month" ? monthKeyUTC : yearKeyUTC;
  const buckets = new Map<string, Record<string, number>>();
  const pointsByBucket = new Map<string, UsageDailyPoint[]>();
  // A bucket's provenance rolls up from every point inside it: "backfilled"
  // only when EVERY point is backfilled, "scanned" when ANY point is
  // scanned (a bucket with even one live-scanned day should not read as
  // faded/frozen), otherwise "frozen" (a mix of frozen and backfilled, or
  // all-frozen).
  const bucketAllBackfilled = new Map<string, boolean>();
  const bucketAnyScanned = new Map<string, boolean>();
  for (const point of valid) {
    const key = keyOf(new Date(parseUsageDate(point.date)!));
    const values = buckets.get(key) ?? {};
    for (const harness of point.harnesses) {
      values[harness.id] = (values[harness.id] ?? 0) + valueOf(harness, measure);
    }
    buckets.set(key, values);
    pointsByBucket.set(key, [...(pointsByBucket.get(key) ?? []), point]);
    const provenance = point.provenance ?? "scanned";
    bucketAllBackfilled.set(key, (bucketAllBackfilled.get(key) ?? true) && provenance === "backfilled");
    bucketAnyScanned.set(key, (bucketAnyScanned.get(key) ?? false) || provenance === "scanned");
  }
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));

  function bucketProvenance(key: string): UsageDayProvenance {
    if (bucketAllBackfilled.get(key)) return "backfilled";
    if (bucketAnyScanned.get(key)) return "scanned";
    return "frozen";
  }

  if (bucket === "week") {
    // A week's key is a full date (its Monday) — `new Date(key)` parses a
    // date-only "YYYY-MM-DD" string as UTC midnight.
    const monthDay = dateFmt(locale, { month: "short", day: "numeric" });
    const tooltipDate = dateFmt(locale, { month: "short", day: "numeric", year: "numeric" });
    const columns = sortedKeys.map((key) => {
      const date = new Date(key);
      return {
        key,
        label: monthDay.format(date),
        tooltipLabel: `Week of ${tooltipDate.format(date)}`,
        values: buckets.get(key)!,
        provenance: bucketProvenance(key),
      };
    });
    if (measure === "tokensPerSession") {
      return sessionResult(columns, (key) => pointsByBucket.get(key) ?? []);
    }
    return { columns, unavailableBuckets: 0, partialBuckets: measure === "sessions" ? sortedKeys.filter((key) => sessionStatus(pointsByBucket.get(key) ?? []).unknown).length : 0 };
  }

  if (bucket === "month") {
    // A month key is "YYYY-MM" — `new Date(key)` parses that ISO year-month
    // form as the 1st of the month, UTC.
    const monthShort = dateFmt(locale, { month: "short" });
    const monthYear = dateFmt(locale, { month: "short", year: "numeric" });
    const tooltipMonthYear = dateFmt(locale, { month: "long", year: "numeric" });
    const columns = sortedKeys.map((key, idx) => {
      const date = new Date(key);
      const isYearMarker = idx === 0 || date.getUTCMonth() === 0;
      return {
        key,
        label: isYearMarker ? monthYear.format(date) : monthShort.format(date),
        tooltipLabel: tooltipMonthYear.format(date),
        labelEmphasis: isYearMarker,
        labelPinned: isYearMarker,
        values: buckets.get(key)!,
        provenance: bucketProvenance(key),
      };
    });
    if (measure === "tokensPerSession") return sessionResult(columns, (key) => pointsByBucket.get(key) ?? []);
    return { columns, unavailableBuckets: 0, partialBuckets: measure === "sessions" ? sortedKeys.filter((key) => sessionStatus(pointsByBucket.get(key) ?? []).unknown).length : 0 };
  }

  // A year key is a bare "YYYY" — `new Date(key)` parses that as Jan 1, UTC.
  const yearFmt = dateFmt(locale, { year: "numeric" });
  const columns = sortedKeys.map((key) => {
    const label = yearFmt.format(new Date(key));
    return { key, label, tooltipLabel: label, values: buckets.get(key)!, provenance: bucketProvenance(key) };
  });
  if (measure === "tokensPerSession") return sessionResult(columns, (key) => pointsByBucket.get(key) ?? []);
  return { columns, unavailableBuckets: 0, partialBuckets: measure === "sessions" ? sortedKeys.filter((key) => sessionStatus(pointsByBucket.get(key) ?? []).unknown).length : 0 };
}

/** Every distinct harness id appearing across `daily`'s per-harness rows,
 *  in first-seen order (the caller reorders via `orderHarnessIds`). */
export function harnessOrderFromDaily(daily: UsageDailyPoint[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const point of daily) {
    for (const harness of point.harnesses) {
      if (!seen.has(harness.id)) {
        seen.add(harness.id);
        order.push(harness.id);
      }
    }
  }
  return order;
}
