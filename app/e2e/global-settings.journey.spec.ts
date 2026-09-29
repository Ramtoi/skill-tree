import { test, expect } from "./fixtures";
import { gotoReady } from "./helpers";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 520, height: 900 },
  { width: 520, height: 420 },
  { width: 800, height: 420 },
]) {
  test(`Settings keeps its frame stable and scrolls content at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/#/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
    // Wait for the shared modal entrance animation before measuring its frame.
    await expect(dialog).toHaveCSS("transform", "none");
    const frame = await dialog.boundingBox();
    expect(frame!.y).toBeGreaterThanOrEqual(0);
    expect(frame!.y + frame!.height).toBeLessThanOrEqual(viewport.height);
    const navigation = dialog.getByRole("navigation", { name: "Settings categories" });
    const navigationFrame = await navigation.boundingBox();

    for (const category of ["Agents", "Worktrees", "Usage", "Backup", "Appearance"]) {
      if (viewport.width <= 620) {
        await dialog.getByRole("combobox", { name: "Settings category" }).click();
        await page.getByRole("option", { name: category, exact: true }).click();
      } else {
        await navigation.getByRole("button", { name: category, exact: true }).click();
      }
      await expect(dialog.getByRole("heading", { name: category, exact: true })).toBeVisible();
      await expect.poll(() => dialog.boundingBox()).toEqual(frame);
      const panel = dialog.locator(".settings-category-panel:not([hidden])");
      await expect.poll(() => panel.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollHeight - el.clientHeight - el.scrollTop;
      })).toBeLessThanOrEqual(1);
      if (category === "Worktrees") {
        // The poll above already proves the panel sits at its scroll bottom; a
        // bare scrollTop > 0 pin only asserted that Worktrees overflows this
        // viewport, which is borderline at 1440x900 and flaked on CI.
        await expect(dialog.getByRole("button", { name: "Save defaults", exact: true })).toBeInViewport();
      }
      await expect.poll(() => navigation.boundingBox()).toEqual(navigationFrame);
      await expect.poll(() => dialog.boundingBox()).toEqual(frame);
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  });
}

test("Settings preserves an editor draft and suppresses background shortcuts", async ({ page }) => {
  await gotoReady(page, "/#/skill/rt-android-expert");
  const editor = page.locator(".doc-editor-body .cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("SETTINGS_UNSAVED_MARKER\n");
  const dirty = page.locator(".doc-editor-bar-right .btn-signal");
  await expect(dirty).toBeVisible();

  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/#\/skill\/rt-android-expert$/);
  await expect(dirty).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("SETTINGS_UNSAVED_MARKER");
  await expect(dirty).toBeVisible();

  // A Settings link must preserve the editor's own navigation guard.
  await page.keyboard.press("ControlOrMeta+,");
  await dialog.getByRole("button", { name: "Backup", exact: true }).click();
  await dialog.getByRole("button", { name: "Manage backup" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText(/unsaved/i);
  await expect(page).toHaveURL(/#\/skill\/rt-android-expert$/);
});

test("Settings stays reachable with navigation hidden and persists appearance", async ({ page }) => {
  await page.goto("/#/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Show navigator", { exact: true }).click();
  await page.getByLabel("Show icon rail", { exact: true }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-rail", "false");
  await expect(page.locator(".app")).toHaveAttribute("data-nav", "false");
  await page.keyboard.press("Escape");
  const opener = page.getByRole("button", { name: "Settings", exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toBeFocused();
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-rail", "false");
  await expect(page.locator(".app")).toHaveAttribute("data-nav", "false");
  await opener.click();
  await expect(page.getByLabel("Show icon rail", { exact: true })).not.toBeChecked();
});

test("palette hands focus to Settings without leaving the current route", async ({ page }) => {
  await page.goto("/#/project/notes-vault");
  await expect(page.locator(".app-main")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder(/Jump to skill/).fill("settings");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByPlaceholder(/Jump to skill/)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/project\/notes-vault$/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
});

test("Settings does not open over an existing modal", async ({ page }) => {
  await page.goto("/#/bundle/android");
  await page.locator(".main-header").getByTestId("overflow-trigger").click();
  await page.getByRole("menuitem", { name: "Delete bundle…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  await test.step("Tab stays trapped inside the open dialog", async () => {
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect.soft(focusInside).toBe(true);
  });

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);

  // Esc still dismisses the ConfirmDialog underneath.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});


test("Agents settings saves policy without sync and retries a failed save", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ cmd: string; args?: { args?: string[] } }> = [];
    Object.assign(window, { settingsCalls: calls });
    window.addEventListener("settings-mock-command", (event) => {
      calls.push((event as CustomEvent).detail);
    });
  });
  await page.goto("/?settingsProbe=1&settingsWriteFails=1#/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  // Pick a global policy. A failed write must keep the current saved value.
  const strategy = dialog.getByRole("combobox", { name: "Agent Docs linking" });
  await strategy.click();
  await page.getByRole("option", { name: /^Import/ }).click();
  await expect(dialog.getByRole("alert")).toContainText(/save linking policy/);
  await page.evaluate(() => history.replaceState(null, "", "/?settingsProbe=1#/"));
  await dialog.getByRole("button", { name: /Retry/ }).click();
  await expect(strategy).toBeEnabled();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(dialog).toContainText(/Fix layout/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(strategy).toContainText("Import");
  const calls = await page.evaluate(() => (window as unknown as {
    settingsCalls: Array<{ cmd: string; args?: { args?: string[] } }>;
  }).settingsCalls);
  expect(calls.some((c) => c.cmd === "agent_docs_strategy_set")).toBe(true);
  expect(calls.filter((c) => ["sync", "run_sync", "agent_docs_fix_apply", "agent_docs_publish_now", "backup_now"].includes(c.cmd) ||
    c.cmd === "hub_cmd" && c.args?.args?.[0] === "sync")).toEqual([]);
});


test("Settings preserves Library search and fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await gotoReady(page, "/#/");
  const search = page.getByTestId("floating-search-input");
  await search.fill("android");
  const before = await page.locator(".lib-list").innerText();
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const category = dialog.getByRole("combobox", { name: "Settings category" });
  await category.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Agent Docs linking");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(520);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("android");
  expect(await page.locator(".lib-list").innerText()).toBe(before);
});


test("degraded mode keeps Appearance usable and explains unavailable agent settings", async ({ page }) => {
  await gotoReady(page, "/?pythonError=1#/");
  await page.getByRole("button", { name: /Continue in degraded mode/i }).click();
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Show navigator" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-nav", "false");
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog).toContainText(/unavailable/);
  await expect(dialog.getByRole("combobox", { name: "Agent Docs linking" })).toHaveCount(0);
});
