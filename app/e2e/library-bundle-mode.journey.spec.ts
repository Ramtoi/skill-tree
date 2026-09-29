import { test, expect, type Page } from "./fixtures";

// The Library's bundle mode: selecting a bundle keeps the list in place and
// turns the header band into an editable bundle header. Driven against the
// mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER
// touches ~/.claude. The mock's `android` bundle has 4 members (all present
// in the registry); `legacy-tools` (behind the `contextAttention` scene flag)
// has one present member (`brainstorm`) and one missing (`retired-skill`).


const ANDROID_MEMBER_COUNT = 4;

// `expectBand` names the state the caller already put the page in (plain
// library vs. bundle mode), so each call site asserts its expected branch
// instead of silently skipping the bundle-band geometry check.
async function expectContentBelowBand(page: Page, expectBand: boolean): Promise<void> {
  const body = page.locator(".main-body").first();
  const band = page.locator(".main-subheader");
  await expect(body).toBeVisible();
  const bodyBox = (await body.boundingBox())!;
  const bandBox = (await band.boundingBox())!;
  expect(Math.abs(bodyBox.y - bandBox.y - bandBox.height)).toBeLessThanOrEqual(1);
  const bundleBand = page.getByTestId("library-bundle-band");
  if (expectBand) {
    await expect(bundleBand).toBeVisible();
    const content = (await bundleBand.boundingBox())!;
    expect(content.y - bandBox.y).toBeGreaterThanOrEqual(7);
    expect(bandBox.y + bandBox.height - content.y - content.height).toBeGreaterThanOrEqual(7);
    expect(await band.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  } else {
    await expect(bundleBand).toHaveCount(0);
  }
}

// The band may grow for padding and wrapped controls; the list must follow
// immediately without overlapping it at every supported width. The context
// pill's exit (folded from the cut "the context pill exits bundle mode back
// to the plain library, list unmoved") runs last, at every width too.
for (const width of [1440, 1024, 768, 520]) {
  test.describe(`library-bundle-mode geometry @ ${width}px`, () => {
    test("geometry: the adaptive band keeps clear of content and the context pill exits", async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });

      await page.goto("/#/");
      await expect(page.locator(".app-main")).toBeVisible();
      await expectContentBelowBand(page, false);

      await page.goto("/#/bundle/android");
      await expect(page.getByTestId("library-bundle-band")).toBeVisible();
      await expect(page.locator(".lib-list .skill-row")).toHaveCount(ANDROID_MEMBER_COUNT);
      await expectContentBelowBand(page, true);

      // A different full navigation (query string differs) so the
      // contextAttention-gated `legacy-tools` fixture is registered fresh.
      await page.goto("/?contextAttention=1#/bundle/legacy-tools");
      await expect(page.getByTestId("library-bundle-band")).toBeVisible();
      await expect(page.getByTestId("bundle-missing-tag")).toBeAttached();
      await expectContentBelowBand(page, true);

      await page.goto("/#/bundle/android");
      await expect(page.getByTestId("library-bundle-band")).toBeVisible();
      await page.getByTestId("bundle-context-pill").click();
      await expect(page).toHaveURL(/#\/$/);
      await expect(page.locator(".main-title .title-text")).toHaveText("Library");
      await expect(page.getByTestId("library-bundle-band")).toHaveCount(0);
      await expectContentBelowBand(page, false);
    });
  });
}

