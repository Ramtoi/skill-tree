import { test, expect } from "@playwright/test";

// ux-command-layer standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

/** Move DOM focus off any auto-focused search input so window chords are live. */
async function blur(page: import("@playwright/test").Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// (a) g-prefix navigation lands on the right screens. Each chord starts from a
// screen with no auto-focused search (Sources) so the window chord is live.
test("g-chords: g l / g p / g ⇧p navigate", async ({ page }) => {
  const fromSources = async (second: string) => {
    await page.goto("/#/sources");
    await expect(page.locator(".app-main")).toBeVisible();
    await blur(page);
    await page.keyboard.press("g");
    await page.keyboard.press(second);
  };

  await fromSources("l");
  await expect(page).toHaveURL(/#\/$/);

  await fromSources("Shift+P");
  await expect(page).toHaveURL(/#\/permissions$/);

  await fromSources("p");
  await expect(page).toHaveURL(/#\/project\//);
});

// (c) `?` opens the cheatsheet overlay; Esc closes it.
test("? cheatsheet overlay lists chords and closes on Esc", async ({ page }) => {
  await page.goto("/#/sources");
  await expect(page.locator(".app-main")).toBeVisible();
  await blur(page);

  await page.keyboard.press("Shift+Slash"); // "?"
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Go to Library")).toBeVisible();
  await expect(dialog.locator(".cheatsheet-row[data-binding-id]").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

// (d) Palette equip verb end-to-end: ⌘K → Equip skill… → skill → project → runs.
test("palette equip verb equips a skill onto a project", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".palette input");
  await expect(input).toBeVisible();

  await input.fill("Equip skill");
  await page.getByText("Equip skill…").click();
  await expect(page.locator(".palette-crumbs")).toContainText("Equip skill");

  // Pick the skill, then the project.
  await page.locator(".palette-item", { hasText: "deep-research" }).first().click();
  await expect(page.locator(".palette-crumbs")).toContainText("deep-research");
  await page.locator(".palette-item", { hasText: "example-app" }).first().click();

  // The undoable success toast confirms the verb ran.
  await expect(
    page.getByText("Equipped deep-research on example-app"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});

// (b) Equip → undo round-trip from the project Available panel.
test("equip → undo reverts the equipped state", async ({ page }) => {
  await page.goto("/#/project/example-app");
  await expect(page.locator(".app-main")).toBeVisible();

  // deep-research is available (not equipped) on example-app in the mock.
  const equipBtn = page.getByRole("button", { name: "Equip deep-research" });
  await expect(equipBtn).toBeVisible();
  await equipBtn.click();

  // Undoable toast appears; the skill leaves the Available list.
  await expect(page.getByText("Equipped deep-research on example-app")).toBeVisible();

  // Undo restores the prior state — deep-research returns to Available.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("button", { name: "Equip deep-research" }),
  ).toBeVisible();
});
