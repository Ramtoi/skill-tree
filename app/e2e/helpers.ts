import type { Page } from "@playwright/test";

/**
 * Navigate and wait for the shell to be ready for input: `.app-main` visible
 * and web fonts loaded. Playwright's own actionability checks cover a single
 * locator action, but a bare `page.keyboard.press(...)` right after `goto`
 * has no locator to wait on, and a geometry read right after `goto` can land
 * mid-layout on a cold (CI) server. Use this instead of `page.goto` at any
 * site that types/presses a key or reads a bounding box immediately after
 * navigating. See TA-1-d05f.
 */
export async function gotoReady(
  page: Page,
  url: string,
  options?: Parameters<Page["goto"]>[1],
): Promise<void> {
  await page.goto(url, options);
  await waitReady(page);
}

/**
 * The readiness half of `gotoReady`, for a page that was navigated or
 * reloaded elsewhere: the shell is visible and fonts are loaded. Use it
 * before a global keyboard chord that no locator action precedes.
 */
export async function waitReady(page: Page): Promise<void> {
  await page.locator(".app-main").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Wait for the browser to have painted after any pending layout/style work,
 * without a fixed sleep or a polling retry: two chained animation frames is
 * the standard signal that a frame has actually been rendered. Use this in
 * place of a `waitForTimeout` guess before a geometry read.
 */
export async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
