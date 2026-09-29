import { describe, expect, it } from "vitest";
import { sequentialSteps } from "@/components/charts/chartColors";
import { heatmapCells, monthLabelIndices, moveIndex, moveIndexRowMajor, percentileLevels } from "@/screens/usage/usageHeatmap";
import type { UsageDailyPoint } from "@/features/usage/usageTypes";

const point = (date: string, total: number): UsageDailyPoint => ({
  date,
  tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total },
  estimatedCost: { usd: 0, label: "Estimated API-equivalent cost" },
  harnesses: [],
});

describe("usage heatmap model", () => {
  it("ranks active values, keeps ties at the run's last rank, and leaves zero empty", () => {
    expect(percentileLevels([0, 10, 10, 40], 5)).toEqual([0, 4, 4, 5]);
    expect(percentileLevels([3], 5)).toEqual([5]);
    expect(percentileLevels([0, 0], 5)).toEqual([0, 0]);
  });

  it("pins the heatmap direction to sequentialSteps' strongest-first order", () => {
    const steps = sequentialSteps(5);
    expect(steps[0]).toContain("92%");
    expect(steps[4]).toContain("28%");
    expect(5 - 1).toBe(4);
  });

  it("creates 52 Monday-first weeks and keeps the window anchored", () => {
    const cells = heatmapCells([point("2026-09-04", 12)], "2026-09-04", "daily");
    expect(cells).toHaveLength(364);
    expect(cells[0].date).toBe("2025-09-08");
    expect(cells[cells.length - 1].date).toBe("2026-09-06");
    expect(cells.some((cell) => cell.tokens === 12 && cell.active)).toBe(true);
  });

  it("keeps inactive cumulative days empty while ranking active running totals", () => {
    const cells = heatmapCells([point("2026-08-31", 2), point("2026-09-02", 8)], "2026-09-04", "cumulative");
    expect(cells.find((cell) => cell.date === "2026-09-01")?.level).toBe(0);
    expect(cells.find((cell) => cell.date === "2026-09-02")?.runningTotal).toBe(10);
  });

  it("fills weekly columns from the bottom in proportion to the busiest week", () => {
    // Busiest week (Aug 31 – Sep 6): one active day with 4 tokens → all 7 squares.
    // The week before (Aug 24 – 30): 2 tokens → ceil(2 / 4 × 7) = 4 squares.
    const cells = heatmapCells([point("2026-09-01", 4), point("2026-08-26", 2)], "2026-09-04", "weekly");
    const busiest = cells.filter((cell) => cell.column === 51);
    const half = cells.filter((cell) => cell.column === 50);
    expect(busiest.filter((cell) => cell.level === 5)).toHaveLength(7);
    expect(half.filter((cell) => cell.level === 5).map((cell) => cell.row)).toEqual([3, 4, 5, 6]);
    expect(cells.filter((cell) => cell.column < 50 && cell.level !== 0)).toHaveLength(0);
    // `active` still tells the truth about the day itself.
    expect(cells.filter((cell) => cell.active)).toHaveLength(2);
  });

  it("moves through the column-major index in the visual grid's directions", () => {
    expect(moveIndex(2 * 7 + 3, "ArrowRight")).toBe(3 * 7 + 3);
    expect(moveIndex(2 * 7 + 3, "ArrowLeft")).toBe(1 * 7 + 3);
    expect(moveIndex(2 * 7 + 3, "ArrowUp")).toBe(2 * 7 + 2);
    expect(moveIndex(2 * 7, "ArrowUp")).toBe(2 * 7);
    expect(moveIndex(2 * 7 + 6, "ArrowDown")).toBe(2 * 7 + 6);
    expect(moveIndex(2 * 7 + 3, "Home")).toBe(3);
    expect(moveIndex(2 * 7 + 3, "End")).toBe(51 * 7 + 3);
  });

  it("moves through the peaks grid in weekday-major rows", () => {
    expect(moveIndexRowMajor(1 * 24 + 11, "ArrowRight", { rows: 7, columns: 24 })).toBe(1 * 24 + 12);
    expect(moveIndexRowMajor(1 * 24 + 11, "ArrowDown", { rows: 7, columns: 24 })).toBe(2 * 24 + 11);
    expect(moveIndexRowMajor(1 * 24 + 11, "Home", { rows: 7, columns: 24 })).toBe(1 * 24);
    expect(moveIndexRowMajor(1 * 24 + 11, "End", { rows: 7, columns: 24 })).toBe(1 * 24 + 23);
  });

  it("moves within a generic 24-column by 7-row shape", () => {
    const shape = { rows: 7, columns: 24 };
    expect(moveIndex(2 * 7 + 3, "ArrowRight", shape)).toBe(3 * 7 + 3);
    expect(moveIndex(0 * 7 + 3, "ArrowLeft", shape)).toBe(3);
    expect(moveIndex(2 * 7, "ArrowUp", shape)).toBe(2 * 7);
    expect(moveIndex(2 * 7 + 6, "ArrowDown", shape)).toBe(2 * 7 + 6);
    expect(moveIndex(2 * 7 + 3, "Home", shape)).toBe(3);
    expect(moveIndex(2 * 7 + 3, "End", shape)).toBe(23 * 7 + 3);
    expect(moveIndex(999, "ArrowRight", shape)).toBe(23 * 7 + 6);
  });

  it("labels the first week entering each month, including a year boundary", () => {
    const cells = heatmapCells([
      point("2025-12-31", 1), point("2026-01-01", 1), point("2026-02-01", 1), point("2026-03-01", 1),
    ], "2026-03-01", "daily");
    const labels = monthLabelIndices(cells).map((column) => cells[column * 7].date.slice(0, 7));
    expect(labels[0]).toBe("2025-03");
    expect(labels).toContain("2025-04");
    expect(labels).toContain("2025-09");
    expect(labels).toContain("2025-12");
    expect(labels).toContain("2026-01");
    expect(labels).toContain("2026-02");
  });
});
