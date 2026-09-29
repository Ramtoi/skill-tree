import { test, expect } from "./fixtures";

// UX-primitive-system standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). Same boot path as the visual
// harness. NEVER touches ~/.claude. Kept fast + deterministic so it can become a
// standing gate for later changes.


// (a) Command palette reaches a destination that lives only in the rail today.
test("command palette: ⌘K → 'perm' → Enter lands on /permissions", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("Meta+k");
  const input = page.getByPlaceholder(/Jump to skill/);
  await expect(input).toBeVisible();
  await input.fill("perm");
  await expect(page.getByText("Open permissions")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#\/permissions$/);
});

// The rail toggle live+persist behavior is proved by global-settings.journey.spec.ts
// "Settings stays reachable with navigation hidden and persists appearance".

// The bundle-delete ConfirmDialog's Tab-trap and Esc-close behavior is proved
// by global-settings.journey.spec.ts "Settings does not open over an existing
// modal", which already opens this same dialog first.
