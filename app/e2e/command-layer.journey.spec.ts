import { test, expect } from "./fixtures";

// ux-command-layer standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

/** Move DOM focus off any auto-focused search input so window chords are live. */
async function blur(page: import("@playwright/test").Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// (a) g-prefix navigation lands on the right screens. Each chord starts from a
// screen with no auto-focused search (Sources) so the window chord is live.
type Chord = {
  second: string;
  press: string;
  screen: string;
  url: RegExp;
  ready?: string;
};

const CHORDS: Chord[] = [
  { second: "l", press: "l", screen: "the Library", url: /#\/$/ },
  {
    second: "⇧p",
    press: "Shift+P",
    screen: "global Permissions",
    url: /#\/permissions$/,
  },
  { second: "p", press: "p", screen: "the last project", url: /#\/project\// },
  {
    second: "k",
    press: "k",
    screen: "Hooks",
    url: /#\/hooks$/,
    ready: ".hooks-list",
  },
];

for (const row of CHORDS) {
  test(`g ${row.second} opens ${row.screen} from Sources`, async ({ page }) => {
    await page.goto("/#/sources");
    await expect(page.locator(".app-main")).toBeVisible();
    await blur(page);
    await page.keyboard.press("g");
    await page.keyboard.press(row.press);
    await expect(page).toHaveURL(row.url);
    if (row.ready) {
      await expect(page.locator(row.ready)).toBeVisible();
    }
  });
}

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
