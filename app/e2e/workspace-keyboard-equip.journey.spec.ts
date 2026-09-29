import { test, expect } from "./fixtures";

// Project Workspace Available-list keyboard equip (B1-08 roving nav): j/k move a
// roving focus across the flat available list and `e` equips the focused row.
// Mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches
// ~/.claude.

test("available list: j/j moves roving focus, e equips the focused row", async ({
  page,
}) => {
  await page.goto("/#/project/moon-base");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();

  const list = page.getByRole("list", { name: "Available skills" });
  await expect(list).toBeVisible();

  // Focus the first available row's wrapper — activeIndex starts at 0, so
  // it's the active row (B1: the roving `role="listitem"` wrapper, not the
  // inner ResourceRow, is the tab stop).
  const first = list.locator(".avail-row-wrap").first();
  await first.focus();
  await expect(first).toHaveAttribute("data-listnav-active", "true");
  const firstName = (await first.locator(".resource-name").innerText()).trim();

  // Rove down twice; keydown binds on the container (focus-scoped).
  await page.keyboard.press("j");
  await page.keyboard.press("j");

  const active = list.locator('.avail-row-wrap[data-listnav-active="true"]');
  await expect(active).toHaveCount(1);
  const skillName = (await active.locator(".resource-name").innerText()).trim();
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
  await expect(page.locator(".project-grouped-loadout")).toContainText(skillName);

  // Undo restores the prior state — the equipped row returns to Available.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("button", { name: `Equip ${skillName}` }),
  ).toBeVisible();
});

// The real editor and router exercise the return contract. All IPC uses fixtures.
for (const journey of [
  { read: "click", back: "header", equip: "Enter" },
  { read: "Enter", back: "browser", equip: "e" },
  { read: "Space", back: "header", equip: "click" },
]) {
  test(`read from filtered Add skills with ${journey.read}, return by ${journey.back}, equip with ${journey.equip}`, async ({ page }) => {
    await page.goto("/#/project/skill-hub");
    await page.getByRole("button", { name: "Add skills", exact: true }).click();
    const filter = page.getByPlaceholder("Filter library…");
    await filter.fill("android");
    const rows = page.locator(".avail-row-wrap");
    const target = rows.filter({ has: page.locator('.resource-name', { hasText: /^android-compose-ui$/ }) });
    await expect(rows).toHaveCount(3);
    // This is deliberately not the first filtered result.
    await expect(rows.first()).not.toContainText("android-compose-ui");
    const read = target.getByRole("button", { name: /Read skill/ });
    if (journey.read === "click") await read.click();
    else {
      await read.focus();
      await page.keyboard.press(journey.read);
    }
    await expect(page).toHaveURL(/#\/skill\/android-compose-ui$/);
    await expect(page.locator(".doc-editor-shell")).toBeVisible();
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(page.locator(".md-prose")).toContainText("Shared Compose conventions");
    if (journey.back === "browser") await page.goBack();
    else await page.getByRole("button", { name: "Back to skill-hub" }).click();
    await expect(filter).toHaveValue("android");
    await expect(rows).toHaveCount(3);
    await expect(target).toHaveAttribute("data-listnav-active", "true");
    expect(await target.evaluate(element => element === document.activeElement || element.contains(document.activeElement))).toBe(true);
    const writes = await page.evaluate(() => window.__invokeCalls.filter(call =>
      ["save_skill_full", "skill_file_write"].includes(call.cmd) ||
      (call.cmd === "hub_cmd" && ["enable", "disable", "set-meta", "update", "sync"].includes(((call.args as { args?: string[] } | undefined)?.args)?.[0] ?? "")),
    ));
    expect(writes).toEqual([]);
    if (journey.equip === "click") await target.getByRole("button", { name: "Equip android-compose-ui", exact: true }).click();
    else await page.keyboard.press(journey.equip);
    await expect(page.locator(".toast-title")).toContainText("Equipped android-compose-ui on skill-hub");
    await expect(page.locator(".project-grouped-loadout")).toContainText("android-compose-ui");
    const enables = await page.evaluate(() => window.__invokeCalls.filter(call => call.cmd === "hub_cmd" && ((call.args as { args?: string[] } | undefined)?.args)?.[0] === "enable"));
    expect(enables).toHaveLength(1);
    expect((enables[0].args as { args?: string[] })?.args).toContain("android-compose-ui");
  });
}

test("read skill keeps the unsaved editor guard and returns to the filtered picker after discard", async ({ page }) => {
  await page.goto("/#/project/skill-hub");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
  const filter = page.getByPlaceholder("Filter library…");
  await filter.fill("rt-android");
  await page.locator(".avail-row-wrap").getByRole("button", { name: /Read skill/ }).click();
  const editor = page.locator(".doc-editor-body .cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("UNSAVED_READ_JOURNEY\n");
  const back = page.getByRole("button", { name: "Back to skill-hub" });
  await back.click();
  const guard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toContainText("UNSAVED_READ_JOURNEY");
  await back.click();
  await guard.getByRole("button", { name: "Discard and leave" }).click();
  await expect(filter).toHaveValue("rt-android");
  await expect(page.locator(".avail-row-wrap")).toHaveCount(1);
  const writes = await page.evaluate(() => window.__invokeCalls.filter(call =>
    ["save_skill_full", "skill_file_write"].includes(call.cmd) || (call.cmd === "hub_cmd" && ((call.args as { args?: string[] } | undefined)?.args)?.[0] === "enable"),
  ));
  expect(writes).toEqual([]);
});

test("returning from a late available skill restores visible focus in the scrolling picker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/#/project/skill-hub");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
  const panel = page.locator(".loadout-library-panel .workspace-side");
  const row = panel.locator(".avail-row-wrap").last();
  const name = (await row.locator(".resource-name").innerText()).trim();
  await row.getByRole("button", { name: /Read skill/ }).click();
  await expect(page.locator(".doc-editor-shell")).toBeVisible();
  await page.getByRole("button", { name: "Back to skill-hub" }).click();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("data-listnav-active", "true");
  await expect(row.locator(".resource-name")).toHaveText(name);
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const viewport = (await panel.boundingBox())!;
  const item = (await row.boundingBox())!;
  expect(item.y).toBeGreaterThanOrEqual(viewport.y);
  expect(item.y + item.height).toBeLessThanOrEqual(viewport.y + viewport.height);
});
