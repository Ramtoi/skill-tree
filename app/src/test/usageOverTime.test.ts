import { describe, expect, it, vi } from "vitest";
import timeline from "../../../tests/fixtures/usage/timeline.json";
import type { UsageTimelinePayload } from "@/features/usage/usageAnalyticsTypes";
import type { UsageHistoryDay } from "@/features/usage/usageTypes";
import { OTHER_SERIES_COLOR } from "@/components/charts/chartColors";
import { buildActivitySeries, buildModelMix, OTHER_ID, scopeHistoryDays } from "@/screens/usage/usageOverTime";

const timelinePayload = timeline as unknown as UsageTimelinePayload;

describe("usage over-time models", () => {
  it("builds daily activity series and preserves the fixture counts", () => {
    const series = buildActivitySeries(timelinePayload.days, "day", "skills");
    expect(series[0].id).toBe("brainstorm");
    expect(series[0].points.reduce((sum, point) => sum + point.y, 0)).toBe(2);
  });

  it.each(["skills", "tools"] as const)("shows quiet dates between %s events instead of connecting distant active days", (kind) => {
    const days = [
      { date: "2026-09-10", skills: { alpha: 4 }, tools: { alpha: 4 } },
      { date: "2026-09-12", skills: { alpha: 2 }, tools: { alpha: 2 } },
    ];
    expect(buildActivitySeries(days, "day", kind)[0].points).toEqual([
      { x: "2026-09-10", y: 4 }, { x: "2026-09-11", y: 0 }, { x: "2026-09-12", y: 2 },
    ]);
  });

  it("includes quiet days at both ends of the selected window", () => {
    const days = [{ date: "2026-09-11", skills: { alpha: 4 }, tools: {} }];
    expect(buildActivitySeries(days, "day", "skills", undefined, { since: "2026-09-10", until: "2026-09-12" })[0].points).toEqual([
      { x: "2026-09-10", y: 0 }, { x: "2026-09-11", y: 4 }, { x: "2026-09-12", y: 0 },
    ]);
  });

  it.each([
    ["week", "2025-12-29", "2026-01-05", "2026-01-12"],
    ["month", "2025-12", "2026-01", "2026-02"],
    ["year", "2024", "2025", "2026"],
  ] as const)("includes empty %s buckets across calendar boundaries", (bucket, first, middle, last) => {
    const dates = bucket === "week" ? ["2025-12-31", "2026-01-13"] : bucket === "month" ? ["2025-12-31", "2026-02-01"] : ["2024-12-31", "2026-01-01"];
    const days = dates.map((date) => ({ date, skills: { alpha: 2 }, tools: {} }));
    expect(buildActivitySeries(days, bucket, "skills")[0].points).toEqual([
      { x: first, y: 2 }, { x: middle, y: 0 }, { x: last, y: 2 },
    ]);
  });

  it("folds all-time activity into ISO weeks", () => {
    const series = buildActivitySeries(timelinePayload.days, "week", "tools");
    expect(series[0].points.map((point) => point.x)).toEqual(["2026-08-31", "2026-09-07"]);
  });

  it("folds activity into month and year buckets", () => {
    const days = timelinePayload.days.slice(0, 4);
    expect(buildActivitySeries(days, "month", "tools")[0].points[0].x).toMatch(/^2026-09$/);
    expect(buildActivitySeries(days, "year", "tools")[0].points[0].x).toMatch(/^2026$/);
  });

  it("keeps eight named activity series colorful when the ninth folds into Other", () => {
    const days = [{
      date: "2026-09-07",
      skills: {},
      tools: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`tool-${index}`, 9 - index])),
    }] as never[];
    const series = buildActivitySeries(days, "day", "tools");
    const named = series.filter((item) => item.id !== OTHER_ID);
    expect(named).toHaveLength(8);
    expect(new Set(named.map((item) => item.color)).size).toBe(8);
    expect(named.map((item) => item.color)).not.toContain(OTHER_SERIES_COLOR);
    expect(series.find((item) => item.id === OTHER_ID)?.color).toBe(OTHER_SERIES_COLOR);
  });

  it("builds one model-mix column per day when bucketed by day", () => {
    const model = { model: "opus", costUsd: 1, costKnown: true, tokens: {} as never };
    const days = [
      { date: "2026-09-07", agents: [{ agent: "claude", models: [model] }] },
      { date: "2026-09-08", agents: [{ agent: "claude", models: [model] }] },
    ] as never[];
    expect(buildModelMix(days, null, "day").columns).toHaveLength(2);
  });

  it("omits unknown-cost weeks and ranks known models", () => {
    const day = {
      date: "2026-09-07", agents: [{ agent: "claude", models: [{ model: "opus", costUsd: 2, costKnown: true, tokens: {} as never }] }],
    } as never;
    const unknown = {
      date: "2026-09-14", agents: [{ agent: "claude", models: [{ model: "sonnet", costUsd: 0, costKnown: false, tokens: {} as never }] }],
    } as never;
    const result = buildModelMix([day], null);
    expect(result.models).toEqual(["opus"]);
    expect(result.columns).toHaveLength(1);
    expect(buildModelMix([unknown], null).unknownBuckets).toBe(1);
  });

  it("scopes model history to the selected range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    try {
      const days = [{ date: "2026-08-01" }, { date: "2026-09-07" }] as never[];
      expect(scopeHistoryDays(days, "7d")).toHaveLength(1);
      expect(scopeHistoryDays(days, "all")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses inclusive UTC range bounds for 90 days and one year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const days = [
      { date: "2026-06-12" }, // exactly 89 days ago
      { date: "2026-06-11" }, // 90 days ago
      { date: "2025-09-10" }, // exactly 364 days ago
      { date: "2025-09-09" }, // 365 days ago
    ] as UsageHistoryDay[];
    expect(scopeHistoryDays(days, "90d")).toHaveLength(1);
    expect(scopeHistoryDays(days, "1y")).toHaveLength(3);
    vi.useRealTimers();
  });
});
