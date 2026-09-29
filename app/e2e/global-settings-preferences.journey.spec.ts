import { test, expect, type Page } from "./fixtures";
import { waitReady } from "./helpers";

async function settings(page: Page, category: string) {
  // The chord has no locator to wait on; after goto or reload the shell must
  // be mounted before the shortcut handler exists.
  await waitReady(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: category, exact: true }).click();
  return dialog;
}

test("Usage shares preferences, retains drafts across categories, and preserves filters", async ({ page }) => {
  await page.goto("/#/usage");
  await expect(page.getByLabel("Cached usage summary")).toBeVisible();
  await page.getByRole("radio", { name: "7 days", exact: true }).check();
  const dialog = await settings(page, "Usage");
  await dialog.getByRole("radio", { name: "EUR", exact: true }).check();
  const rate = dialog.getByLabel("EUR per USD", { exact: true });
  await rate.fill("0,05");
  await expect(dialog.getByRole("button", { name: "Save rate" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await dialog.getByRole("button", { name: /^Usage/ }).click();
  await expect(rate).toHaveValue("0,05");
  await page.keyboard.press("Escape");
  await expect(dialog).toContainText("Discard unsaved settings?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(rate).toHaveValue("0,05");
  await rate.fill("0,93");
  await dialog.getByRole("button", { name: "Save rate" }).click();
  await dialog.getByLabel("Fetch public model prices on the next scan").check();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "EUR", exact: true })).toBeChecked();
  await expect(page.getByLabel("EUR per USD", { exact: true })).toHaveValue("0.93");
  await expect(page.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByLabel("EUR per USD", { exact: true })).toHaveValue("0.93");
});

test("worktree defaults retry, backup opt-in, reopen, and new project use", async ({ page }) => {
  await page.goto("/?settingsWriteFails=1#/");
  const dialog = await settings(page, "Worktrees");
  const backup = dialog.getByLabel("Include worktree defaults in backups");
  await expect(backup).not.toBeChecked();
  await dialog.getByLabel("Base directory", { exact: true }).fill("~/Dev/Agent worktrees");
  await dialog.getByLabel("Enable agent access for new projects").check();
  await backup.check();
  await expect(dialog.locator(".settings-path-preview code")).toHaveText("/Users/dev/Dev/Agent worktrees/my-project");
  await dialog.getByRole("button", { name: "Save defaults", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not save worktree defaults");
  await page.evaluate(() => history.replaceState(null, "", "/#/"));
  await dialog.getByRole("button", { name: "Retry save defaults" }).click();
  await expect(dialog.getByRole("status")).toContainText("Defaults saved for future projects");
  await page.keyboard.press("Escape");
  await page.reload();
  const reopened = await settings(page, "Worktrees");
  await expect(reopened.getByLabel("Base directory", { exact: true })).toHaveValue("~/Dev/Agent worktrees");
  await expect(reopened.getByLabel("Include worktree defaults in backups")).toBeChecked();
  await page.keyboard.press("Escape");
  await page.goto("/?settingsPickFolder=1#/?addProject=1");
  const add = page.getByRole("dialog", { name: "Add project", exact: true });
  await expect(add).toBeVisible();
  await add.getByRole("button", { name: "Browse…" }).click();
  await expect(add.locator(".settings-path-preview code")).toHaveText("/Users/dev/Dev/Agent worktrees/new-settings-project");
  await add.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(add).toHaveCount(0);
  await expect(page.locator(".toast").filter({ hasText: "Registered project new-settings-project" })).toContainText("/Users/dev/Dev/Agent worktrees/new-settings-project");
});

test("Backup preferences reflect saved state and preserve the operational destination", async ({ page }) => {
  await page.goto("/?backupPending=1#/");
  const dialog = await settings(page, "Backup");
  await expect(dialog).toContainText("Remote pushes are paused after a restore");
  const automatic = dialog.getByLabel("Automatic backup after sync");
  await automatic.uncheck();
  await expect(automatic).toBeEnabled();
  await expect(automatic).not.toBeChecked();
  await dialog.getByRole("button", { name: "Manage backup" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/backup$/);
});

test("remote publication follows explicit controls and persists across reload", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("st:mock:machines")) localStorage.setItem("st:mock:machines", JSON.stringify({
      ready: { id: "ready", connector: "headless-loadouts", phase: "active", sync_enabled: true }, paused: { id: "paused", connector: "headless-loadouts", phase: "paused", sync_enabled: false },
      review: { id: "review", connector: "headless-loadouts", phase: "active", sync_enabled: true, delivery: {error:{code:"approval_required",message:"Review native settings on this machine."}} },
    }));
  });
  await page.goto("/#/");
  let dialog = await settings(page, "Remotes");
  const toggle = dialog.getByRole("checkbox", { name: "Publish headless loadouts on Sync" });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByText("Sync preference saved.")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("st:mock:remote-delivery")!).last_run)).toBeNull();
  await page.reload();
  dialog = await settings(page, "Remotes");
  await expect(dialog.getByRole("checkbox", { name: "Publish headless loadouts on Sync" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Deliver now to all" }).click();
  await expect(dialog.getByText("Delivered", {exact:true})).toBeVisible();
  await expect(dialog.getByText("Paused · skipped")).toBeVisible();
  await expect(dialog.getByText("Needs approval")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Default polling interval for new machines" })).toHaveValue("60");
  await dialog.getByRole("button", { name: "Manage machines" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/remotes$/);
  await expect(page.locator(".remote-card").filter({ hasText: "ready" })).toBeVisible();
});
