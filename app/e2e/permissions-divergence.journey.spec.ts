import { test, expect } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

// [permissions-divergence-fixes] journey: the registry-vs-native divergence
// banner and the reconcile drawer, end-to-end against the mocked-Tauri dev
// server (VISUAL_MOCK=1, `?permDivergence=1` scene). Never touches ~/.claude.


// (a) Healthy state: no divergence payload → no banner at all.
// Cut: PermissionsDivergence.test.tsx:130 "renders nothing when there is no
// divergence payload" holds this.

// (b) Divergence scene: Review opens a staged reconcile flow. General rules
// stay visible, specific approvals collapse, and untouched rows stay native.
test("divergence banner → reconcile drawer with triage and partial apply", async ({
  page,
}) => {
  await page.goto("/?permDivergence=1#/permissions");
  await expect(page.locator(".app-main")).toBeVisible();

  const banner = page.locator(".perm-divergence-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "Registry changed since the last native write",
  );
  await expect(banner).toContainText("9 unmanaged native rules");
  await expect(banner.getByRole("button", { name: /Sync now/ })).toBeVisible();

  // Review → the reconcile drawer.
  await banner.getByRole("button", { name: /Review/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // General candidates render. The previously-kept rule stays collapsed.
  await expect(dialog.getByText("Bash(cargo:*)")).toBeVisible();
  await expect(dialog.getByText("Bash(*)", { exact: true })).toHaveCount(0);
  const keptToggle = dialog.getByTestId("import-kept-toggle");
  await expect(keptToggle).toContainText("Previously kept (1)");

  // Specific approvals stay out of the long default list and explain why.
  const specificToggle = dialog.getByTestId("import-specific-toggle");
  await expect(specificToggle).toContainText("Specific approvals");
  await expect(specificToggle).toContainText("2");
  await expect(
    dialog.getByText(/Import a rule only if you want to reuse it/),
  ).toBeVisible();
  await expect(dialog.getByText("session-accepted")).toHaveCount(0);
  await specificToggle.click();
  await expect(dialog.getByText("session-accepted")).toBeVisible();
  await expect(dialog.getByText("Names an exact test target.")).toBeVisible();

  // No row has a default. One general-rule choice enables partial Apply even
  // while the conflict stays untouched for the next review.
  const apply = dialog.getByRole("button", { name: "Apply selected" });
  await expect(apply).toBeDisabled();
  const cargoRow = dialog
    .getByText("Bash(cargo:*)")
    .locator("xpath=ancestor::*[@data-testid='import-merged-row']");
  await cargoRow.getByRole("radio", { name: "Import" }).click();
  await expect(apply).toBeEnabled();

  // Expand the kept group and un-keep the blanket rule.
  await keptToggle.click();
  await expect(dialog.getByText("Bash(*)", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "un-keep" }).click();
  await expect(
    dialog.getByRole("button", { name: "will re-surface" }),
  ).toBeVisible();

  // Apply completes and closes the drawer.
  await apply.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

});
