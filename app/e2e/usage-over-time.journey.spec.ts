import { test, expect } from "./fixtures";

type InvokeCall = { cmd: string; args: unknown };

test("skill picker searches, updates the chart, and returns keyboard focus", async ({ page }) => {
  await page.goto("/#/usage");
  const card = page.getByRole("region", { name: "Skills used" });
  const trigger = card.getByRole("button", { name: /Choose skills/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose skills" });
  const search = dialog.getByRole("searchbox", { name: "Search skills" });
  await expect(search).toBeFocused();
  await dialog.getByRole("button", { name: "Clear", exact: true }).click();
  await search.fill("deliver");
  await search.press("Tab");
  await expect(dialog.getByRole("button", { name: "Top 3" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("option", { name: /^deliver-it/ })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card.locator('polyline[data-series="deliver-it"]')).toHaveCount(1);
  await expect(card.locator("polyline")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole("radio", { name: "Month", exact: true }).click();
  await expect(card.locator('polyline[data-series="deliver-it"]')).toHaveCount(1);
  await expect(card.locator("polyline")).toHaveCount(1);
  await trigger.click();
  await dialog.getByRole("button", { name: "Top 3" }).click();
  await expect(card.locator("polyline")).toHaveCount(3);
  await expect(card.locator('polyline[data-series="__other_activity__"]')).toHaveCount(0);
  await card.getByRole("heading", { name: "Skills used" }).click();
  await expect(dialog).not.toBeVisible();
});

for (const route of ["/#/usage", "/?usageDrilldown=1&usageRich=1#/usage/project/moon-base"]) {
test(`skill picker fits a narrow viewport at ${route}`, async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto(route);
  await page.getByRole("region", { name: "Skills used" }).getByRole("button", { name: /Choose skills/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose skills" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(520);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
});
}

async function calls(page: import("@playwright/test").Page): Promise<InvokeCall[]> {
  return page.evaluate(() => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls);
}

test("usage over-time hover stays inside the card and shared controls change the band", async ({ page }) => {
  await page.goto("/#/usage");
  const skills = page.getByRole("region", { name: "Skills used" });
  const plot = skills.locator(".line-chart-area");
  const tooltip = skills.locator('[role="tooltip"]');

  for (const width of [1440, 520]) {
    await test.step(`hover and layout at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      for (const x of [0.2, 0.85]) {
        const box = (await plot.boundingBox())!;
        await plot.hover({ position: { x: box.width * x, y: box.height / 2 } });
        await expect(tooltip).toBeVisible();
        const boxes = await tooltip.evaluate((tip) => {
          const card = tip.closest(".usage-card")!.getBoundingClientRect();
          const box = tip.getBoundingClientRect();
          return {
            inside: box.left >= card.left && box.right <= card.right && box.top >= card.top && box.bottom <= card.bottom,
            titleInside: box.top <= tip.querySelector(".chart-tooltip-title")!.getBoundingClientRect().top,
          };
        });
        expect.soft(boxes.inside).toBe(true);
        expect.soft(boxes.titleInside).toBe(true);
      }
      for (const label of await skills.locator(".line-chart-x-axis span").all()) {
        const labelBox = await label.boundingBox();
        const cardBox = await skills.boundingBox();
        expect.soft(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height - 8);
      }
      // `.main-body` (shell-main.css `flex: 1; overflow: auto`), not
      // `.app-main` (which has `min-width: 0` and never grows past its grid
      // track), is the real scroll container a wide chart/tooltip would
      // overflow.
      expect.soft(await page.locator(".main-body").first().evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

      if (width === 1440) {
        await page.getByRole("radio", { name: "Month" }).click();
        await expect(skills).toContainText("by month");
        await expect(page.getByRole("radio", { name: "90 days" })).toBeVisible();
        await page.getByRole("radio", { name: "90 days" }).click();
        const expectedSince = new Date();
        expectedSince.setUTCDate(expectedSince.getUTCDate() - 89);
        const since = expectedSince.toISOString().slice(0, 10);
        await expect.poll(async () => {
          const timeline = (await calls(page)).filter((entry) => {
            // `runHubCmd` invokes `hub_cmd` with `{ args: string[] }`.
            const args = (entry.args as { args?: unknown } | undefined)?.args;
            return entry.cmd === "hub_cmd" && Array.isArray(args) && args[0] === "usage" && args[1] === "timeline";
          });
          const args = timeline.length > 0 ? (timeline[timeline.length - 1].args as { args: string[] }).args : undefined;
          const index = args?.indexOf("--since") ?? -1;
          return index >= 0 ? args?.[index + 1] : undefined;
        }).toBe(since);
      }
    });
  }
});


test("every usage range shows spaced activity counts and explicit single buckets remain visible", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-14T12:00:00Z"));
  await page.addInitScript(() => {
    if (!localStorage.getItem("chart-regression-seeded")) {
      localStorage.setItem("st:usage:range", "7d");
      localStorage.setItem("st:usage:bucket", "month");
      localStorage.setItem("chart-regression-seeded", "true");
    }
  });
  await page.goto("/#/usage");
  const skills = page.getByRole("region", { name: "Skills used" });
  const tools = page.getByRole("region", { name: "Tool activity" });
  for (const [range, bucket, count, first, last] of [
    ["7 days", "Day", 7, "2026-07-08", "2026-07-14"],
    ["30 days", "Day", 30, "2026-06-15", "2026-07-14"],
    ["90 days", "Week", 14, "2026-04-13", "2026-07-13"],
    ["1 year", "Week", 53, "2025-07-14", "2026-07-13"],
    ["All time", "Week", 39, "2025-12-08", "2026-08-31"],
  ] as const) {
    await page.getByRole("radio", { name: range, exact: true }).click();
    await expect(page.getByRole("radio", { name: bucket, exact: true })).toBeChecked();
    for (const card of [skills, tools]) {
      const points = card.locator(".line-chart-point");
      await expect.poll(async () => points.evaluateAll((items) => new Set(items.map((item) => item.getAttribute("data-x"))).size)).toBe(count);
      await expect(card.locator(`[data-x="${first}"]`).first()).toBeAttached();
      await expect(card.locator(`[data-x="${last}"]`).first()).toBeAttached();
      await card.locator('.line-chart-point').first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(card.getByRole("tooltip")).toBeVisible();
    }
    await page.getByRole("radio", { name: "Month", exact: true }).click();
  }
  await page.getByRole("radio", { name: "7 days", exact: true }).click();
  await page.getByRole("radio", { name: "Month", exact: true }).click();
  for (const card of [skills, tools]) {
    const point = card.locator('.line-chart-point[data-single="true"]').first();
    await expect(point).toBeAttached();
    const dot = await point.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { width: style.width, background: style.backgroundColor };
    });
    expect(dot.width).toBe("6px");
    expect(dot.background).not.toBe("rgba(0, 0, 0, 0)");
  }
  await page.reload();
  await expect(page.getByRole("radio", { name: "Month", exact: true })).toBeChecked();
});
