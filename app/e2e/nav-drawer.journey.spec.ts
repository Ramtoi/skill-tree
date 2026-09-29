import { test, expect, WIDTH, type Page } from "./fixtures";

// Narrow-mode navigator drawer, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
//
// The drawer used to be gated on the icon rail: hiding the rail left a 240px
// panel docked inside a 520px window with no way to dismiss it. Both journeys
// here are about that — the rail path, and the rail-less escape hatch.

const NARROW = { width: WIDTH.narrow, height: 800 };

/** Boot at 520px with default tweaks (rail on, navigator on). */
async function bootNarrow(page: Page) {
  await page.goto("/#/");
  await page.evaluate(() => localStorage.removeItem("skill-tree:tweaks"));
  await page.setViewportSize(NARROW);
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-narrow", "true");
}

test("narrow drawer: the rail toggle opens it, picking a project closes it", async ({
  page,
}) => {
  await bootNarrow(page);

  const app = page.locator(".app");
  const aside = page.locator(".app-side");

  // Closed: off-canvas, hidden, and out of the tab order.
  await expect(app).toHaveAttribute("data-nav-open", "false");
  await expect(aside).toBeHidden();
  await expect(aside).toHaveAttribute("inert", "");

  await page.locator('.app-rail button[title="Toggle navigation"]').click();
  await expect(app).toHaveAttribute("data-nav-open", "true");
  await expect(aside).toBeVisible();
  await expect(aside).not.toHaveAttribute("inert", "");
  // It overlays the content rather than squeezing it: the scrim is live.
  await expect(page.locator(".app-nav-scrim")).toBeVisible();

  // The drawer sits to the RIGHT of the rail — it never slices the glyphs.
  // Polled: the slide-in is a 180ms transform, so a single read can catch it
  // mid-flight (which is exactly what the first version of this test did).
  const railBox = (await page.locator(".app-rail").boundingBox())!;
  await expect
    .poll(async () => (await aside.boundingBox())!.x)
    .toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);

  // Picking from inside the drawer navigates AND dismisses it.
  await page.locator('.app-rail button[title="Projects"]').click();
  await expect(app).toHaveAttribute("data-nav-open", "false");
  await page.locator('.app-rail button[title="Toggle navigation"]').click();
  await expect(aside).toBeVisible();
  // Scoped to TOP-LEVEL rows: the active project can now expand a nested
  // detail block (its own `.side-item-main`-class bundle rows), which would
  // otherwise shift a plain `.nth()` index off the flat project list.
  await aside.locator(".side-item:not(.is-nested) .side-item-main").nth(1).click();
  await expect(page).toHaveURL(/#\/project\/moon-base$/);
  await expect(app).toHaveAttribute("data-nav-open", "false");
  await expect(aside).toBeHidden();

  // …including the row you are already on: a tap that changes nothing must
  // still get the drawer out of the way.
  await page.locator('.app-rail button[title="Toggle navigation"]').click();
  // Scoped to TOP-LEVEL rows: the active project can now expand a nested
  // detail block (its own `.side-item-main`-class bundle rows), which would
  // otherwise shift a plain `.nth()` index off the flat project list.
  await aside.locator(".side-item:not(.is-nested) .side-item-main").nth(1).click();
  await expect(app).toHaveAttribute("data-nav-open", "false");
});

test("narrow drawer: hiding the rail leaves a handle that still opens it", async ({
  page,
}) => {
  await bootNarrow(page);

  // Hide the rail from Settings (the panel's own toggle lives there).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Show icon rail").click();
  await expect(page.locator(".app-rail")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".app-main").click({ position: { x: 10, y: 300 } });

  // Without a rail there is no rail toggle — the fixed handle takes over.
  const handle = page.getByLabel("Open navigator");
  await expect(handle).toBeVisible();
  await expect(page.locator(".app-side")).toBeHidden();

  await handle.click();
  await expect(page.locator(".app")).toHaveAttribute("data-nav-open", "true");
  await expect(page.locator(".app-side")).toBeVisible();
  // Rail-less: the drawer starts at the window edge, not 56px in.
  await expect
    .poll(async () => (await page.locator(".app-side").boundingBox())!.x)
    .toBeLessThanOrEqual(1);

  // Click the exposed scrim, beyond the drawer's right edge.
  const scrim = page.locator(".app-nav-scrim");
  const scrimBox = (await scrim.boundingBox())!;
  await scrim.click({ position: { x: scrimBox.width - 8, y: scrimBox.height / 2 } });
  await expect(page.locator(".app")).toHaveAttribute("data-nav-open", "false");
  await expect(page.locator(".app-side")).toBeHidden();
});

test("narrow drawer: focus is contained while open and handed back on close", async ({
  page,
}) => {
  await bootNarrow(page);

  const app = page.locator(".app");
  const aside = page.locator(".app-side");
  const toggle = page.locator('.app-rail button[title="Toggle navigation"]');

  // Closed: the main column owns the tab order.
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");

  await toggle.click();
  await expect(app).toHaveAttribute("data-nav-open", "true");

  // Open over a scrim, the content behind is out of reach — Tab used to walk
  // straight past the drawer into it.
  await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
  // The rail keeps the toggle usable, so it must NOT be inert with it.
  await expect(page.locator(".app-rail")).not.toHaveAttribute("inert", "");

  // Tab from inside the drawer stays out of the main column.
  await aside.locator(".side-item-main").first().focus();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const inMain = await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && !!document.querySelector(".app-main")?.contains(active);
    });
    expect(inMain).toBe(false);
  }

  // Closing while focus lives in the drawer hands it back to the opener rather
  // than stranding it on an element that just went inert.
  await aside.locator(".side-item-main").first().focus();
  await page.keyboard.press("Escape");
  await expect(app).toHaveAttribute("data-nav-open", "false");
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  await expect(toggle).toBeFocused();
});
