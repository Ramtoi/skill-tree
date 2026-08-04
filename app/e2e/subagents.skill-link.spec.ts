import { test, expect, type Page } from "@playwright/test";

function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return () => {
    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
  };
}

test("project Sub-Agents tab lists the project's agents", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);

  await page.goto("/#/project/moon-base");
  // Switch to the Sub-Agents project view via the subheader chip.
  await page
    .getByRole("tab", { name: "Sub-Agents" })
    .first()
    .click();

  // Seeded project-scope agents for moon-base are listed; user agents are not.
  await expect(page.getByText("android-planner", { exact: true })).toBeVisible();
  await expect(page.getByText("spec-runner", { exact: true })).toBeVisible();
  await expect(page.getByText("code-reviewer", { exact: true })).toHaveCount(0);

  // Scope switcher is hidden (the project fixes the scope).
  await expect(page.getByRole("tab", { name: "User" })).toHaveCount(0);

  assertNoErrors();
});

test('skill detail "Preloaded by" reflects a seeded attachment', async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);

  // code-review is preloaded by the seeded user agent `code-reviewer`.
  await page.goto("/#/skill/code-review");
  const block = page.locator(".side-panel-block", { hasText: "Preloaded by" });
  await expect(block).toBeVisible();
  await expect(block.getByText("code-reviewer", { exact: true })).toBeVisible();

  assertNoErrors();
});

test("attach-from-skill: attaching makes the skill appear preloaded", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  // brainstorm starts NOT preloaded by anyone.
  await page.goto("/#/skill/brainstorm");
  const block = page.locator(".side-panel-block", { hasText: "Preloaded by" });
  await expect(block).toBeVisible();
  await expect(block.getByText("Not preloaded by any sub-agent")).toBeVisible();

  // Open the attach picker and attach to a user agent (doc-writer).
  await block.getByRole("button", { name: "Attach to sub-agent…" }).click();
  const option = page.locator(".skill-attach-option", { hasText: "doc-writer" });
  await expect(option).toBeVisible();
  await option.click();

  // Success toast; the picker closes and the skill is now preloaded.
  await expect(
    page.locator(".toast-title", { hasText: /Attached to doc-writer/ }),
  ).toBeVisible();
  await expect(block.getByText("doc-writer", { exact: true })).toBeVisible();

  assertNoErrors();
});
