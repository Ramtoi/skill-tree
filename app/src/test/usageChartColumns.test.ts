import { describe, expect, it } from "vitest";
import type { UsageDailyPoint, UsageDayProvenance } from "@/features/usage/usageTypes";
import { buildStackedColumns, bucketKeyUTC, bucketLabel, defaultBucketFor } from "@/screens/usage/usageChartColumns";

// The formatters all pin `timeZone: "UTC"` themselves — a bucket key is
// always UTC-derived — so a column's label can never shift by a day
// depending on the machine's own zone. Pinning the machine to a
// negative-UTC-offset zone here is what would catch a formatter that forgot
// to pass `timeZone`.
process.env.TZ = "America/Los_Angeles";

function point(date: string, tokens = 100, provenance?: UsageDayProvenance, sessions?: number, sessionsKnown?: boolean): UsageDailyPoint {
  return {
    date,
    ...(sessions !== undefined ? { sessions, sessionsKnown } : {}),
    ...(provenance ? { provenance } : {}),
    harnesses: [
      {
        id: "claude",
        name: "Claude Code",
        tokens: { input: tokens, output: 0, cacheCreation: 0, cacheRead: 0, total: tokens },
        estimatedCost: { usd: tokens / 100, label: "Estimated API-equivalent cost" },
        ...(sessions !== undefined ? { sessions, sessionsKnown } : {}),
      },
    ],
    tokens: { input: tokens, output: 0, cacheCreation: 0, cacheRead: 0, total: tokens },
    estimatedCost: { usd: tokens / 100, label: "Estimated API-equivalent cost" },
  };
}

/** One row per day across two full calendar years (2025-01-01..2026-12-31),
 *  UTC dates so the ISO-week/month/year bucketing is deterministic. */
function twoYearFixture(): UsageDailyPoint[] {
  const days: UsageDailyPoint[] = [];
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2026, 11, 31);
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(point(new Date(t).toISOString().slice(0, 10)));
  }
  return days;
}

function daysFrom(startIso: string, count: number): UsageDailyPoint[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => point(new Date(start + i * 86_400_000).toISOString().slice(0, 10)));
}

describe("defaultBucketFor", () => {
  it("uses elapsed days for sparse history", () => {
    expect(defaultBucketFor([point("2026-01-01"), point("2026-04-01")])).toBe("week");
    expect(defaultBucketFor([point("2024-01-01"), point("2026-04-01")])).toBe("month");
  });
  it("defaults to day at or under 60 valid points", () => {
    expect(defaultBucketFor(daysFrom("2026-01-01", 60))).toBe("day");
  });

  it("defaults to week just past 60 valid points", () => {
    expect(defaultBucketFor(daysFrom("2026-01-01", 61))).toBe("week");
  });

  it("uses month only beyond 400 valid points", () => {
    expect(defaultBucketFor(daysFrom("2026-01-01", 400))).toBe("week");
    expect(defaultBucketFor(daysFrom("2025-01-01", 401))).toBe("month");
  });

  it("keys and labels UTC buckets consistently", () => {
    const date = new Date("2026-03-18T12:00:00Z");
    expect(bucketKeyUTC(date, "week")).toBe("2026-03-16");
    expect(bucketKeyUTC(date, "month")).toBe("2026-03");
    expect(bucketKeyUTC(date, "year")).toBe("2026");
    expect(bucketLabel("2026-03-16", "week", "en-US").tooltipLabel).toBe("Week of Mar 16, 2026");
  });

  it("defaults to week past 60 valid points", () => {
    const daily = twoYearFixture();
    expect(defaultBucketFor(daily)).toBe("month");
  });

  it("ignores unparseable-date rows when counting", () => {
    const daily = [...Array.from({ length: 10 }, (_, i) => point(`2026-01-${String(i + 1).padStart(2, "0")}`)), point("not-a-date")];
    expect(defaultBucketFor(daily)).toBe("day");
  });
});

