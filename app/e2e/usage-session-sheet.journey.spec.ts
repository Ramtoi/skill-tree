import { test, expect, type Page } from "./fixtures";

// The session drill-down sheet (docs/changes/DESIGN-usage-numbers/PLAN.md §R5/W2): open a
// session's own transcript on demand, step through its tool calls with the
// keyboard, and close it. Mocked-Tauri dev server (VISUAL_MOCK=1 →
// src/mocks/tauriCore.ts + src/mocks/tauriUsageAnalytics.ts). NEVER touches
// ~/.claude.

const CLAUDE_SESSION = "eeeeeeee-6666-4666-8666-666666666666";

for (const state of ["observed", "partial", "unavailable"] as const) {
  test(`expanded session preserves ${state} native evidence`, async ({ page }) => {
    await page.goto(`/?inspection=1&usageNative=${state}#/usage`);
    const row = page.locator(`[data-session-id="${CLAUDE_SESSION}"]`);
    await row.locator(".usage-session-title, .usage-session-fallback").first().click();
    const detail = row.locator(".usage-session-detail");
    if (state === "unavailable") {
      await expect(detail.getByText("Tool calls", { exact: true })).toHaveCount(0);
      await expect(detail.getByText("+12 / −3")).toHaveCount(0);
      await expect(detail.getByRole("button", { name: "PR #42" })).toHaveCount(0);
    } else {
      await expect(detail.getByText("+12 / −3")).toBeVisible();
      await expect(detail.getByText("feature/native-parity")).toBeVisible();
      await expect(detail.getByRole("button", { name: "PR #42" })).toBeVisible();
      if (state === "partial") {
        await expect(detail.getByText("At least 2", { exact: true })).toBeVisible();
        await expect(detail.getByText("Top tools (partial)")).toBeVisible();
      } else {
        await expect(detail.getByText("Agent 1 · Bash 1")).toBeVisible();
      }
    }
    await detail.getByRole("button", { name: "Inspect session" }).click();
    await expect(page.getByTestId("usage-session-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeVisible();
  });
}

// Own tokens and provider-token coverage on the row (folded from the
// dedicated usage-token-coverage spec: the 520px run measured no geometry,
// TESTS.md section 3).
test("session own tokens and incomplete coverage", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const coverage of ["complete", "partial"]) {
    await page.goto(`/?inspection=1&usageTokens=${coverage}#/usage`);
    const row = page.locator(`[data-session-id="${CLAUDE_SESSION}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".usage-row-numbers > b")).toHaveText(coverage === "complete" ? "110" : "820");
    if (coverage === "partial") {
      await expect(row).toContainText("Provider tokens · partial capture");
      await expect(row).toHaveAccessibleName(/820 tokens, provider token totals, partial capture/);
    }
    else await expect(row).not.toContainText("partial capture");
    await row.locator(".usage-session-title, .usage-session-fallback").first().click();
    await expect(row.locator(".usage-session-detail")).toBeVisible();
    await expect(row.locator(".usage-session-detail")).toContainText("provider tokens");
  }
});

async function openCapturedClaudeSheet(page: Page) {
  await page.goto("/?inspection=1#/usage");
  await expect(page.getByText("Largest sessions")).toBeVisible();

  // Open the first session's row detail, then its drill-down sheet. Click the
  // row's own name (never its bounding-box center — the first, highest-token
  // fixture session also carries a PR link chip that stops propagation, and a
  // center click can land on it instead of the row).
  const row = page.locator(`[data-session-id="${CLAUDE_SESSION}"]`);
  await expect(row).toBeVisible();
  await row.locator(".usage-session-title, .usage-session-fallback").first().click();
  await page.getByRole("button", { name: "Inspect session" }).click();
}

test("inspect a session, select its agent, step through evidence, and close the sheet", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openCapturedClaudeSheet(page);

  const sheet = page.locator('[data-testid="usage-session-sheet"]');
  await expect(sheet).toBeVisible();

  await test.step("wears the usage hue as its context accent inside the sheet", async () => {
    // The sheet portals outside `.app-main`, so it would otherwise inherit
    // the :root anchor and draw lanes, waits and rings in one violet.
    const accents = await sheet.evaluate((node) => {
      const style = getComputedStyle(node);
      const read = (name: string) => style.getPropertyValue(name).trim();
      return { ctx: read("--ctx"), ctx2: read("--ctx-2"), anchor: read("--anchor"), section: read("--sec-agents") };
    });
    expect.soft(accents.ctx).not.toBe("");
    expect.soft(accents.ctx).not.toBe(accents.anchor);
    expect.soft(accents.ctx2).not.toBe(accents.anchor);
    // Derived from the usage rail group's hue, not an invented colour.
    expect.soft(accents.section).not.toBe("");
  });

  await test.step("timeline lanes: Main session and agent", async () => {
    await expect(sheet.getByRole("radio", { name: "Timeline" })).toBeChecked();
    await expect(sheet.getByTestId("usage-inspection-lane").first()).toContainText("Main session");
    await expect(sheet.getByTestId("usage-inspection-lane").nth(1)).toContainText("agent");
    const gapToggle = sheet.getByRole("button", { name: "Expand quiet gaps" });
    await expect(gapToggle).toHaveAttribute("aria-pressed", "true");
    await gapToggle.click();
    await expect(sheet.getByRole("button", { name: "Collapse quiet gaps" })).toHaveAttribute("aria-pressed", "false");
    await expect(sheet.getByRole("region", { name: "Main session statistics" })).toBeVisible();

    await sheet.getByTestId("usage-inspection-lane").nth(1).click();
    await expect(sheet.getByRole("region", { name: "agent statistics" })).toBeVisible();
  });

  await test.step("Tool calls body", async () => {
    await sheet.getByRole("button", { name: "Open Tool calls for this agent" }).click();
    await expect(sheet.getByRole("radio", { name: "Tool calls" })).toBeChecked();
    await expect(sheet.locator(".usage-tool-group-toggle").first()).toBeVisible();
    await sheet.locator(".usage-tool-group-toggle").first().click();
    await sheet.getByRole("button", { name: /Input: available/ }).click();
    await expect(sheet.getByRole("region", { name: "Captured body" })).toContainText("printf child");
  });

  await test.step("Changes: open retained patch body and copy", async () => {
    await sheet.getByRole("radio", { name: "Changes" }).click();
    await expect(sheet.locator(".usage-inspection-change")).toContainText("demo.txt");
    const confirmedPatch = sheet.locator(".usage-inspection-change").filter({ hasText: "confirmed" }).filter({ hasText: "demo.txt" }).first();
    await expect(confirmedPatch).toContainText("tool patch");
    await confirmedPatch.getByRole("button", { name: "Open retained patch body" }).click();
    await expect(sheet.getByRole("region", { name: "Captured body" }).locator("pre")).toContainText(/\*\*\* Add File|old|new/);
    const body = sheet.getByRole("region", { name: "Captured body" });
    await body.getByRole("button", { name: "Copy displayed text" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await body.locator("pre").textContent());
  });

  await test.step("scrolls the inspector body inside the sheet at 420px height", async () => {
    // The sheet is a fixed-height overlay: a long lane list or tool-call
    // list has to scroll INSIDE it, instead of running past the sheet's
    // bottom edge with no way to reach the rest.
    await page.setViewportSize({ width: 1280, height: 420 });
    const content = sheet.locator(".usage-inspection-content");
    await expect(content).toBeVisible();
    const geometry = await content.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY, bottom: box.bottom };
    });
    expect.soft(geometry.overflowY).toBe("auto");
    expect.soft(geometry.clientHeight).toBeLessThan(420);
    expect.soft(geometry.bottom).toBeLessThanOrEqual(420);
    const sheetBox = await sheet.boundingBox();
    expect.soft(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(421);
  });

  // Close via Escape.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

for (const width of [2048, 1440, 1024, 760]) {
  test(`session details give the inspect action its own row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/?inspection=1#/usage");
    const row = page.locator(`[data-session-id="${CLAUDE_SESSION}"]`);
    await row.locator(".usage-session-title, .usage-session-fallback").first().click();
    const detail = row.locator(".usage-session-detail");
    const inspect = detail.getByRole("button", { name: "Inspect session" });
    await expect(inspect).toBeVisible();
    const buttonBox = (await inspect.boundingBox())!;
    for (const block of await detail.locator(".usage-detail-block").all()) {
      const box = (await block.boundingBox())!;
      expect(buttonBox.y).toBeGreaterThanOrEqual(box.y + box.height);
    }
    const models = detail.getByRole("list", { name: "Models", exact: true });
    await expect(models).toBeVisible();
    for (const label of await models.locator(".usage-model-text, .hbar-sub").all()) {
      expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await inspect.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("usage-session-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("usage-session-sheet")).toBeHidden();
    await expect(detail).toBeVisible();
  });
}
