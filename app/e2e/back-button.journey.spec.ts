import { expect, test } from "./fixtures";

for (const width of [1440, 520]) {
  test(`back navigation keeps a large keyboard target at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/skill/rt-android-expert");
    const back = page.locator(".header-back");
    await expect(back).toBeVisible();
    await expect(back).toHaveAccessibleName("Back to Library");
    await expect(back).toHaveCSS("border-top-width", "0px");
    await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await back.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("Back to Library");
    const tipBox = await tooltip.boundingBox();
    expect(tipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(width);
    expect(tipBox!.y).toBeGreaterThanOrEqual(0);
    expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(900);
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    const box = await back.boundingBox();
    expect(box?.width).toBe(40);
    expect(box?.height).toBe(40);
    await expect(back.locator("svg")).toHaveCSS("width", "20px");
    const titleOffset = await page.locator(".main-title").evaluate((title) =>
      title.getBoundingClientRect().x - title.closest(".main-header")!.getBoundingClientRect().x,
    );
    await back.focus();
    await expect(tooltip).toHaveText("Back to Library");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(".header-back")).toHaveCount(0);
    const rootTitleOffset = await page.locator(".main-title").evaluate((title) =>
      title.getBoundingClientRect().x - title.closest(".main-header")!.getBoundingClientRect().x,
    );
    expect(rootTitleOffset).toBe(titleOffset);
  });
}

test("a long destination stays readable inside a short viewport", async ({ page }) => {
  // Mounts the real control through dev-server module URLs; a prebuilt
  // preview has no /node_modules/.vite/deps/, so this observation is
  // dev-server only. The visible-tooltip cases above still run everywhere.
  test.skip(!!process.env.ST_E2E_PREVIEW, "needs the dev server's module URLs");
  await page.setViewportSize({ width: 520, height: 320 });
  await page.goto("/#/skill/rt-android-expert");
  await expect(page.locator(".header-back")).toBeVisible();
  // Render the real shared control with a deliberately oversized destination.
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const buttonPath = "/src/components/BackButton.tsx";
    const [{ default: { createElement } }, { default: { createRoot } }, { BackButton }] = await Promise.all([
      import(reactPath), import(domPath), import(buttonPath),
    ]);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:80px;left:40px;z-index:9999";
    document.body.append(host);
    createRoot(host).render(createElement(BackButton, {
      title: `Back to ${"a very long destination name ".repeat(100)}`,
      "aria-label": "Long destination back button",
    }));
  });
  await page.getByRole("button", { name: "Long destination back button" }).focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(12);
  expect(box!.y + box!.height).toBeLessThanOrEqual(308);
  await tooltip.evaluate((element) => { element.scrollTop = 100; });
  await expect(tooltip).toBeVisible();
  await expect.poll(() => tooltip.evaluate((element) => element.scrollTop)).toBe(100);
});