test("removing a skill from the row action shows an Undo toast that restores it", async ({
  page,
}) => {
  await page.goto("/#/bundle/android");
  await expect(page.getByTestId("library-bundle-band")).toBeVisible();

  const row = page.locator(".lib-list .skill-row", { hasText: "rt-android-expert" });
  await expect(row).toBeVisible();
  // The remove action is hover-revealed (`.resource-actions` is `display:
  // none` at rest — see `rows-cards.css`).
  await row.hover();

  await row.getByRole("button", { name: "Remove rt-android-expert from android" }).click();
  await expect(row).toHaveCount(0);

  const toast = page.locator(".toast", { hasText: "Removed rt-android-expert from android" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();

  await expect(row).toBeVisible();
  await expect(page.locator(".lib-list .skill-row")).toHaveCount(ANDROID_MEMBER_COUNT);

});

test("Global menu switch round trips and preserves explicit project assignments", async ({ page }) => {
  await page.goto("/#/bundle/android");
  const applied = page.getByTestId("bundle-applied-chip");
  await expect(page.locator(".main-header-right").getByTestId("bundle-applied-chip")).toBeVisible();
  await expect(page.locator(".main-subheader").getByTestId("bundle-applied-chip")).toHaveCount(0);
  await expect(applied).toHaveText("Applied to2");
  await applied.click();
  await expect(page.getByRole("listbox", { name: "Projects" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".app-main").getByTestId("overflow-trigger").click();
  const toggle = page.getByRole("menuitemcheckbox", { name: "Global" });
  await expect(page.getByRole("menuitem", { name: "Rename bundle…" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await expect(page.getByText("auto-applied everywhere", { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("menu")).toBeVisible();
  await toggle.press("Enter");
  await expect(toggle).not.toBeChecked();
  await expect(applied).toHaveText("Applied to2");
  await expect(applied).toBeEnabled();
  await toggle.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Change icon…" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitem", { name: "Rename bundle…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();
});


test("rename from sidebar and header menus shares the inline editor and undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/");
  const row = page.locator(".app-side .side-item-main", { hasText: "android" }).first();
  await row.click({ button: "right" });
  await expect(page).toHaveURL(/#\/$/);
  await page.getByRole("menuitem", { name: "Rename bundle…" }).click();
  const field = page.getByRole("textbox", { name: "Bundle name", exact: true });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("android");
  await field.fill("mobile-tools");
  await field.press("Enter");
  await expect(page).toHaveURL(/#\/bundle\/mobile-tools$/);
  await expect(page.locator(".app-side .side-item-main", { hasText: "mobile-tools" })).toBeVisible();
  await expect(page.locator(".app-side").getByTestId("overflow-trigger")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page).toHaveURL(/#\/bundle\/android$/);
  await page.locator(".main-header").getByTestId("overflow-trigger").click();
  await page.getByRole("menuitem", { name: "Rename bundle…" }).click();
  await expect(field).toBeFocused();
  await field.fill("Invalid Name");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await page.locator(".app-side .side-item-main", { hasText: "android" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename bundle…" }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("android");
  await field.press("Escape");
});


test("project sidebar bundle rename retains the project back target", async ({ page }) => {
  await page.goto("/#/project/moon-base");
  const row = page.locator(".app-side .side-item.is-nested .side-item-main", { hasText: "android" }).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename bundle…" }).click();
  const field = page.getByRole("textbox", { name: "Bundle name", exact: true });
  await expect(field).toBeFocused();
  await field.fill("mobile-tools");
  await field.press("Enter");
  await expect(page).toHaveURL(/#\/bundle\/mobile-tools$/);
  await expect(page.getByRole("button", { name: "Rename bundle name: mobile-tools", exact: true })).toBeVisible();
  await expect(page.getByTestId("library-bundle-band")).toBeVisible();
  await expect(page.getByText('Bundle "mobile-tools" not found', { exact: true })).toHaveCount(0);
  const back = page.getByRole("button", { name: "Back to moon-base", exact: true });
  await expect(back).toHaveCount(1);
  await back.click();
  await expect(page).toHaveURL(/#\/project\/moon-base$/);
});

test("narrow sidebar rename closes the drawer and focuses the name", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await page.goto("/#/bundle/android");
  await page.locator('.app-rail button[title="Toggle navigation"]').click();
  await page.locator(".app-side .side-item-main", { hasText: "android" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename bundle…" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-nav-open", "false");
  const field = page.getByRole("textbox", { name: "Bundle name", exact: true });
  await expect(field).toBeFocused();
  await field.press("Escape");
  await expect(field).toHaveCount(0);
});
