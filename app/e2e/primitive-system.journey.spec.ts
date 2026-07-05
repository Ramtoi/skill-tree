import { test, expect, type Page } from "@playwright/test";

// UX-primitive-system standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). Same boot path as the visual
// harness. NEVER touches ~/.claude. Kept fast + deterministic so it can become a
// standing gate for later changes.

function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return () =>
    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

// (a) Command palette reaches a destination that lives only in the rail today.
test("command palette: ⌘K → 'perm' → Enter lands on /permissions", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("Meta+k");
  const input = page.getByPlaceholder(/Jump to skill/);
  await expect(input).toBeVisible();
  await input.fill("perm");
  await expect(page.getByText("Open permissions")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#\/permissions$/);
  assertNoErrors();
});

// (b) Tweaks slice is a single source of truth: the rail toggle updates the
// shell live AND persists across a reload.
test("tweaks: toggling 'Show icon rail' hides the rail live and persists", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
  await page.goto("/#/");
  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-rail", "true");
  await expect(page.locator(".app-rail")).toBeVisible();

  // Open the Tweaks panel and flip the switch.
  await page.locator(".tweaks-toggle").click();
  await page.getByRole("checkbox", { name: "Show icon rail" }).click();

  // Live: the rail disappears without a reload.
  await expect(app).toHaveAttribute("data-rail", "false");
  await expect(page.locator(".app-rail")).toHaveCount(0);

  // Persisted: reload → still off (store hydrates from localStorage).
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-rail", "false");

  assertNoErrors();
});

// (c) The overlay base: a ConfirmDialog proof consumer traps Tab and closes on Esc.
test("overlay: bundle delete confirm traps focus and closes on Esc", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);
  await page.goto("/#/bundle/android");
  await expect(page.locator(".app-main")).toBeVisible();

  await page.getByRole("button", { name: "Delete bundle…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  // Focus is trapped inside the dialog: after several Tabs the active element is
  // still within the dialog (never escapes to the page behind it).
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  const focusInside = await dialog.evaluate((el) =>
    el.contains(document.activeElement),
  );
  expect(focusInside).toBe(true);

  // Esc dismisses.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  assertNoErrors();
});
