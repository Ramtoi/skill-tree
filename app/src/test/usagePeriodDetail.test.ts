import { describe, expect, it } from "vitest";
import type { UsageDailyPoint, UsageSessionRow } from "@/features/usage/usageTypes";
import { filterDailyByHarness, filterSessionsByHarness } from "@/screens/usage/usageAggregate";
import { usagePeriodDetail } from "@/screens/usage/usagePeriodDetail";
import { adjacentUsagePeriod, isUsageDayKey, periodFromKey } from "@/screens/usage/usagePeriod";
const dayPeriod = (key: string) => periodFromKey("day", key)!;
const adjacentUsageDay = (key: string, offset: number) => adjacentUsagePeriod(dayPeriod(key), offset).key;

const tokens = { input: 100, output: 20, cacheRead: 0, cacheCreation: 0, total: 120 };
const cost = { usd: 2, label: "Estimated API-equivalent cost" as const };
const day: UsageDailyPoint = {
  date: "2026-09-09", tokens, estimatedCost: cost,
  harnesses: [{ id: "codex", name: "Codex", tokens, estimatedCost: cost,
    models: [{ modelName: "gpt-6-astra", tokens, estimatedCost: cost }] }],
};
const session: UsageSessionRow = { id: "s", period: "s", harnessId: "codex", harnessName: "Codex", models: [],
  tokens: { ...tokens, total: 900 }, estimatedCost: { ...cost, usd: 9 },
  startedAt: "2026-09-08T22:00:00Z", lastActivity: "2026-09-10T01:30:00+02:00" };

describe("usage day detail", () => {
  it("uses Monday through Sunday across year boundaries and whole calendar months", () => {
    expect(periodFromKey("week", "2027-01-03")).toEqual({ kind: "week", key: "2026-12-28", since: "2026-12-28", until: "2027-01-03" });
    expect(adjacentUsagePeriod(periodFromKey("week", "2026-12-28")!, 1).since).toBe("2027-01-04");
    expect(periodFromKey("month", "2024-02")?.until).toBe("2024-02-29");
    expect(periodFromKey("month", "2026-02")?.until).toBe("2026-02-28");
    expect(adjacentUsagePeriod(periodFromKey("month", "2026-12")!, 1).key).toBe("2027-01");
    expect(adjacentUsagePeriod(periodFromKey("month", "2026-01")!, -1).key).toBe("2025-12");
    expect(periodFromKey("month", "2026-13")).toBeNull();
    expect(periodFromKey("week", "2026-02-30")).toBeNull();
  });
  it.each(["week", "month"] as const)("aggregates the entire %s with inclusive daily and UTC session boundaries", kind => {
    const period = periodFromKey(kind, kind === "week" ? "2026-09-09" : "2026-09")!;
    const before = adjacentUsagePeriod(dayPeriod(period.since), -1).key;
    const after = adjacentUsagePeriod(dayPeriod(period.until), 1).key;
    const dates = [before, period.since, period.until, after];
    const daily = dates.map(date => ({ ...day, date }));
    const sessions = dates.map(date => ({ ...session, id: date, lastActivity: `${date}T12:00:00Z` }));
    sessions.push({ ...session, id: "offset-in", lastActivity: `${period.since}T00:30:00+00:30` });
    sessions.push({ ...session, id: "offset-out", lastActivity: `${period.since}T00:30:00+01:00` });
    const result = usagePeriodDetail(period, daily, sessions);
    expect(result.tokens.total).toBe(240);
    expect(result.costUsd).toBe(4);
    expect(result.models[0].tokens.total).toBe(240);
    expect(result.sessions.map(row => row.id)).toEqual([period.since, period.until, "offset-in"]);
    expect(result.sessions[0].tokens.total).toBe(900);
  });
  it("rejects malformed and non-existent calendar dates for navigation", () => {
    for (const value of [null, "Unknown date", "2026-02-30", "2026-13-01", "2026-07-14T00:00:00Z"]) expect(isUsageDayKey(value)).toBe(false);
    expect(isUsageDayKey("2024-02-29")).toBe(true);
    expect(isUsageDayKey("2026-07-14")).toBe(true);
  });
  it("keeps UTC daily history separate from overnight whole-session totals", () => {
    const result = usagePeriodDetail(dayPeriod("2026-09-09"), [day], [session]);
    expect(result.tokens.total).toBe(120);
    expect(result.costUsd).toBe(2);
    expect(result.sessions).toEqual([session]);
    expect(usagePeriodDetail(dayPeriod("2026-09-08"), [day], [session]).sessions).toEqual([]);
    expect(usagePeriodDetail(dayPeriod("2026-09-10"), [day], [session]).sessions).toEqual([]);
  });
  it("uses start then period when last activity is absent, excluding undated ids", () => {
    const rows = [
      { ...session, id: "start", lastActivity: undefined, startedAt: "2026-09-09T10:00:00Z" },
      { ...session, id: "period", lastActivity: undefined, startedAt: undefined, period: "2026-09-09" },
      { ...session, id: "unknown", lastActivity: undefined, startedAt: undefined, period: "sess-12" },
    ];
    expect(usagePeriodDetail(dayPeriod("2026-09-09"), [day], rows).sessions.map(row => row.id)).toEqual(["start", "period"]);
  });
  it("does not leak another harness or a neighboring day's data", () => {
    const result = usagePeriodDetail(dayPeriod("2026-09-09"), filterDailyByHarness([day, { ...day, date: "2026-09-08" }], "claude"), filterSessionsByHarness([session], "claude"));
    expect(result.tokens.total).toBe(0);
    expect(result.models).toEqual([]);
    expect(result.sessions).toEqual([]);
  });
  it("distinguishes history-only unknown values and mixed partial cost", () => {
    const unknown = { ...day.harnesses[0], id: "claude", costKnown: false, splitKnown: false,
      estimatedCost: { ...cost, usd: 0 }, models: [{ modelName: "claude-opus-5", tokens, estimatedCost: { ...cost, usd: 0 }, costKnown: false }] };
    const backfill: UsageDailyPoint = { ...day, provenance: "backfilled", harnesses: [unknown] };
    const result = usagePeriodDetail(dayPeriod(day.date), [backfill], []);
    expect(result.costUnavailable).toBe(true);
    expect(result.splitUnavailable).toBe(true);
    expect(result.historyOnly).toBe(true);
    const mixed = usagePeriodDetail(dayPeriod(day.date), [{ ...day, harnesses: [...day.harnesses, unknown] }], []);
    expect(mixed.costUnavailable).toBe(false);
    expect(mixed.costPartial).toBe(true);
    expect(mixed.costUsd).toBe(2);
    const codex = usagePeriodDetail(dayPeriod(day.date), filterDailyByHarness([{ ...day, harnesses: [...day.harnesses, unknown] }], "codex"), []);
    expect(codex.costPartial).toBe(false);
    expect(codex.splitUnavailable).toBe(false);
  });
  it("advances UTC dates over month, year and DST boundaries", () => {
    expect(adjacentUsageDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(adjacentUsageDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(adjacentUsageDay("2024-02-28", 1)).toBe("2024-02-29");
  });
});
