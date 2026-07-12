import { test, expect, type Page } from "@playwright/test";

// Attach-skill provisioning journeys (D5) against the mocked-Tauri dev server.
// Attaching a registry-known-but-unresolved skill blocks the save with a
// consequence prompt; confirming provisions it then auto re-saves. Three shapes:
//   - needs-global : plain make-global → success
//   - remote-note  : remote-quarantined → dead-stop refusal (no re-save)
//   - codex-only   : harness-affinity excludes the agent → widen prompt → success
// Plus the skill-side cross-harness attach picker. Mock state resets per load.

function trackConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return () => {
    expect(errors, `browser errors during journey:\n${errors.join("\n")}`).toEqual([]);
  };
}

/** Open an agent's editor and check a provisioning skill's box, then Save. */
async function attachSkillTo(page: Page, agent: string, skill: string) {
  await page.goto("/#/harness/claude-code");
  await page.getByText(agent, { exact: true }).click();
  await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();
  const row = page.locator(".subagent-skill-row", { hasText: skill });
  await expect(row).toBeVisible();
  await row.locator('input[type="checkbox"]').check();
  await page
    .locator("button", { has: page.locator(".btn-label", { hasText: /^Save$/ }) })
    .click();
}

test("provision: needs-global → consequence prompt → confirm → provisioned + re-saved", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  await attachSkillTo(page, "doc-writer", "needs-global");

  // Save is blocked by the unresolved skill → the consequence panel appears.
  const panel = page.locator(".subagent-provision-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Makes 'needs-global' global/)).toBeVisible();

  // Confirm → provision (make-global) → auto re-save succeeds.
  await panel.getByRole("button", { name: /Make available/ }).click();
  await expect(
    page.locator(".toast-title", { hasText: /Saved doc-writer/ }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);

  assertNoErrors();
});

test("provision: remote-note is quarantined → dead-stop refusal, no re-save", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  await attachSkillTo(page, "doc-writer", "remote-note");

  const panel = page.locator(".subagent-provision-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /Make available/ }).click();

  // Dead stop: a quarantine explanation with only a Close action — no save.
  const err = panel.locator(".subagent-provision-error");
  await expect(err).toBeVisible();
  await expect(err.getByText(/quarantined/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.locator(".toast-title", { hasText: /Saved doc-writer/ })).toHaveCount(0);

  assertNoErrors();
});

test("provision: codex-only affinity → widen prompt → confirm → success", async ({
  page,
}) => {
  const assertNoErrors = trackConsoleErrors(page);

  // Attaching a codex-affinity skill to a CLAUDE agent triggers a widen prompt.
  await attachSkillTo(page, "doc-writer", "codex-only");

  const panel = page.locator(".subagent-provision-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /Make available/ }).click();

  // Second, distinct consequence: clearing the harness-affinity restriction.
  const widenNote = panel.locator(".subagent-provision-widen-note");
  await expect(widenNote).toBeVisible();
  await expect(widenNote.getByText(/restricted to/)).toBeVisible();

  await panel.getByRole("button", { name: /Widen affinity/ }).click();
  await expect(
    page.locator(".toast-title", { hasText: /Saved doc-writer/ }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);

  assertNoErrors();
});

test("skill-side attach picker surfaces agents across harnesses", async ({ page }) => {
  const assertNoErrors = trackConsoleErrors(page);

  // brainstorm is preloaded by nobody; the picker spans every agent-capable,
  // installed harness (Claude user+project AND Codex user).
  await page.goto("/#/skill/brainstorm");
  const block = page.locator(".side-panel-block", { hasText: "Preloaded by" });
  await block.getByRole("button", { name: "Attach to sub-agent…" }).click();

  const picker = page.locator(".skill-attach-picker");
  await expect(picker).toBeVisible();

  // Cross-harness: a Claude-only agent AND a Codex-only agent both surface, each
  // carrying its harness glyph.
  const claudeOption = picker.locator(".skill-attach-option", { hasText: "doc-writer" });
  const codexOption = picker.locator(".skill-attach-option", { hasText: "pr_explorer" });
  await expect(claudeOption).toBeVisible();
  await expect(codexOption).toBeVisible();
  await expect(codexOption.locator("svg, img").first()).toBeVisible();

  assertNoErrors();
});
