import { test, expect, type Page } from "./fixtures";

// Navigator pins, driven against the mocked-Tauri dev server (VISUAL_MOCK=1).
// NEVER touches ~/.claude.
//
// Pins live in localStorage, which the dev server shares across specs — so each
// test clears `st:sb:pinned` first, and the persistence assertion RELOADS the
// page rather than trusting the in-memory set.

async function bootProjects(page: Page) {
  await page.goto("/#/project/moon-base");
  await page.evaluate(() => localStorage.removeItem("st:sb:pinned"));
  await page.reload();
  await expect(page.locator(".app-side .side-item").first()).toBeVisible();
}

function rowNames(page: Page) {
  // Top-level rows only. The ACTIVE project expands in place to list its
  // bundles (ProjectsBody → SideDetail), and those nested rows are `.side-item`
  // too — they carry `is-nested`. Without this the list picked up
  // moon-base's bundles between the projects.
  return page.locator(".app-side .side-item:not(.is-nested) .name");
}

test("navigator pins: keyboard-togglable, hoisted in-section, survives reload", async ({
  page,
}) => {
  await bootProjects(page);

  // Alphabetical to start (no pins).
  await expect(rowNames(page)).toHaveText(["example-app", "moon-base", "skill-hub"]);

  // The pin is a SIBLING button of the nav button, so the keyboard can reach it
  // and activating it must not navigate.
  const skillHubRow = page
    .locator(".app-side .side-item")
    .filter({ has: page.locator('.name:text-is("skill-hub")') });
  const pin = skillHubRow.locator(".side-item-pin");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/project\/moon-base$/);

  // Hoisted to the top of its own section — no separate "Pinned" card, and the
  // project is listed exactly once.
  await expect(rowNames(page)).toHaveText(["skill-hub", "example-app", "moon-base"]);
  await expect(page.locator(".side-group.is-featured")).toHaveCount(0);

  // Survives a reload.
  await page.reload();
  await expect(rowNames(page)).toHaveText(["skill-hub", "example-app", "moon-base"]);
  await expect(
    page
      .locator(".app-side .side-item")
      .filter({ has: page.locator('.name:text-is("skill-hub")') })
      .locator(".side-item-pin"),
  ).toHaveAttribute("aria-pressed", "true");

  // Unpin restores the alphabetical order.
  await page
    .locator(".app-side .side-item")
    .filter({ has: page.locator('.name:text-is("skill-hub")') })
    .locator(".side-item-pin")
    .click();
  await expect(rowNames(page)).toHaveText(["example-app", "moon-base", "skill-hub"]);
});
