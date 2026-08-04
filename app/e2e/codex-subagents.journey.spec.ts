import { test, expect, type Page } from "@playwright/test";

// Codex sub-agent management journey against the mocked-Tauri dev server. Codex
// agents live in their OWN in-memory store (never bleed into the Claude list),
// carry codex-only fields (sandbox_mode, reasoning effort, free-text model id),
// and disable via a file-rename simulation. Built-ins are read-only (no toggle)
// and project scope is trust-gated (Project pill disabled). Mock state resets on
// each full page load, so every test starts from the seeded baseline.

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
    expect(errors, `browser errors during journey:\n${errors.join("\n")}`).toEqual([]);
  };
}

test("codex sub-agents: configure → list → create → edit → save → disable → re-enable → delete", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  // ── Reach /harness/codex through the Codex "Configure" affordance ──
  await page.goto("/#/harnesses");
  const codexCard = page.locator(".harness-card", { hasText: "Codex" });
  await expect(codexCard).toBeVisible();
  await codexCard.getByRole("button", { name: "Configure" }).click();

  await expect(page.locator(".subagent-list")).toBeVisible();
  // Seeded codex user agents present.
  await expect(page.getByText("pr_explorer", { exact: true })).toBeVisible();
  await expect(page.getByText("release_captain", { exact: true })).toBeVisible();

  // ── Codex built-ins are read-only — no disable toggle ──
  const builtinRow = page.locator(".subagent-builtin-row", { hasText: "default" });
  await expect(builtinRow).toBeVisible();
  await expect(builtinRow.getByText("read-only")).toBeVisible();
  await expect(builtinRow.locator(".subagent-switch")).toHaveCount(0);

  // ── Project scope is trust-gated: the Project pill is disabled + hinted ──
  const projectChip = page.locator('.subagent-scope-bar [role="tab"]', {
    hasText: "Project",
  });
  await expect(projectChip).toBeDisabled();
  await expect(
    page.getByText("Codex project agents ship later (requires project trust).").first(),
  ).toBeVisible();

  // ── New codex agent (underscore name — codex allows underscores) ──
  await page.getByRole("button", { name: "New sub-agent" }).first().click();
  await expect(page.getByRole("dialog").getByText("New sub-agent")).toBeVisible();
  // Scope select is locked to User for codex.
  await expect(page.locator(".modal-body select").first()).toBeDisabled();
  await page.getByPlaceholder("code-reviewer").fill("pr_triage_bot");
  await page
    .getByPlaceholder("When this agent should be used…")
    .fill("Triage incoming PRs with a read-only sandbox.");
  await page.getByRole("button", { name: "Create" }).click();

  // ── Lands in the codex editor ──
  await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();
  const nameInput = page.locator(".subagent-editor-form input").first();
  await expect(nameInput).toHaveValue("pr_triage_bot");

  // ── Codex behavior: model text, reasoning-effort select, sandbox radio ──
  await page.getByPlaceholder(/inherit from session/).fill("gpt-5.3-codex");
  await page.locator(".subagent-editor-form select").first().selectOption("high");
  await page.getByRole("radio", { name: "Read-only" }).check();
  await expect(page.locator(".state-pill", { hasText: "UNSAVED" })).toBeVisible();

  // ── Save → UNSAVED clears, success toast ──
  const saveBtn = page.locator("button", {
    has: page.locator(".btn-label", { hasText: /^Save$/ }),
  });
  await saveBtn.click();
  await expect(
    page.locator(".toast-title", { hasText: /Saved pr_triage_bot/ }),
  ).toBeVisible();
  await expect(page.locator(".state-pill", { hasText: "UNSAVED" })).toHaveCount(0);

  // ── Disable from the danger zone ──
  await page.getByRole("button", { name: /^Disable$/ }).click();

  // Back to the list — the card reflects the disabled state.
  await page.getByRole("button", { name: "Sub-agents" }).first().click();
  const card = page.locator(".subagent-card", { hasText: "pr_triage_bot" });
  await expect(card).toHaveAttribute("data-disabled", "true");
  await expect(card.locator(".subagent-switch input")).not.toBeChecked();

  // ── Re-enable from the card switch ──
  await card.locator(".subagent-switch").click();
  await expect(card).not.toHaveAttribute("data-disabled", "true");
  await expect(card.locator(".subagent-switch input")).toBeChecked();

  // ── Delete (confirm) from the editor ──
  await card.click();
  await page.getByRole("button", { name: "Delete this agent" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();

  // Back on the list; the created agent is gone, the seeded ones remain.
  await expect(page.getByText("pr_explorer", { exact: true })).toBeVisible();
  await expect(page.getByText("pr_triage_bot", { exact: true })).toHaveCount(0);

  assertNoErrors();
});

test("codex editor surfaces advanced TOML + read-only foreign skill entries", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  await page.goto("/#/harness/codex");
  await expect(page.locator(".subagent-list")).toBeVisible();

  // release_captain carries advanced TOML (custom_key) + one foreign, disabled
  // skills.config entry the hub does not manage.
  await page.locator(".subagent-card", { hasText: "release_captain" }).click();
  await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();

  // Advanced panel auto-opens (non-empty advanced_yaml) and is TOML-labelled.
  await expect(page.getByText("Advanced (raw TOML)")).toBeVisible();
  await expect(page.locator(".subagent-advanced-yaml")).toHaveValue(/custom_key/);

  // Foreign skill entry rendered read-only under "Other skill entries".
  await expect(page.getByText("Other skill entries")).toBeVisible();
  await expect(
    page.locator(".subagent-foreign-skills").getByText("/Users/dev/hand-authored/SKILL.md"),
  ).toBeVisible();

  assertNoErrors();
});
