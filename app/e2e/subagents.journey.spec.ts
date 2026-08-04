import { test, expect, type Page } from "@playwright/test";

// Full sub-agent management journey against the mocked-Tauri dev server.
// Mock state is module-level and re-instantiated on each full page load, so each
// test starts from the seeded baseline and mutates within its own page session.

/** Attach a console/page-error collector; returns an assert-empty checker. */
function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return () => {
    // The mock intentionally logs warnings for unhandled commands; only fail on
    // real errors (console.error / uncaught exceptions).
    expect(errors, `browser errors during journey:\n${errors.join("\n")}`).toEqual([]);
  };
}

test("sub-agents full journey: create → edit → attach → toggle → save → disable → delete", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  // ── Open the harness-config Sub-Agents surface ──
  await page.goto("/#/harness/claude-code");
  await expect(page.getByText("Sub-Agents", { exact: false }).first()).toBeVisible();
  // Seeded user agents present.
  await expect(page.getByText("code-reviewer", { exact: true })).toBeVisible();
  await expect(page.getByText("doc-writer", { exact: true })).toBeVisible();

  // ── New sub-agent ──
  await page.getByRole("button", { name: "New sub-agent" }).first().click();
  await expect(page.getByRole("dialog").getByText("New sub-agent")).toBeVisible();
  await page.getByPlaceholder("code-reviewer").fill("journey-agent");
  await page
    .getByPlaceholder("When this agent should be used…")
    .fill("A journey-created agent for the e2e flow.");
  // Pick the "Read-only reviewer" preset.
  await page.getByRole("radio").nth(1).check();
  await page.getByRole("button", { name: "Create" }).click();

  // ── Lands in the editor ──
  await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();
  const nameInput = page.locator(".subagent-editor-form input").first();
  await expect(nameInput).toHaveValue("journey-agent");

  // ── Edit the system-prompt body ──
  const editor = page.locator(".doc-editor-body .cm-content");
  await editor.click();
  await page.keyboard.type("\n\nAdditional journey instructions.");
  await expect(page.locator(".state-pill", { hasText: "UNSAVED" })).toBeVisible();

  // ── Change the model ──
  await page.locator(".subagent-editor-form select").first().selectOption("opus");

  // ── Open the attach-skills picker; the non-invocable skill is disabled ──
  const fsMcpRow = page.locator(".subagent-skill-row", { hasText: "fs-mcp" });
  await expect(fsMcpRow).toBeVisible();
  await expect(fsMcpRow).toHaveAttribute("data-blocked", "true");
  await expect(fsMcpRow.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(fsMcpRow.getByText("not invocable")).toBeVisible();

  // Attach the attachable one (code-review).
  const codeReviewRow = page.locator(".subagent-skill-row", { hasText: "code-review" });
  await codeReviewRow.locator('input[type="checkbox"]').check();
  await expect(codeReviewRow.locator('input[type="checkbox"]')).toBeChecked();

  // ── Toggle "Can use other skills on demand" ──
  // Read-only preset → discovery toggle is enabled (Skill not auto-on).
  const discovery = page
    .locator(".subagent-toggle input[type='checkbox']")
    .first();
  await expect(discovery).toBeEnabled();
  await discovery.check();
  await expect(discovery).toBeChecked();

  // ── Save → UNSAVED clears, success toast ──
  // The primary Save button carries a "⌘S" kbd hint in its accessible name, so
  // target the visible label span (exact, to not match "Saved").
  const saveBtn = page.locator("button", {
    has: page.locator(".btn-label", { hasText: /^Save$/ }),
  });
  await saveBtn.click();
  await expect(page.locator(".toast-title", { hasText: /Saved journey-agent/ })).toBeVisible();
  await expect(page.locator(".state-pill", { hasText: "UNSAVED" })).toHaveCount(0);

  // ── Disable from the editor danger zone ──
  // (The editor toggles the deny rule; the disabled state is reflected on the
  // list card — the canonical surface the list cache feeds.)
  await page.getByRole("button", { name: /^Disable$/ }).click();

  // Back to the list — the card reflects the disabled state.
  await page.getByRole("button", { name: "Sub-agents" }).first().click();
  const journeyCard = page.locator(".subagent-card", { hasText: "journey-agent" });
  await expect(journeyCard).toHaveAttribute("data-disabled", "true");
  await expect(journeyCard.locator(".subagent-switch input")).not.toBeChecked();

  // ── Re-enable from the card switch ──
  await journeyCard.locator(".subagent-switch").click();
  await expect(journeyCard).not.toHaveAttribute("data-disabled", "true");
  await expect(journeyCard.locator(".subagent-switch input")).toBeChecked();

  // ── Delete (confirm) from the editor ──
  await journeyCard.click();
  await page.getByRole("button", { name: "Delete this agent" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();

  // Back on the list; the deleted agent is gone, the seeded ones remain.
  await expect(page.getByText("code-reviewer", { exact: true })).toBeVisible();
  await expect(page.getByText("journey-agent", { exact: true })).toHaveCount(0);

  assertNoErrors();
});

test("save is blocked inline on an invalid name", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);

  await page.goto("/#/harness/claude-code");
  await page.getByText("code-reviewer", { exact: true }).click();

  const nameInput = page.locator(".subagent-editor-form input").first();
  await expect(nameInput).toHaveValue("code-reviewer");
  await nameInput.fill("Bad Name");
  // Inline field-error appears; save is enabled (dirty) but blocks.
  await page
    .locator("button", { has: page.locator(".btn-label", { hasText: /^Save$/ }) })
    .click();
  await expect(page.locator(".field-error").first()).toBeVisible();
  // Still UNSAVED (the bad save did not clear dirty).
  await expect(page.locator(".state-pill", { hasText: "UNSAVED" })).toBeVisible();

  assertNoErrors();
});
