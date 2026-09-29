import { test, expect } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test("project worktree access shows suggestion, saves a custom path, and discloses status", async ({ page }) => {
  await page.goto("/#/project/skill-hub?tab=permissions");
  await expect(page.locator(".app-main")).toBeVisible();
  const section = page.getByTestId("worktree-access-section");
  await expect(section).toBeVisible();
  const path = section.getByLabel("Worktree directory");
  await expect(path).toHaveAttribute("placeholder", /Dev\/worktrees/);
  await path.fill("/tmp/project worktrees/skill-hub");
  await section.getByTestId("worktree-access-toggle").check();
  await expect(page.getByRole("button", { name: /Save/ })).toBeEnabled();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(section.getByText("restart required").first()).toBeVisible();
  await section.getByText("Nested metadata can differ").click();
  await expect(section).toContainText("do not isolate agents");

  // Saved worktree access survives leaving and returning to the project.
  await page.goto("/#/project/skill-hub?tab=loadout");
  await page.goto("/#/project/skill-hub?tab=permissions");
  await expect(page.getByLabel("Worktree directory")).toHaveValue("/tmp/project worktrees/skill-hub");
});

test("partial worktree sync reports failure and keeps the retry guidance", async ({ page }) => {
  await page.goto("/?worktreeAccessFails=1#/project/skill-hub?tab=permissions");
  const section = page.getByTestId("worktree-access-section");
  await section.getByTestId("worktree-access-toggle").check();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(section).toContainText("failed");
  await expect(section).toContainText("Run Sync from the status bar to retry");
});

test("the worktree setting remains readable at the compact viewport", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/#/project/skill-hub?tab=permissions");
  // At 520px the perm-layout ResizableSplit (defaultRightPx 320, paneLabel
  // "Tools") cannot dock its fixed pane beside the min main width, so it
  // always renders as a collapsed overlay behind this trigger.
  const reopen = page.getByRole("button", { name: /Open Tools/ });
  await expect(reopen).toBeVisible();
  await reopen.click();
  const section = page.getByTestId("worktree-access-section");
  await expect(section).toBeVisible();
  await expect(section.getByLabel("Worktree directory")).toBeVisible();
  await expect(section.getByText("Nested metadata can differ")).toBeVisible();
});
