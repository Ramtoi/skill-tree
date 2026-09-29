import { test, expect } from "./fixtures";

// Durable usage history journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). `?usageBackfilled=1` serves a
// mixed-provenance history payload (backfilled + frozen + scanned days) — see
// `usageHistoryPayload()` in tauriCore.ts. This proves the backfilled fade and
// legend note actually reach the rendered DOM, not just the unit-tested
// column-building logic.

test("usage: a backfilled day fades in the spend chart and names itself in the legend", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?usageBackfilled=1#/usage");
  await expect(page.locator("text=from Claude Code's own stats")).toBeVisible();

  const backfilledCol = page.locator('.chart-col[data-provenance="backfilled"]').first();
  await expect(backfilledCol).toBeVisible();

  const scannedCol = page.locator('.chart-col[data-provenance="scanned"]').first();
  await expect(scannedCol).toBeVisible();

  const backfilledOpacity = await backfilledCol
    .locator(".chart-col-seg")
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity));
  const scannedOpacity = await scannedCol
    .locator(".chart-col-seg")
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity));

  expect(backfilledOpacity).toBeLessThan(scannedOpacity);
});

test("usage: controls shelf stays pinned while the body scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?usageBackfilled=1#/usage");
  await expect(page.locator(".usage-controls-scope")).toBeVisible();

  await page.locator(".main-body").evaluate((el) => {
    el.scrollTop = 900;
  });

  const scope = page.locator(".usage-controls-scope");
  const mainBody = page.locator(".main-body");
  // The shelf re-pins on the same frame the scroll settles; poll the sticky
  // contract itself instead of guessing how long that takes.
  await expect
    .poll(async () => {
      const scopeBox = await scope.boundingBox();
      const bodyBox = await mainBody.boundingBox();
      return scopeBox && bodyBox ? Math.abs(scopeBox.y - bodyBox.y) : null;
    })
    .toBeLessThanOrEqual(1);

  const scopeBox = await scope.boundingBox();
  const bodyBox = await mainBody.boundingBox();
  expect(scopeBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(Math.abs(scopeBox!.y - bodyBox!.y)).toBeLessThanOrEqual(1);
  expect(scopeBox!.width).toBeGreaterThanOrEqual(bodyBox!.width - 2 * 24 - 2);
  const currencyBox = await page.getByRole("radiogroup", { name: "Currency" }).boundingBox();
  expect(currencyBox).not.toBeNull();
  expect(currencyBox!.y + currencyBox!.height).toBeLessThanOrEqual(bodyBox!.y);
  await expect(page.getByRole("radiogroup", { name: "Bucket" })).toBeVisible();

  await page.getByRole("radiogroup", { name: "Bucket" }).getByRole("radio", { name: "Week" }).click();
  await expect(page.locator(".usage-spend-card h3")).toContainText("by week");
});
