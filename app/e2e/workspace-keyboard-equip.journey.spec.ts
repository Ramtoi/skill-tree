import { test, expect } from "@playwright/test";

// Project Workspace Available-list keyboard equip (B1-08 roving nav): j/k move a
// roving focus across the flat available list and `e` equips the focused row.
// Mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches
// ~/.claude.

test("available list: j/j moves roving focus, e equips the focused row", async ({
  page,
}) => {
  await page.goto("/#/project/moon-base");

  const list = page.getByRole("listbox", { name: "Available skills" });
  await expect(list).toBeVisible();

  // Focus the first available row — activeIndex starts at 0, so it's the active row.
  const first = list.locator(".avail-skill").first();
  await first.focus();
  await expect(first).toHaveAttribute("data-listnav-active", "true");
  const firstName = (await first.locator(".name").innerText()).trim();

  // Rove down twice; keydown binds on the container (focus-scoped).
  await page.keyboard.press("j");
  await page.keyboard.press("j");

  const active = list.locator('.avail-skill[data-listnav-active="true"]');
  await expect(active).toHaveCount(1);
  const skillName = (await active.locator(".name").innerText()).trim();
  // Focus actually moved off the first row.
  expect(skillName).not.toEqual(firstName);

  // `e` runs the secondary action = equip the focused row.
  await page.keyboard.press("e");

  // An undo toast confirms the reversible edge (equip → undo).
  await expect(page.locator(".toast-title")).toContainText(
    `Equipped ${skillName} on moon-base`,
  );
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  // The equipped skill now appears in the loadout grid.
  await expect(page.locator(".skill-grid")).toContainText(skillName);
});
