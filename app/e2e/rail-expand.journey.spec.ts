import { test, expect, type Page } from "./fixtures";

// Expandable icon-rail journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
//
// The rail preference lives in localStorage (`skill-tree:tweaks`), which the
// dev server shares across specs — so every test here starts by clearing it,
// and the persistence test reloads the page rather than trusting the store.

const EXPAND = "Expand rail (show labels)";
const COLLAPSE = "Collapse rail";

/** Boot the shell with a known-collapsed rail. */
async function bootCollapsed(page: Page) {
  await page.goto("/#/");
  await page.evaluate(() => localStorage.removeItem("skill-tree:tweaks"));
  await page.reload();
  await expect(page.locator(".app-rail")).toBeVisible();
  await expect(page.getByTitle(EXPAND)).toBeVisible();
}

/** The "Permissions" rail label — the longest one, so it is also the width probe. */
function permissionsLabel(page: Page) {
  return page.locator(".app-rail .rail-label", { hasText: "Permissions" });
}

test("rail expand: chevron shows labels, reload keeps them, chevron collapses", async ({
  page,
}) => {
  await bootCollapsed(page);

  // Collapsed: the label is in the DOM but not shown, and the rail is compact.
  await expect(permissionsLabel(page)).toBeHidden();
  const collapsedWidth = (await page.locator(".app-rail").boundingBox())!.width;
  expect(collapsedWidth).toBeLessThan(80);

  // Expand.
  await page.getByTitle(EXPAND).click();
  await expect(permissionsLabel(page)).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-rail-expanded", "true");
  const expandedWidth = (await page.locator(".app-rail").boundingBox())!.width;
  expect(expandedWidth).toBeGreaterThan(collapsedWidth);
  // The longest label must fit on one line inside the rail, never clipped.
  const labelBox = (await permissionsLabel(page).boundingBox())!;
  const railBox = (await page.locator(".app-rail").boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(railBox.x + railBox.width);
  expect(labelBox.height).toBeLessThan(24); // one line, not wrapped

  await test.step("labels do not break navigation or the active marker", async () => {
    // Scoped to the rail: the Permissions screen itself carries same-titled chips.
    const railPermissions = page.locator('.app-rail button[title="Permissions"]');
    await railPermissions.click();
    await expect(page).toHaveURL(/#\/permissions$/);
    await expect(railPermissions).toHaveAttribute("aria-current", "true");
  });

  // The preference survives a reload (it is a tweak, not view state).
  await page.reload();
  await expect(permissionsLabel(page)).toBeVisible();
  await expect(page.getByTitle(COLLAPSE)).toBeVisible();

  // Collapse again.
  await page.getByTitle(COLLAPSE).click();
  await expect(permissionsLabel(page)).toBeHidden();
  await expect(page.locator(".app")).toHaveAttribute("data-rail-expanded", "false");
  await expect(page.getByTitle(EXPAND)).toBeVisible();
});

test("rail expand: a narrow window compacts the rail but keeps the preference", async ({
  page,
}) => {
  await bootCollapsed(page);
  await page.getByTitle(EXPAND).click();
  await expect(permissionsLabel(page)).toBeVisible();

  // Below the 820px narrow breakpoint there is no width to spend on labels.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator(".app")).toHaveAttribute("data-narrow", "true");
  await expect(permissionsLabel(page)).toBeHidden();
  // The chevron is gone too: CSS forces the compact rail here, so it would be
  // an inert control that then lies about its state.
  await expect(page.getByTitle(COLLAPSE)).toBeHidden();
  // …but the preference itself is untouched, so widening restores the labels.
  await expect(page.locator(".app")).toHaveAttribute("data-rail-expanded", "true");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(permissionsLabel(page)).toBeVisible();
});

test("rail expand: a short window scrolls the rail instead of clipping the StatusBar", async ({
  page,
}) => {
  await bootCollapsed(page);
  // 12 rail items need ~650px; at 600px the grid must shrink the rail row
  // (minmax(0,1fr) + rail overflow-y) rather than push the 28px status row
  // below the fold.
  await page.setViewportSize({ width: 1280, height: 600 });
  const status = page.locator(".app-status");
  await expect(status).toBeVisible();
  const box = await status.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  // The toggle stays reachable by scrolling the rail.
  await page.getByTitle(EXPAND).scrollIntoViewIfNeeded();
  await page.getByTitle(EXPAND).click();
  await expect(permissionsLabel(page)).toBeVisible();
});