describe("buildStackedColumns", () => {
  const daily = twoYearFixture(); // 730 days across 2025-2026

  it("day: one column per row, short calendar label, full-date tooltip", () => {
    const { columns } = buildStackedColumns(daily, "tokens", "day", "en-US");
    expect(columns).toHaveLength(730);
    // First column is always a month marker.
    expect(columns[0]).toMatchObject({
      key: "2025-01-01",
      label: "Jan 1",
      tooltipLabel: "Wed, Jan 1, 2025",
      labelEmphasis: true,
      labelPinned: true,
    });
  });

  it("week: buckets into ISO (Monday-start, UTC) weeks", () => {
    const { columns } = buildStackedColumns(daily, "tokens", "week", "en-US");
    // 730 days from 2025-01-01 to 2026-12-31 (both non-leap years) touch
    // exactly 105 distinct ISO (Monday-start, UTC) weeks.
    expect(columns).toHaveLength(105);
    for (const col of columns) {
      expect(col.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
      expect(col.tooltipLabel).toMatch(/^Week of [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    }
    // Every value in the bucket is summed, not just carried from one day.
    const total = columns.reduce(
      (sum, col) => sum + Object.values(col.values).reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(730 * 100);
  });

  it("month: buckets into calendar months, short label, long tooltip", () => {
    const { columns } = buildStackedColumns(daily, "tokens", "month", "en-US");
    expect(columns).toHaveLength(24); // 12 months × 2 years
    // First column is always a year marker.
    expect(columns[0]).toMatchObject({
      key: "2025-01",
      label: "Jan 2025",
      tooltipLabel: "January 2025",
      labelEmphasis: true,
      labelPinned: true,
    });
    expect(columns[23]).toMatchObject({ key: "2026-12", label: "Dec", tooltipLabel: "December 2026" });
  });

  it("year: buckets into calendar years, YYYY label and tooltip", () => {
    const { columns } = buildStackedColumns(daily, "tokens", "year");
    expect(columns).toHaveLength(2);
    expect(columns[0]).toMatchObject({ key: "2025", label: "2025", tooltipLabel: "2025" });
    expect(columns[1]).toMatchObject({ key: "2026", label: "2026", tooltipLabel: "2026" });
  });

  it("sorts columns chronologically regardless of bucket", () => {
    const { columns } = buildStackedColumns(daily, "tokens", "month");
    const keys = columns.map((c) => c.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("drops rows whose date does not parse", () => {
    const withBad = [...daily.slice(0, 5), point("Unknown date")];
    const { columns } = buildStackedColumns(withBad, "tokens", "day");
    expect(columns).toHaveLength(5);
  });
});

// ─── Adversarial edge sweep (review round) ────────────────────────────────

describe("bucketing is timezone-independent", () => {
  // Every key is derived with `getUTC*` from a UTC-midnight parse, so a
  // machine in a DST-shifting zone can never move a point into the previous
  // day's week or month. 2026-03-29 is the European DST-start Sunday AND the
  // last day of an ISO week that started in the previous month.
  const dstSunday = point("2026-03-29");

  it("puts a DST-boundary Sunday in the ISO week that started the previous Monday", () => {
    const { columns } = buildStackedColumns([dstSunday], "tokens", "week", "en-US");
    expect(columns).toHaveLength(1);
    expect(columns[0].key).toBe("2026-03-23");
    expect(columns[0].tooltipLabel).toBe("Week of Mar 23, 2026");
  });

  it("labels a week that starts in the previous month with the Monday's own month + day", () => {
    // 2026-03-30 (Mon) .. 2026-04-05 (Sun) — the label is "Mar 30" even for
    // the April days in the same bucket.
    const week = [point("2026-03-30"), point("2026-04-02"), point("2026-04-05")];
    const { columns } = buildStackedColumns(week, "tokens", "week", "en-US");
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ key: "2026-03-30", label: "Mar 30" });
  });

  it("keeps a DST-boundary day in its own calendar month and year", () => {
    expect(buildStackedColumns([dstSunday], "tokens", "month").columns[0].key).toBe("2026-03");
    expect(buildStackedColumns([dstSunday], "tokens", "year").columns[0].key).toBe("2026");
  });

  it("a New-Year's-Eve point never leaks into the next year", () => {
    const eve = [point("2025-12-31"), point("2026-01-01")];
    expect(buildStackedColumns(eve, "tokens", "year").columns.map((c) => c.key)).toEqual([
      "2025",
      "2026",
    ]);
  });
});

describe("an explicit bucket wins over the default rule", () => {
  it("day over a two-year range yields one column per day (no implicit weekly cap)", () => {
    // The pre-toggle code capped at 60 columns; the pick is now the user's.
    const daily = twoYearFixture();
    expect(defaultBucketFor(daily)).toBe("month");
    expect(buildStackedColumns(daily, "tokens", "day").columns).toHaveLength(730);
  });

  it("week over a three-day range still yields one column", () => {
    const daily = daysFrom("2026-07-13", 3); // Mon..Wed, one ISO week
    expect(defaultBucketFor(daily)).toBe("day");
    expect(buildStackedColumns(daily, "tokens", "week").columns).toHaveLength(1);
  });
});

describe("the cost measure sums the same buckets as tokens", () => {
  it("month totals are the sum of each day's cost", () => {
    const daily = daysFrom("2026-05-01", 31); // point(): usd = tokens / 100 = 1
    const { columns } = buildStackedColumns(daily, "cost", "month");
    expect(columns).toHaveLength(1);
    expect(columns[0].values.claude).toBeCloseTo(31, 6);
  });
});

describe("session measures", () => {
  it("stacks known sessions and computes one aggregate tokens/session series", () => {
    const daily = [point("2026-05-01", 100, undefined, 2, true), point("2026-05-02", 90, undefined, 0, true)];
    expect(buildStackedColumns(daily, "sessions", "day").columns.map((c) => c.values.claude)).toEqual([2, 0]);
    const ratio = buildStackedColumns(daily, "tokensPerSession", "week");
    expect(ratio.columns).toHaveLength(1);
    expect(ratio.columns[0].values.aggregate).toBe(95);
    expect(ratio.unavailableBuckets).toBe(0);
  });

  it("marks a token bucket with no known sessions unavailable without dividing", () => {
    const ratio = buildStackedColumns([point("2026-05-01", 100)], "tokensPerSession", "day");
    expect(ratio.columns[0].values.aggregate).toBe(0);
    expect(ratio.unavailableBuckets).toBe(1);
  });

  it("computes tokens per session through the same aggregate path at every grain", () => {
    const daily = [
      point("2025-01-01", 100, undefined, 2, true),
      point("2025-01-02", 300, undefined, 3, true),
      point("2025-02-01", 500, undefined, 5, true),
      point("2026-01-01", 700, undefined, 7, true),
    ];
    expect(buildStackedColumns(daily, "tokensPerSession", "day").columns.map((c) => c.values.aggregate)).toEqual([50, 100, 100, 100]);
    expect(buildStackedColumns(daily, "tokensPerSession", "week").columns.map((c) => c.values.aggregate)).toEqual([80, 100, 100]);
    expect(buildStackedColumns(daily, "tokensPerSession", "month").columns.map((c) => c.values.aggregate)).toEqual([80, 100, 100]);
    expect(buildStackedColumns(daily, "tokensPerSession", "year").columns.map((c) => c.values.aggregate)).toEqual([90, 100]);
  });

  it("makes a ratio bucket unavailable when positive tokens have unknown sessions", () => {
    const daily = [point("2026-05-04", 100, undefined, 2, true), point("2026-05-05", 900)];
    const ratio = buildStackedColumns(daily, "tokensPerSession", "week");
    expect(ratio.columns[0].values.aggregate).toBe(0);
    expect(ratio.unavailableBuckets).toBe(1);
  });

  it("counts session buckets with unknown days as partial at day, week, and month grain", () => {
    const daily = [point("2026-05-01", 100, undefined, 2, true), point("2026-05-02", 100)];
    expect(buildStackedColumns(daily, "sessions", "day").partialBuckets).toBe(1);
    expect(buildStackedColumns(daily, "sessions", "week").partialBuckets).toBe(1);
    expect(buildStackedColumns(daily, "sessions", "month").partialBuckets).toBe(1);
    expect(buildStackedColumns(daily, "sessions", "week").columns[0].values.claude).toBe(2);
  });
});

// ─── Short, readable labels (exact `en-US` strings) ────────────────────────

describe("day labels: short, with a month marker on the first column and every month change", () => {
  // June → July → August, so a marker fires mid-fixture as well as at the
  // start.
  const juneToAugust = [
    "2026-06-29",
    "2026-06-30",
    "2026-07-01",
    "2026-07-02",
    "2026-07-14",
    "2026-07-31",
    "2026-08-01",
  ].map((d) => point(d));

  it("labels every column, marking the first and each month change", () => {
    const { columns } = buildStackedColumns(juneToAugust, "tokens", "day", "en-US");
    expect(columns.map((c) => c.label)).toEqual(["Jun 29", "30", "Jul 1", "2", "14", "31", "Aug 1"]);
    expect(columns.map((c) => c.labelEmphasis ?? false)).toEqual([
      true, // first column
      false,
      true, // Jun → Jul
      false,
      false,
      false,
      true, // Jul → Aug
    ]);
    // A marker is always pinned so it survives thinning; a plain day never is.
    expect(columns.map((c) => c.labelPinned ?? false)).toEqual(columns.map((c) => c.labelEmphasis ?? false));
  });

  it("gives the tooltip the full weekday, month, day, and year", () => {
    const { columns } = buildStackedColumns(juneToAugust, "tokens", "day", "en-US");
    expect(columns.map((c) => c.tooltipLabel)).toEqual([
      "Mon, Jun 29, 2026",
      "Tue, Jun 30, 2026",
      "Wed, Jul 1, 2026",
      "Thu, Jul 2, 2026",
      "Tue, Jul 14, 2026",
      "Fri, Jul 31, 2026",
      "Sat, Aug 1, 2026",
    ]);
  });

  it("labels a 2026-07-01 point 'Jul 1' regardless of the machine's own timezone", () => {
    // `process.env.TZ` is pinned to America/Los_Angeles at the top of this
    // file — every formatter passes `timeZone: "UTC"` itself, so the label
    // can never slip a day for a negative-UTC-offset machine.
    const { columns } = buildStackedColumns([point("2026-07-01")], "tokens", "day", "en-US");
    expect(columns[0].label).toBe("Jul 1");
  });

  it("a year boundary is still just a month change — Dec 31 to Jan 1 both mark", () => {
    const eve = [point("2025-12-30"), point("2025-12-31"), point("2026-01-01")];
    const { columns } = buildStackedColumns(eve, "tokens", "day", "en-US");
    expect(columns.map((c) => c.label)).toEqual(["Dec 30", "31", "Jan 1"]);
    expect(columns.map((c) => c.labelEmphasis ?? false)).toEqual([true, false, true]);
  });
});

describe("week labels: month + day of the Monday", () => {
  it("labels the Monday and tooltips 'Week of …'", () => {
    const week = daysFrom("2026-07-13", 3); // Mon 2026-07-13 .. Wed
    const { columns } = buildStackedColumns(week, "tokens", "week", "en-US");
    expect(columns).toEqual([
      expect.objectContaining({ label: "Jul 13", tooltipLabel: "Week of Jul 13, 2026" }),
    ]);
  });
});

describe("month labels: short month, with a year marker on the first column and every January", () => {
  // November 2025 → February 2026, so a January marker fires mid-fixture as
  // well as the fixture-opening November marking as "first column".
  const decToJan = ["2025-11-01", "2025-12-15", "2026-01-05", "2026-02-20"].map((d) => point(d));

  it("labels every column, marking the first and each January", () => {
    const { columns } = buildStackedColumns(decToJan, "tokens", "month", "en-US");
    expect(columns.map((c) => c.label)).toEqual(["Nov 2025", "Dec", "Jan 2026", "Feb"]);
    expect(columns.map((c) => c.labelEmphasis ?? false)).toEqual([true, false, true, false]);
    expect(columns.map((c) => c.labelPinned ?? false)).toEqual(columns.map((c) => c.labelEmphasis ?? false));
  });

  it("gives the tooltip the full month name and year", () => {
    const { columns } = buildStackedColumns(decToJan, "tokens", "month", "en-US");
    expect(columns.map((c) => c.tooltipLabel)).toEqual([
      "November 2025",
      "December 2025",
      "January 2026",
      "February 2026",
    ]);
  });
});

describe("year labels: the bare year, same for label and tooltip", () => {
  it("never marks a year column — every year is already distinct", () => {
    const eve = [point("2025-12-31"), point("2026-01-01")];
    const { columns } = buildStackedColumns(eve, "tokens", "year", "en-US");
    expect(columns).toEqual([
      { key: "2025", label: "2025", tooltipLabel: "2025", values: { claude: 100 }, provenance: "scanned" },
      { key: "2026", label: "2026", tooltipLabel: "2026", values: { claude: 100 }, provenance: "scanned" },
    ]);
  });
});

describe("thinning keeps pinned (calendar-marker) labels", () => {
  it("every emphasis/pinned column survives the chart's own label-thinning step", () => {
    // A day-bucketed range wide enough to cross several months, so the
    // component's own `labelStep = ceil(n/12)` thinning (see
    // StackedColumnChart's LABEL_THIN_THRESHOLD) would otherwise skip most
    // month markers.
    const daily = daysFrom("2026-01-01", 200); // Jan .. Jul 2026
    const { columns } = buildStackedColumns(daily, "tokens", "day", "en-US");
    const markerIndices = columns
      .map((c, i) => (c.labelPinned ? i : -1))
      .filter((i) => i >= 0);
    expect(markerIndices.length).toBeGreaterThan(1); // several month boundaries in 200 days

    const labelStep = columns.length > 24 ? Math.ceil(columns.length / 12) : 1;
    // At least one marker would have been thinned away by the step alone —
    // that's the case this test exists to cover.
    expect(markerIndices.some((i) => i % labelStep !== 0)).toBe(true);
    // But every marker still renders once `labelPinned` overrides the step
    // (the same `idx % labelStep === 0 || col.labelPinned` the component uses).
    for (const i of markerIndices) {
      expect(i % labelStep === 0 || columns[i].labelPinned).toBe(true);
    }
  });
});

describe("provenance", () => {
  it("day bucket: a column copies its point's own provenance, defaulting to scanned", () => {
    const daily = [
      point("2026-06-01", 100, "backfilled"),
      point("2026-06-02", 100, "frozen"),
      point("2026-06-03", 100, "scanned"),
      point("2026-06-04", 100), // no provenance set at all
    ];
    const { columns } = buildStackedColumns(daily, "tokens", "day");
    expect(columns.map((c) => c.provenance)).toEqual(["backfilled", "frozen", "scanned", "scanned"]);
  });

  it("week/month/year rollup: backfilled only when EVERY point in the bucket is backfilled", () => {
    // Both days land in the same ISO week (Mon 2026-06-01 .. Sun 2026-06-07).
    const allBackfilled = [point("2026-06-02", 100, "backfilled"), point("2026-06-03", 100, "backfilled")];
    const { columns } = buildStackedColumns(allBackfilled, "tokens", "week");
    expect(columns).toHaveLength(1);
    expect(columns[0].provenance).toBe("backfilled");
  });

  it("week/month/year rollup: scanned when ANY point in the bucket is scanned", () => {
    const mixed = [
      point("2026-06-02", 100, "backfilled"),
      point("2026-06-03", 100, "frozen"),
      point("2026-06-04", 100, "scanned"),
    ];
    const { columns } = buildStackedColumns(mixed, "tokens", "week");
    expect(columns).toHaveLength(1);
    expect(columns[0].provenance).toBe("scanned");
  });

  it("week/month/year rollup: frozen when the bucket mixes frozen and backfilled but no scanned", () => {
    const mixed = [point("2026-06-02", 100, "backfilled"), point("2026-06-03", 100, "frozen")];
    const { columns } = buildStackedColumns(mixed, "tokens", "week");
    expect(columns).toHaveLength(1);
    expect(columns[0].provenance).toBe("frozen");
  });

  it("week/month/year rollup: frozen for an all-frozen bucket", () => {
    const allFrozen = [point("2026-06-02", 100, "frozen"), point("2026-06-03", 100, "frozen")];
    const { columns } = buildStackedColumns(allFrozen, "tokens", "week");
    expect(columns).toHaveLength(1);
    expect(columns[0].provenance).toBe("frozen");
  });
});
