import { describe, expect, it } from "vitest";
import { isUnpriced, unpricedModelNames } from "@/screens/usage/pricing";
import type { ModelTotal } from "@/screens/usage/usageAggregate";

function model(modelName: string, total: number, costUsd: number, costKnown?: boolean): ModelTotal {
  return {
    modelName,
    tokens: { input: total, output: 0, cacheCreation: 0, cacheRead: 0, total },
    costUsd,
    ...(costKnown !== undefined ? { costKnown } : {}),
  };
}

describe("isUnpriced", () => {
  it("is true for a model with real tokens and a non-positive cost, costKnown absent", () => {
    expect(isUnpriced(model("claude-opus-5", 5_000, 0))).toBe(true);
  });

  it("is false for a model with no tokens at all", () => {
    expect(isUnpriced(model("dead-model", 0, 0))).toBe(false);
  });

  it("is false for a priced model", () => {
    expect(isUnpriced(model("claude-sonnet-5", 5_000, 4))).toBe(false);
  });

  // REVIEW-W1 #1: a backfilled-only model (`hub usage import-claude-stats`)
  // is 0-cost-filled with `costKnown: false` — a real cost gap, but one the
  // KPI's own "cost excludes N backfilled days" clause already explains.
  // `isUnpriced` must not layer a second, contradictory claim on top.
  it("is false for a backfilled-only model even though its cost is 0", () => {
    expect(isUnpriced(model("Unknown model", 900_000, 0, false))).toBe(false);
  });

  it("is true again once even one contributing day made the cost known", () => {
    expect(isUnpriced(model("claude-sonnet-5", 5_000, 0, true))).toBe(true);
  });
});

describe("unpricedModelNames", () => {
  it("excludes a backfilled-only model from the unpriced list", () => {
    const names = unpricedModelNames([
      model("claude-opus-5", 5_000, 0),
      model("Unknown model", 900_000, 0, false),
      model("claude-sonnet-5", 200, 4),
    ]);
    expect(names).toEqual(["claude-opus-5"]);
  });
});
