import { test, expect } from "./fixtures";

// The day-bucketed usage chart thins its x-axis labels past 24 columns to
// every k-th one. Every column must still stand on ONE baseline, and the
// axis's "0" hairline must lie on that baseline. Before the fix a column
// without a label collapsed its `auto` label row, grew its bars row by a
// label's height, and drew its bars (and its zero-total stub) lower than its
// labelled neighbours — the "bars don't align at the bottom" defect. The
// `usageLong` scene serves a 40+ day range with gap days, so thinning and
// stubs are both in play. Mocked-Tauri dev server (VISUAL_MOCK=1 →
// src/mocks/tauriCore.ts). NEVER touches ~/.claude.

test("every usage column shares one baseline and the 0 hairline sits on it", async ({ page }) => {
  await page.goto("/?usageLong=1#/usage");
  await expect(page.getByText("Largest sessions")).toBeVisible();
  await page.getByRole("radio", { name: "Day", exact: true }).click();

  const chart = page.locator(".chart-stacked-column").first();
  await expect(chart.locator(".chart-col").first()).toBeVisible();

  const columns = await chart.locator(".chart-col").count();
  const labels = await chart.locator(".chart-col-label").count();
  expect(columns).toBeGreaterThan(24);
  expect(labels).toBeLessThan(columns); // the thinned case is what we measure
  await expect(chart.locator(".chart-col-stub").first()).toBeVisible(); // gap days render as stubs

  const feet = await chart
    .locator(".chart-col-bars")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().bottom)));
  expect(new Set(feet).size).toBe(1);

  const stubFeet = await chart
    .locator(".chart-col-stub")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().bottom)));
  expect(new Set(stubFeet)).toEqual(new Set(feet));

  const zeroLine = await chart.locator(".chart-grid-row").evaluateAll((rows) => {
    const row = rows.find((el) => (el as HTMLElement).style.bottom === "0%");
    const line = row?.querySelector(".chart-grid-line");
    return line ? line.getBoundingClientRect().top : null;
  });
  expect(zeroLine).not.toBeNull();
  expect(Math.abs((zeroLine as number) - feet[0])).toBeLessThanOrEqual(1);
});
