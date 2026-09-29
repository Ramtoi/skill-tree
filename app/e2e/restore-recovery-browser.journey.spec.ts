import { expect, test } from "./fixtures";

test.setTimeout(90_000);

test("Finish later returns to Library and keeps recovery resumable from Backup", async ({ page }) => {
  await page.goto("/?restoreRecovery=1#/recovery");
  await page.getByTestId("recovery-defer-btn").click();
  await expect(page).toHaveURL(/#\/$/);
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  await expect(page.getByTestId("recovery-reopen-banner")).toBeVisible();
  await page.getByTestId("recovery-reopen-btn").click();
  await expect(page.getByTestId("recovery-sources-step")).toBeVisible();
});

test("recovery preserves attachment, skips and local sync evidence across reloads", async ({ page }) => {
  await page.goto("/?restoreRecovery=1&settingsPickFolder=1#/recovery");
  await page.getByTestId("recovery-sources-recover-all").click();
  await expect(page.getByTestId("recovery-source-row-unslop")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("recovery-nav-next").click();
  await page.getByTestId("recovery-project-skip-dev").click();
  await expect(page.getByTestId("recovery-project-row-dev")).toHaveAttribute("data-status", "skipped");
  await page.getByTestId("recovery-project-attach-skill-tree").click();
  await page.getByRole("button", { name: "Choose a destination…" }).click();
  await expect(page.getByTestId("recovery-clone-review")).toContainText("https://github.com/example-org/skill-tree.git");
  await expect(page.getByTestId("recovery-clone-review")).toContainText("/Users/dev/projects/new-settings-project");
  await page.getByTestId("recovery-clone-btn").click();
  await expect(page.getByTestId("recovery-project-row-skill-tree")).toHaveAttribute("data-status", "ready");

  await page.reload();
  await expect(page.getByTestId("recovery-projects-step")).toBeVisible();
  await expect(page.getByTestId("recovery-project-row-dev")).toHaveAttribute("data-status", "skipped");
  await expect(page.getByTestId("recovery-project-row-skill-tree")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("recovery-nav-next").click();
  await page.getByTestId("recovery-local-source-skip-gh-fix-ci").click();
  await page.getByTestId("recovery-local-source-skip-skt-mcp").click();
  await page.getByTestId("recovery-nav-next").click();
  await expect(page.getByTestId("recovery-finish-btn")).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("recovery-sync-run").click();
  await expect(page.getByTestId("recovery-sync-result")).toContainText("2 synced · 1 skipped · 0 failed");

  await page.reload();
  await expect(page.getByTestId("recovery-sync-result")).toContainText("2 synced · 1 skipped · 0 failed");
  await expect(page.getByTestId("recovery-finish-btn")).not.toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("recovery-finish-btn").click();
  await expect(page.getByText(/You closed this recovery earlier/)).toBeVisible();
  await page.getByTestId("recovery-stage-tab-projects").click();
  await expect(page.getByTestId("recovery-project-connect-dev")).toBeVisible();
});

test("repository selection stays separate from attachment and the picker supports keyboard escape", async ({ page }) => {
  await page.goto("/?restoreRecovery=1#/recovery");
  await page.getByTestId("recovery-stage-tab-projects").click();
  const connect = page.getByTestId("recovery-project-connect-dev");
  await connect.click();
  await expect(page.getByTestId("recovery-repo-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(connect).toBeFocused();
  await connect.press("Enter");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("recovery-repo-example-org/repo-8")).toBeVisible();
  const search = page.getByTestId("recovery-github-search");
  await search.fill("repo-8");
  await search.press("Enter");
  await page.getByTestId("recovery-repo-example-org/repo-8").click();
  const row = page.getByTestId("recovery-project-row-dev");
  await expect(row).toHaveAttribute("data-status", "pending");
  await expect(row).toContainText("No local directory attached");
  await expect(page.getByTestId("recovery-project-attach-dev")).toBeVisible();
});

test("fifteen projects remain actionable at narrow width with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?restoreRecoveryDense=1#/recovery");
  await expect(page.locator('[data-testid^="recovery-project-row-"]')).toHaveCount(15);
  const failed = page.getByTestId("recovery-project-row-project-11");
  await failed.scrollIntoViewIfNeeded();
  await expect(failed).toContainText("Failed: Clone failed. Check access and retry.");
  const attach = page.getByTestId("recovery-project-attach-project-15");
  await attach.scrollIntoViewIfNeeded();
  const bounds = await attach.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640);
  await attach.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(attach).toBeFocused();
  await expect(page.getByText("registry · in sync", { exact: true })).toHaveCount(0);
  // `.main-body` (shell-main.css `flex: 1; overflow: auto`) is the real
  // scroll container; `.app-main` has `min-width: 0` and never grows past
  // its grid track.
  expect(
    await page.locator(".main-body").first().evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});
