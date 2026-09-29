import { test, expect, type Page } from "./fixtures";

// The shell's main column is viewport minus --rail-w (56) minus --sidebar-w
// (240) while the viewport is at least the 820px drawer breakpoint; below
// that the navigator becomes an off-canvas drawer, so the main column is
// viewport minus --rail-w only. 1280/1440/1920 all land well above the
// 900px and 600px skill-row breakpoints; 1096 and 576 land the main column
// near 800 and near 520, inside the bands those breakpoints actually gate.
function expectedMainColumn(width: number): number {
  return width >= 820 ? width - 56 - 240 : width - 56;
}

/** Shared body for both title loops below. `verify_breaks.py` reads `test(`
 *  titles straight from source text, so each call site keeps its own inline
 *  literal/template title — only the body is shared. */
async function checkRow(page: Page, width: number, route: string): Promise<void> {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(route);
  const rows = page.locator(".lib-list .skill-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(3);
  // Prove the viewport actually lands the main column in the intended
  // band before trusting the alignment checks below.
  const mainWidth = await page.locator(".app-main").first().evaluate((node) => node.clientWidth);
  const expectedWidth = expectedMainColumn(width);
  expect(Math.abs(mainWidth - expectedWidth), `.app-main width at ${width}px`).toBeLessThanOrEqual(2);
  // Below the skill-row's OWN 900px collapse breakpoint (skill-rows.css
  // ~:27), `.skill-meta` becomes a content-sized inline-flex group and
  // each row's grid computes independently, so column starts are no
  // longer designed to line up across rows — verified: at the new 800px
  // band this loop finds a real (expected) ~20px `.skill-interaction-style`
  // spread. Only the overflow guarantee below still holds at every width.
  if (mainWidth >= 900) {
    for (const selector of [".resource-name", ".skill-interaction-style", ".skill-body-tokens", ".resource-desc"]) {
      const positions = await rows.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
      expect(Math.max(...positions) - Math.min(...positions), selector).toBeLessThan(1);
    }
  }
  for (const row of await rows.all()) {
    expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
}

// The three original widths: main column stays well above the 900px/600px
// skill-row breakpoints, so column alignment across rows applies.
for (const width of [1280, 1440, 1920]) {
  for (const route of ["/#/", "/?bundlePlaybook=1#/bundle/android"]) {
    test(`skill scan columns align across rows at ${width}px on ${route}`, async ({ page }) => {
      await checkRow(page, width, route);
    });
  }
}

// 1096 and 576 land the main column near 800 and near 520 — below the
// skill-row's own 900px collapse breakpoint, where per-row column alignment
// no longer applies (see the comment in `checkRow`). These rows only prove
// the band and the overflow guarantee, so they get their own title.
for (const width of [1096, 576]) {
  for (const route of ["/#/", "/?bundlePlaybook=1#/bundle/android"]) {
    test(`skill rows fit the main column without overflow at ${width}px on ${route}`, async ({ page }) => {
      await checkRow(page, width, route);
    });
  }
}
