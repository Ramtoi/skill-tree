import { test, expect, waitForPaint } from "./fixtures";

async function openRepositoryDialog(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Repository…", exact: true }).click();
  return page.getByRole("dialog", { name: "Project repository for example-app", exact: true });
}

test("project repository preserves its selected remote and overview", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/project/example-app?tab=loadout");
  let dialog = await openRepositoryDialog(page);
  await dialog.getByLabel("Git remote", { exact: true }).fill("upstream");
  await dialog.getByRole("button", { name: "Detect repository", exact: true }).click();
  await expect(dialog.getByText("https://github.com/example-org/example-app.git", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("repository-detected.png") });
  await dialog.getByRole("button", { name: "Connect repository", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  dialog = await openRepositoryDialog(page);
  await expect(dialog.getByLabel("Git remote", { exact: true })).toHaveValue("upstream");
  await dialog.getByRole("button", { name: "Detect current checkout", exact: true }).click();
  await expect(dialog.getByText("Detected checkout", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Update repository", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  dialog = await openRepositoryDialog(page);
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/#\/project\/example-app\?tab=loadout$/);
  await expect(page.getByRole("navigation", { name: "Project areas" })).toBeVisible();
  dialog = await openRepositoryDialog(page);
  await expect(dialog.getByRole("button", { name: "Detect repository", exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Git remote", { exact: true })).toHaveValue("origin");
});

test("project repository dialog fits the narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/#/project/example-app?tab=loadout");
  const dialog = await openRepositoryDialog(page);
  // Repair (PLAN.md section 5, item 3): the dialog must fit inside the
  // viewport, and `.workspace-main` (this route's real scroll container —
  // rows-cards.css `overflow: auto`; ProjectLoadoutView never mounts a
  // `.main-body`, and `.app-main` has `min-width: 0` and never grows past
  // its grid track — see shell-main.css) must not overflow it.
  // `expect.soft` here so a geometry regression cannot hide the other
  // assertion below it (TESTS.md section 7).
  await waitForPaint(page);
  const dialogBox = await dialog.boundingBox();
  expect.soft(dialogBox, "dialog bounding box").not.toBeNull();
  // Guard the read: a null box records the soft failure above and skips
  // this check instead of throwing.
  if (dialogBox) expect.soft(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(520);
  const workspaceMain = page.locator(".workspace-main").first();
  const [scrollWidth, clientWidth] = await Promise.all([
    workspaceMain.evaluate((el) => el.scrollWidth),
    workspaceMain.evaluate((el) => el.clientWidth),
  ]);
  expect.soft(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
