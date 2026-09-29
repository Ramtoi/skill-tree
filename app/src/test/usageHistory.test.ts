import { describe, expect, it } from "vitest";
import { normalizeUsageHistory } from "@/features/usage/normalizeUsage";
import { scopeFromDaily } from "@/screens/usage/usageAggregate";
import type { UsageHistoryPayload } from "@/features/usage/usageTypes";

function basePayload(overrides: Partial<UsageHistoryPayload> = {}): UsageHistoryPayload {
  return {
    schema_version: 1,
    generated_at: "2026-09-04T12:00:00Z",
    horizon: "2026-08-21",
    since: null,
    until: null,
    days: [],
    counts: { days: 0, rows: 0, backfilled_days: 0, frozen_days: 0, scanned_days: 0 },
    claude_stats: { available: false, path: "~/.claude/stats-cache.json", importable_days: 0, last_computed: null },
    warnings: [],
    ...overrides,
  };
}

describe("normalizeUsageHistory", () => {
  it("keeps Claude and Codex agent rows separate through the breakdown scope", () => {
    const claudeTokens = { input: 700, output: 300, cacheCreation: 0, cacheRead: 0, total: 1000 };
    const codexTokens = { input: 350, output: 150, cacheCreation: 0, cacheRead: 0, total: 500 };
    const payload = basePayload({
      days: [{
        date: "2026-08-14", provenance: "scanned", tokens: { ...claudeTokens, total: 1500 },
        costUsd: 1.5, costKnown: true, splitKnown: true,
        agents: [
          { agent: "claude", name: "Claude Code", provenance: "scanned", source: "ccusage", tokens: claudeTokens, costUsd: 1, costKnown: true, splitKnown: true, models: [] },
          { agent: "codex", name: "Codex", provenance: "scanned", source: "ccusage", tokens: codexTokens, costUsd: 0.5, costKnown: true, splitKnown: true, models: [] },
        ],
      }],
    });
    const scoped = scopeFromDaily(normalizeUsageHistory(payload));
    expect(scoped.harnesses.find((h) => h.id === "codex")).toMatchObject({ tokens: { total: 500 }, costUsd: 0.5 });
  });
  it("maps a payload to UsageDailyPoint[] carrying provenance, costKnown and splitKnown", () => {
    const payload = basePayload({
      days: [
        {
          date: "2026-08-14",
          provenance: "frozen",
          tokens: { input: 12_000, output: 3_400, cacheCreation: 500, cacheRead: 88_000, total: 103_900 },
          costUsd: 0.42,
          costKnown: true,
          splitKnown: true,
          agents: [
            {
              agent: "claude",
              name: "Claude Code",
              provenance: "frozen",
              source: "ccusage",
              tokens: { input: 12_000, output: 3_400, cacheCreation: 500, cacheRead: 88_000, total: 103_900 },
              costUsd: 0.42,
              costKnown: true,
              splitKnown: true,
              models: [
                {
                  model: "claude-sonnet-4-5",
                  tokens: { input: 12_000, output: 3_400, cacheCreation: 500, cacheRead: 88_000, total: 103_900 },
                  costUsd: 0.42,
                  costKnown: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const [point] = normalizeUsageHistory(payload);
    expect(point.date).toBe("2026-08-14");
    expect(point.provenance).toBe("frozen");
    expect(point.costKnown).toBe(true);
    expect(point.splitKnown).toBe(true);
    expect(point.tokens.total).toBe(103_900);
    expect(point.estimatedCost.usd).toBe(0.42);
    expect(point.harnesses).toHaveLength(1);
    const [harness] = point.harnesses;
    expect(harness.id).toBe("claude");
    expect(harness.name).toBe("Claude Code");
    expect(harness.costKnown).toBe(true);
    expect(harness.splitKnown).toBe(true);
    expect(harness.models).toEqual([
      {
        modelName: "claude-sonnet-4-5",
        tokens: { input: 12_000, output: 3_400, cacheCreation: 500, cacheRead: 88_000, total: 103_900 },
        estimatedCost: { usd: 0.42, label: "Estimated API-equivalent cost" },
        // REVIEW-W1 #1: threaded through so `isUnpriced` can tell a
        // backfilled-only $0 apart from a real, priced $0.
        costKnown: true,
      },
    ]);
  });

  it("sorts the returned points by date ascending regardless of input order", () => {
    const payload = basePayload({
      days: [
        {
          date: "2026-08-14",
          provenance: "scanned",
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 10 },
          costUsd: 0,
          costKnown: true,
          splitKnown: true,
          agents: [],
        },
        {
          date: "2026-06-01",
          provenance: "backfilled",
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 5 },
          costUsd: 0,
          costKnown: false,
          splitKnown: false,
          agents: [],
        },
      ],
    });
    const points = normalizeUsageHistory(payload);
    expect(points.map((p) => p.date)).toEqual(["2026-06-01", "2026-08-14"]);
  });

  it("carries a backfilled day's remainder (model: null) row into the per-model breakdown", () => {
    const payload = basePayload({
      days: [
        {
          date: "2026-05-20",
          provenance: "backfilled",
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 42_000 },
          costUsd: 0,
          costKnown: false,
          splitKnown: false,
          agents: [
            {
              agent: "claude",
              name: "Claude Code",
              provenance: "backfilled",
              source: "claude-stats-cache",
              tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 42_000 },
              costUsd: 0,
              costKnown: false,
              splitKnown: false,
              models: [
                {
                  model: null,
                  tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 42_000 },
                  costUsd: 0,
                  costKnown: false,
                },
              ],
            },
          ],
        },
      ],
    });
    const [point] = normalizeUsageHistory(payload);
    expect(point.provenance).toBe("backfilled");
    expect(point.costKnown).toBe(false);
    expect(point.splitKnown).toBe(false);
    expect(point.harnesses[0].models).toHaveLength(1);
    expect(point.harnesses[0].models![0].tokens.total).toBe(42_000);
    // A null-model remainder row still carries its real tokens under a
    // stand-in name — it must never silently vanish from the Top Models card.
    expect(point.harnesses[0].models![0].modelName).toBe("Unknown model");
  });

  it("tolerates a missing agents array without throwing", () => {
    const payload = basePayload({
      days: [
        {
          date: "2026-07-01",
          provenance: "scanned",
          tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0, total: 2 },
          costUsd: 0.01,
          costKnown: true,
          splitKnown: true,
          // @ts-expect-error — deliberately malformed, mirrors a hand-edited payload
          agents: undefined,
        },
      ],
    });
    expect(() => normalizeUsageHistory(payload)).not.toThrow();
    const [point] = normalizeUsageHistory(payload);
    expect(point.harnesses).toEqual([]);
  });

  it("tolerates a malformed days array (not an array at all)", () => {
    const malformed = { ...basePayload(), days: "garbage" } as unknown as UsageHistoryPayload;
    expect(normalizeUsageHistory(malformed)).toEqual([]);
  });
});
