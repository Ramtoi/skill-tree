import { describe, expect, it } from "vitest";
import { compositionPercents } from "@/components/charts/compositionPercents";

describe("compositionPercents", () => {
  it("never prints 0% for a non-zero segment", () => {
    // The 1.3B-cache-read shape this rule exists for: a real, non-zero
    // input segment must never round down to the same "0%" a truly empty
    // segment reads.
    const values = [1_300_000_000, 21_200, 22_900_000, 1_700_000];
    const total = values.reduce((a, b) => a + b, 0);
    const percents = compositionPercents(values, total);
    expect(percents).toEqual(["98%", "<0.1%", "2%", "0.1%"]);
    percents.forEach((pct, i) => {
      if (values[i] > 0) expect(pct).not.toBe("0%");
    });
  });

  it("prints <0.1% for a share under a twentieth of a percent", () => {
    // 400 / 1_000_000 = 0.04% — under formatPercent's 0.05% floor.
    const percents = compositionPercents([400, 999_600], 1_000_000);
    expect(percents[0]).toBe("<0.1%");
  });

  it("whole-number shares still account for the remainder", () => {
    // Three equal thirds independently rounded print 33/33/33 = 99%.
    const percents = compositionPercents([1, 1, 1], 3);
    const sum = percents.reduce((sum, p) => sum + Number(p.replace("%", "")), 0);
    expect(sum).toBe(100);
    expect(percents.filter((p) => p === "34%")).toHaveLength(1);
  });

  it("an all-zero composition prints 0% for every segment", () => {
    expect(compositionPercents([0, 0, 0], 0)).toEqual(["0%", "0%", "0%"]);
  });

  it("a negative or non-finite total degrades to all zeros", () => {
    expect(compositionPercents([1, 2, 3], -5)).toEqual(["0%", "0%", "0%"]);
    expect(compositionPercents([1, 2, 3], NaN)).toEqual(["0%", "0%", "0%"]);
    expect(compositionPercents([1, 2, 3], Infinity)).toEqual(["0%", "0%", "0%"]);
  });

  // REVIEW-W1 #5: a genuinely partial composition (values summing to LESS
  // than total) must not have its whole-bucket shares inflated to fill the
  // rounding budget the (empty, here) sub-1% bucket left behind — each
  // share prints its own real percentage, not one padded up to 100.
  it("never inflates a genuinely partial composition's shares past their real percentage", () => {
    expect(compositionPercents([50, 25], 100)).toEqual(["50%", "25%"]);
  });
});
