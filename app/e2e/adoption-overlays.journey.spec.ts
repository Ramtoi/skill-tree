import { test, expect } from "./fixtures";

// Wide viewport so master–detail panes (e.g. the Snippets danger zone) render.
test.use({ viewport: { width: 1440, height: 900 } });

// [adoption] journeys: the migrated overlays (Modal / ConfirmDialog / Sheet) work
// end-to-end against the mocked-Tauri dev server (VISUAL_MOCK=1). Never touches
// ~/.claude. Standing gate for the ux-primitive-system adoption pass.


// (a) Permissions doctor is now a Modal: open it, click a grouped finding, and
// the panel jumps to the finding (closes) — the open→jump flow.
test("doctor panel: open → click finding → jumps to the row (Modal)", async ({ page }) => {
  await page.goto("/#/permissions");
  await expect(page.locator(".app-main")).toBeVisible();

  await page.getByRole("button", { name: /More actions/i }).click();
  await page.getByRole("menuitem", { name: /Open doctor/i }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByText("Permissions doctor")).toBeVisible();

  // Click the first grouped finding — onJumpToFinding closes the panel.
  await dialog
    .getByText(/broad Bash allow rule|auto-granted trust/i)
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

});

// Snippet delete's ConfirmDialog consequence body is proved by
// Snippets.test.tsx "guarded delete lists affected files, warns about
// orphaning, and opens the next snippet".

test("agent docs harness manager owns the screen above the narrow Map overlay", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/#/project/moon-base?tab=agent-docs");
  await expect(page.locator(".agent-docs-grid")).toBeVisible();

  await page.getByRole("button", { name: "Open Map" }).click();
  const map = page.locator(".resizable-split-overlay");
  await expect(map).toBeVisible();

  const trigger = page.getByRole("button", { name: "Manage", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Harnesses for moon-base" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const dialogBox = await dialog.boundingBox();
  const mapBox = await map.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(mapBox).not.toBeNull();
  const overlapPoint = {
    x: Math.max(dialogBox!.x, mapBox!.x) + 24,
    y: Math.max(dialogBox!.y, mapBox!.y) + 24,
  };
  const topDialogName = await page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    return top?.closest('[role="dialog"]')?.getAttribute("aria-label") ?? null;
  }, overlapPoint);
  expect(topDialogName).toBe("Harnesses for moon-base");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(map).toBeVisible();
  await expect(trigger).toBeFocused();
});
