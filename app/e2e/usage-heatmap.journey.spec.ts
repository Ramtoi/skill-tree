import { test, expect } from "./fixtures";

test("usage heatmap modes and keyboard tooltip", async ({ page }) => {
  await page.goto("/#/usage");
  const grid = page.getByRole("grid", { name: "Token activity, daily" });
  await expect(grid).toBeVisible();
  await page.getByRole("radio", { name: "Weekly" }).click();
  await expect(page.getByRole("grid", { name: "Token activity, weekly" })).toBeVisible();
  await page.getByRole("radio", { name: "Cumulative" }).click();
  await expect(page.getByRole("grid", { name: "Token activity, cumulative" })).toBeVisible();
  // Scope to the heatmap card: the spend chart owns its own role="tooltip".
  const card = page.getByRole("region", { name: "Token activity" });
  const cells = card.getByRole("gridcell");
  await cells.first().focus();
  await expect(card.locator('[role="tooltip"]')).toContainText("tokens on");
  const before = await cells.first().getAttribute("aria-label");
  const beforeRow = await cells.first().getAttribute("aria-rowindex");
  const beforeColumn = await cells.first().getAttribute("aria-colindex");
  await page.keyboard.press("ArrowRight");
  const focused = card.locator('[role="gridcell"]:focus');
  await expect(focused).toHaveCount(1);
  expect(await focused.getAttribute("aria-label")).not.toBe(before);
  expect(await focused.getAttribute("aria-rowindex")).toBe(beforeRow);
  expect(await focused.getAttribute("aria-colindex")).not.toBe(beforeColumn);
});

test("usage heatmap stays contained at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 1000 });
  await page.goto("/#/usage");
  await expect(page.getByRole("grid", { name: "Token activity, daily" })).toBeVisible();
  // `.app-main` has `overflow: hidden` but `min-width: 0`, so it never grows
  // past its grid track regardless of content; `.main-body` (shell-main.css
  // `flex: 1; overflow: auto`) is the real scroll container that would
  // actually grow if the page's content overflowed.
  const overflow = await page.locator(".main-body").first().evaluate((node) => node.scrollWidth <= node.clientWidth);
  expect(overflow).toBe(true);
  await expect(page.locator(".usage-heatmap-scroll")).toHaveCSS("overflow-x", "auto");
  await expect(page.getByRole("radio", { name: "Daily" })).toBeVisible();
});


test("peaks explains combined weekdays on hover and keyboard focus", async ({ page }) => {
  await page.goto("/#/usage");
  const card = page.getByRole("region", { name: "Peaks", exact: true });
  const cell = card.getByRole("gridcell").nth(3 * 24 + 6);
  await cell.hover();
  await expect(card.getByRole("tooltip")).toContainText("tokens total across all Thursdays, 06:00 to 07:00 UTC, all recorded dates");
  await cell.focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowRight");
  await expect(card.getByRole("tooltip")).toContainText("Thursdays, 07:00 to 08:00 UTC");
  await page.getByRole("radio", { name: "30 days", exact: true }).click();
  await cell.hover();
  await expect(card.getByRole("tooltip")).not.toContainText("all recorded dates");
  await expect(card.getByRole("tooltip")).toContainText(/\d{4}/);
});


for (const width of [520, 1440]) {
  test(`peaks hover and focus preserve layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/#/usage");
    const card = page.getByRole("region", { name: "Peaks", exact: true });

    for (const range of ["All time", "30 days"]) {
      await test.step(range, async () => {
        await page.mouse.move(0, 0);
        await page.getByRole("radio", { name: range, exact: true }).click();
        await expect(card.locator(".usage-note")).toContainText(range === "All time" ? "all recorded dates" : /\d{4}/);
        await card.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        const geometry = () => card.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { height: rect.height, nextOffset: element.nextElementSibling!.getBoundingClientRect().top - rect.top };
        });
        const resting = await geometry();
        const cells = card.getByRole("gridcell");
        for (const index of [12, 36, 60, 84, 108, 132, 156]) {
          await cells.nth(index).hover();
          await expect(card.getByRole("tooltip")).not.toBeEmpty();
          expect.soft(await geometry()).toEqual(resting);
        }
        await page.mouse.move(0, 0);
        expect.soft(await geometry()).toEqual(resting);
        await cells.nth(60).focus();
        await expect(card.getByRole("tooltip")).toContainText("Wednesdays");
        expect.soft(await geometry()).toEqual(resting);
        await page.keyboard.press("ArrowRight");
        expect.soft(await geometry()).toEqual(resting);
      });
    }
  });
}
