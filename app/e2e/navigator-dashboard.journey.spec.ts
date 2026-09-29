import { test, expect, type Page } from "./fixtures";
import { gotoReady } from "./helpers";

// The contextual dashboard's keyboard entry points (spec §3.1/§3.2/§8.7 W2):
// `g ⇧n` focuses the navigator, roving-tabindex keys move within it, and
// activating a row leaves focus on a real row rather than stranding it.
// Driven against the mocked-Tauri dev server (VISUAL_MOCK=1). NEVER touches
// ~/.claude.

/** Move DOM focus off any auto-focused search input so window chords are live
 *  (mirrors command-layer.journey.spec.ts's own `blur` helper). */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function focusedSideRow(page: Page) {
  return page.locator(".app-side [data-side-row]:focus");
}

test("ArrowDown ×2 + Enter navigates, and focus lands on a real row afterwards (M5)", async ({
  page,
}) => {
  await gotoReady(page, "/#/project/moon-base");
  await blur(page);
  await page.keyboard.press("g");
  await page.keyboard.press("Shift+N");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(focusedSideRow(page)).toBeVisible();
});

test("Escape (docked) hands focus to the main column", async ({ page }) => {
  await gotoReady(page, "/#/project/moon-base");
  await blur(page);
  await page.keyboard.press("g");
  await page.keyboard.press("Shift+N");
  // `focusNavigator` focuses inside a `requestAnimationFrame` — wait for the
  // row to actually hold focus before sending Escape, or the key can land on
  // whatever had focus a frame earlier and never reach `.side-scroll`'s
  // handler at all.
  const active = page.locator('.app-side [data-side-row][aria-current="true"]');
  await expect(active).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-main")).toBeFocused();
});

test("at 520px, g ⇧n opens the drawer first, then focuses a row inside it", async ({
  page,
}) => {
  await page.goto("/#/project/moon-base");
  await page.setViewportSize({ width: 520, height: 800 });
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-narrow", "true");
  await expect(page.locator(".app")).toHaveAttribute("data-nav-open", "false");
  await blur(page);
  await page.keyboard.press("g");
  await page.keyboard.press("Shift+N");
  await expect(page.locator(".app")).toHaveAttribute("data-nav-open", "true");
  await expect(focusedSideRow(page)).toBeVisible();
});

test("guardrails: the skill-hub trust row routes to ?tab=permissions and the panel stays on Guardrails", async ({
  page,
}) => {
  await page.goto("/#/permissions");
  const row = page.locator(".app-side .side-item-main", { hasText: "skill-hub" });
  await expect(row.locator(".row-hint")).toHaveText("trust");
  await row.click();
  await expect(page).toHaveURL(/#\/project\/skill-hub\?tab=permissions$/);
  await expect(page.locator(".app-side .side-head-name")).toHaveText("Guardrails");
});

// The three CSS-dependent contracts from spec §3.4/§6.4/§6.5 — behind a W3-only
// describe so W2's gate (behaviour only, no computed style reads) never ran
// them against unstyled markup.
test.describe("visual contracts", () => {
  test("sticky legend stays pinned to the scroll area's top while rows scroll beneath it", async ({
    page,
  }) => {
    await page.goto("/#/sources");
    const scroll = page.locator(".app-side .side-scroll");
    await expect(scroll).toBeVisible();
    const legend = page.locator(".app-side .side-group-head", { hasText: "Sources" });
    await expect(legend).toBeVisible();
    await scroll.evaluate((el) => {
      el.scrollTop = 120;
    });
    const scrollBox = await scroll.boundingBox();
    const legendBox = await legend.boundingBox();
    // "Scroll area top" is the CONTENT edge a sticky child actually sticks
    // to (`top: 0` sticks to the scrollport's padding edge, not its
    // border-box) — `.side-scroll`'s own top padding, whatever it is.
    const paddingTop = await scroll.evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingTop),
    );
    expect(scrollBox).not.toBeNull();
    expect(legendBox).not.toBeNull();
    expect(Math.round(legendBox!.y)).toBe(Math.round(scrollBox!.y + paddingTop));
  });

  test("Home leaves the focused row fully below the sticky legend (scroll-margin-top)", async ({
    page,
  }) => {
    await page.goto("/#/sources");
    const rows = page.locator(".app-side [data-side-row]");
    await expect(rows.first()).toBeVisible();
    // Focus the LAST row (the panel's own "Open backup" self-row) so the
    // container scrolls to the bottom, then Home jumps back to rows[0] —
    // exactly the case `scroll-margin-top` exists for: without it the browser's
    // default focus scroll would land the row flush under the sticky legend.
    await rows.last().focus();
    await page.keyboard.press("Home");
    const legend = page.locator(".app-side .side-group-head", { hasText: "Sources" });
    const rowBox = await rows.first().boundingBox();
    const legendBox = await legend.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(legendBox).not.toBeNull();
    expect(rowBox!.y).toBeGreaterThanOrEqual(legendBox!.y + legendBox!.height - 1);
  });

  test("a focus-visible row shows a real outline ring", async ({ page }) => {
    await page.goto("/#/project/moon-base");
    const active = page.locator('.app-side [data-side-row][aria-current="true"]');
    await active.focus();
    const outline = await active.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });
});
