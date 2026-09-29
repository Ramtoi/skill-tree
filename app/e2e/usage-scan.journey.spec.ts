import { test, expect, waitForPaint, type Page } from "./fixtures";

async function scanSessionCalls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __invokeCalls: { cmd: string; args?: { args?: string[] } }[] }).__invokeCalls.filter(
        (call) => call.args?.args?.[0] === "usage" && call.args?.args?.[1] === "scan-sessions",
      ).length,
  );
}

test("scan sessions from the empty state and show the in-flight process", async ({ page }) => {
  await page.goto("/?noScan=1#/usage");
  // Readiness first: prove the Sessions card actually loaded before trusting
  // the two zero-count assertions below — those pass trivially on a blank
  // or still-loading page too.
  await expect(page.locator('[aria-label="Sessions"]')).toBeVisible();
  await expect(page.getByText("No scanned sessions yet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Timeline" })).toHaveCount(0);
  expect(await page.locator('[data-testid="usage-session-row"]').count()).toBeGreaterThan(0);

  await page.goto("/?noScan=1#/usage/project/moon-base");
  await expect(page.getByText("No scanned sessions yet")).toBeVisible();
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByText("Scanning transcripts", { exact: true })).toBeVisible();

  await page.goto("/?scanHangs=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByText("Scanning transcripts", { exact: true })).toBeVisible();
});

test("keep written rows visible when the transcript scan stops", async ({ page }) => {
  await page.goto("/?scanFails=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.locator(".usage-project-scan-failed-banner")).toContainText("2026-09-05.jsonl");
  await expect(page.locator('[aria-label="Sessions"]')).toBeVisible();
});

test("recover a saved scan with one fresh transcript pass", async ({ page }) => {
  await page.goto("/?scanReplan=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("This saved scan cannot continue");
  await expect(notice).toContainText("Previously captured results are still available.");
  await expect(notice).not.toContainText("scan-2026");
  await expect(page.locator('[aria-label="Sessions"]')).toBeVisible();

  await notice.getByRole("button", { name: "Start new scan" }).click();
  await expect(notice.getByRole("button", { name: "Start new scan" })).toBeEnabled();

  const scanCalls = await page.evaluate(() =>
    (window as unknown as { __invokeCalls: { cmd: string; args?: { args?: string[] } }[] }).__invokeCalls
      .map((call) => call.args?.args ?? [])
      .filter((args) => args[0] === "usage" && args[1] === "scan-sessions"),
  );
  expect(scanCalls).toEqual([
    ["usage", "scan-sessions", "--json"],
    ["usage", "scan-sessions", "--json"],
  ]);
});

test("keeps keyboard focus through a delayed replacement and restores the header", async ({ page }) => {
  await page.goto("/?scanRecoveryDelayed=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const notice = page.getByRole("alert");
  await expect(notice).toBeVisible();

  const recovery = notice.getByRole("button", { name: "Start new scan" });
  await recovery.focus();
  await recovery.press("Enter");
  await expect(recovery).toHaveAttribute("aria-disabled", "true");
  await expect(recovery.locator("..")).toHaveAttribute("aria-busy", "true");
  await expect(notice).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeFocused();
});

test("does not steal focus moved to another task while replacement settles", async ({ page }) => {
  await page.goto("/?scanRecoveryDelayed=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const notice = page.getByRole("alert");
  await expect(notice).toBeVisible();

  const recovery = notice.getByRole("button", { name: "Start new scan" });
  await recovery.focus();
  await recovery.press("Enter");
  const outside = page.locator(".usage-project-crosslink a");
  await outside.focus();
  await expect(notice).toHaveCount(0, { timeout: 5_000 });
  await expect(outside).toBeFocused();
});

test("cancels recovery focus restoration when navigation leaves the route", async ({ page }) => {
  await page.goto("/?scanRecoveryDelayed=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const notice = page.getByRole("alert");
  await expect(notice).toBeVisible();

  const recovery = notice.getByRole("button", { name: "Start new scan" });
  await recovery.focus();
  await recovery.press("Enter");
  await page.locator(".usage-project-crosslink a").click();
  await expect(page).toHaveURL(/#\/usage$/);
  await waitForPaint(page);
  // The mutation cache is route-shared (see UsageScanRecovery's own comment),
  // so the second `scan-sessions` call (held back by the mock's
  // `scanRecoveryDelayed` branch in tauriUsageAnalytics.ts) still resolves
  // after this navigation. Wait for that event itself: the second call has
  // been dispatched, then the header Scan button (which reads the shared
  // process store) leaves its busy state once the call settles. Only then is
  // the negative check meaningful.
  await expect.poll(() => scanSessionCalls(page)).toBe(2);
  const headerScan = page.locator(".main-header-right button").filter({ hasText: "Scan" }).first();
  await expect(headerScan).not.toHaveAttribute("aria-busy", "true", { timeout: 5_000 });
  await expect(headerScan).toBeEnabled();
  await waitForPaint(page);
  await expect(headerScan).not.toBeFocused();
});

test("keeps transport recovery failures retryable", async ({ page }) => {
  await page.goto("/?scanRecoveryTransport=1#/usage/project/moon-base");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const transportRecovery = page.getByRole("alert");
  await transportRecovery.getByRole("button", { name: "Start new scan" }).click();
  await expect(transportRecovery).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("waits for the overview header to enable before restoring recovery focus", async ({ page }) => {
  await page.goto("/?scanRecoveryHeaderBusy=1#/usage");
  const headerScan = page.locator(".main-header-right button").filter({ hasText: "Scan" }).first();
  await headerScan.click();
  await expect(page.getByRole("alert")).toBeVisible();

  await headerScan.click();
  const notice = page.getByRole("alert");
  const recovery = notice.getByRole("button", { name: "Start new scan" });
  await recovery.focus();
  await recovery.press("Enter");
  await expect(recovery).toHaveAttribute("aria-disabled", "true");
  await expect(notice).toHaveCount(0, { timeout: 5_000 });
  await expect(headerScan).toBeFocused({ timeout: 5_000 });
});
