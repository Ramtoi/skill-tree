import { test, expect, type Page, type Locator } from "./fixtures";

async function openPicker(page: Page) {
  await page.getByRole("button", { name: "Choose permission type" }).click();
  await page.getByRole("button", { name: /^MCP permissions/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP permissions" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function choose(container: Locator, target: string, decision: string) {
  await container.getByRole("combobox", { name: `${target} permission`, exact: true }).click();
  await container.getByRole("option", { name: decision, exact: true }).click();
}
function selected(container: Locator, target: string) {
  return container.getByRole("combobox", { name: `${target} permission`, exact: true });
}

test("MCP multi-edit save persists after leaving and returning without a live Check", async ({ page }) => {
  await page.goto("/#/skill/context7");
  const block = page.getByTestId("mcp-permissions-block");
  await expect(selected(block, "search_docs")).toBeVisible();
  await choose(block, "All tools", "Ask");
  await choose(block, "search_docs", "Deny");
  await expect(block.getByTestId("mcp-permission-staged")).toBeVisible();
  await block.getByRole("button", { name: "Save permissions", exact: true }).click();
  await expect(block.getByTestId("mcp-permission-staged")).toHaveCount(0);
  await expect(page.getByTestId("mcp-check-button")).toHaveText("Check");
  // Hash-only navigation keeps the preview's in-memory registry alive.
  await page.goto("/#/");
  await page.goto("/#/skill/context7");
  await expect(selected(block, "All tools")).toHaveText("Ask");
  await expect(selected(block, "search_docs")).toHaveText("Deny");
});

test("Permissions picker stages a second MCP server and Cancel preserves the saved rule", async ({ page }) => {
  await page.goto("/#/permissions");
  let dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("fs-mcp");
  await choose(dialog, "All tools", "Deny");
  await dialog.getByRole("button", { name: "Add permissions", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('input[value="mcp__fs-mcp"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Save & apply" }).click();
  await expect(page.getByRole("button", { name: "Save & apply" })).toBeDisabled();
  dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("fs-mcp");
  await expect(selected(dialog, "All tools")).toHaveText("Deny");
  await choose(dialog, "All tools", "Ask");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("fs-mcp");
  await expect(selected(dialog, "All tools")).toHaveText("Deny");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Personal MCP permissions persist without appearing in Shared or Global", async ({ page }) => {
  await page.goto("/#/project/moon-base?tab=permissions");
  const tier = page.getByRole("group", { name: "Permission tier" });
  await tier.getByRole("button", { name: "Personal", exact: true }).click();
  const dialog = await openPicker(page);
  await expect(dialog).toContainText("Personal");
  await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("context7");
  await choose(dialog, "All tools", "Ask");
  await dialog.getByRole("button", { name: "Add permissions", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save & apply" }).click();
  await expect(page.getByRole("button", { name: "Save & apply" })).toBeDisabled();
  await tier.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(page.locator('input[value="mcp__context7"]')).toHaveCount(0);
  await tier.getByRole("button", { name: "Personal", exact: true }).click();
  await expect(page.locator('input[value="mcp__context7"]')).toHaveCount(1);
  await page.goto("/#/permissions");
  await expect(page.locator('input[value="mcp__context7"]')).toHaveCount(0);
});

// Cut: the 520px run measured no geometry (the Popover clamps itself to the
// viewport, and nothing here asserts it) — one row at 1440 is enough.
test("Usage Add saves a Global MCP preset and Cancel preserves it at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/usage");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add permission presets" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeFocused();
  async function openUsagePreset() {
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const presets = page.getByRole("dialog", { name: "Add permission presets" });
    await expect(presets).toContainText("Permission presets");
    await presets.getByRole("button", { name: "MCP permissions", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add MCP permissions" });
    await expect(dialog).toContainText("Global");
    await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("context7");
    return dialog;
  }
  let dialog = await openUsagePreset();
  await choose(dialog, "All tools", "Ask");
  await choose(dialog, "search_docs", "Deny");
  await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/usage$/);
  dialog = await openUsagePreset();
  await expect(selected(dialog, "All tools")).toHaveText("Ask");
  await expect(selected(dialog, "search_docs")).toHaveText("Deny");
  await choose(dialog, "All tools", "Deny");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openUsagePreset();
  await expect(selected(dialog, "All tools")).toHaveText("Ask");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeFocused();
  await page.goto("/#/skill/context7");
  await expect(selected(page.getByTestId("mcp-permissions-block"), "All tools")).toHaveText("Ask");
});
