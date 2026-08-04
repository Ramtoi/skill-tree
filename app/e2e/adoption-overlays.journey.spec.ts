import { test, expect, type Page } from "@playwright/test";

// Wide viewport so master–detail panes (e.g. the Snippets danger zone) render.
test.use({ viewport: { width: 1440, height: 900 } });

// [adoption] journeys: the migrated overlays (Modal / ConfirmDialog / Sheet) work
// end-to-end against the mocked-Tauri dev server (VISUAL_MOCK=1). Never touches
// ~/.claude. Standing gate for the ux-primitive-system adoption pass.

function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return () =>
    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

// (a) Permissions doctor is now a Modal: open it, click a grouped finding, and
// the panel jumps to the finding (closes) — the open→jump flow.
test("doctor panel: open → click finding → jumps to the row (Modal)", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
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

  assertNoErrors();
});

// (b) Add-remote wizard is now a right-anchored Sheet: step navigation advances
// the step counter.
test("remote wizard: Sheet steps forward through the flow", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
  await page.goto("/#/remotes");
  await expect(page.locator(".app-main")).toBeVisible();

  await page.getByRole("button", { name: /Add remote/i }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/modal-right/);
  await expect(sheet.getByText(/step 1 \/ 5/)).toBeVisible();

  // Step 1: pick the Hermes connector, then Next.
  await sheet.getByText("Hermes").first().click();
  await sheet.getByRole("button", { name: /^Next$/ }).click();
  await expect(sheet.getByText(/step 2 \/ 5/)).toBeVisible();

  // Step 2: name + host, then Next.
  await sheet.getByPlaceholder("hermes-main").fill("box-two");
  await sheet.getByPlaceholder("hermes@moon-base").fill("me@box");
  await sheet.getByRole("button", { name: /^Next$/ }).click();
  await expect(sheet.getByText(/step 3 \/ 5/)).toBeVisible();

  // Back works too.
  await sheet.getByRole("button", { name: /^Back$/ }).click();
  await expect(sheet.getByText(/step 2 \/ 5/)).toBeVisible();

  assertNoErrors();
});

// (c) Snippet delete now flows through ConfirmDialog with a blast-radius body.
test("snippet delete: ConfirmDialog renders the consequence body", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
  await page.goto("/#/snippets");
  await expect(page.locator(".app-main")).toBeVisible();

  // Select a snippet from the list.
  await page.getByText("android-conventions").first().click();
  await expect(page.locator(".snip-detail-name")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete snippet/i })).toBeVisible();

  await page.getByRole("button", { name: /Delete snippet/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByText(/android-conventions/).first()).toBeVisible();
  // The danger confirm button is present in the dialog footer.
  await expect(dialog.getByRole("button", { name: /Delete/i })).toBeVisible();

  // Esc dismisses without deleting.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  assertNoErrors();
});
