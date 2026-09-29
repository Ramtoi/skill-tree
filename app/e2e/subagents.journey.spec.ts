import { test, expect, type Page } from "./fixtures";

// Sub-agent management journeys against the mocked-Tauri dev server. Mock
// state is module-level and re-instantiated on each full page load, so each
// test starts from the seeded baseline and mutates within its own page
// session.

/** The skill editor's SUB-AGENTS block is a closed-by-default disclosure whose
 *  head carries the count; open it and return the section. Moved from
 *  subagents.skill-link.spec.ts (merged into this file). */
async function openSubagentsBlock(page: Page) {
  const head = page.locator('[data-testid="side-section-subagents"]');
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  return page.locator('[data-section-id="subagents"]');
}

// ─── Harness table: create → edit → pick a known and a custom model → save →
// disable → re-enable → delete, for each harness's own store and fields ────

type HarnessRow = {
  harness: string;
  agentName: string;
  description: string;
  open: (page: Page) => Promise<void>;
  listChecks: (page: Page) => Promise<void>;
  dialogChecks?: (page: Page) => Promise<void>;
  pickPreset?: (page: Page) => Promise<void>;
  edit: (page: Page) => Promise<void>;
  known: string;
};

const HARNESSES: HarnessRow[] = [
  {
    harness: "claude-code",
    agentName: "journey-agent",
    description: "A journey-created agent for the e2e flow.",
    open: async (page) => {
      await page.goto("/#/harness/claude-code");
      await expect(page.getByText("Sub-Agents", { exact: false }).first()).toBeVisible();
    },
    listChecks: async (page) => {
      // Seeded user agents present.
      await expect(page.getByText("code-reviewer", { exact: true })).toBeVisible();
      await expect(page.getByText("doc-writer", { exact: true })).toBeVisible();
    },
    // Pick the "Read-only reviewer" preset so the discovery toggle below is
    // enabled (it disables when tools_mode is "all", the Blank default).
    pickPreset: async (page) => {
      await page.getByRole("radio").nth(1).check();
    },
    edit: async (page) => {
      // Edit the system-prompt body.
      const editor = page.locator(".doc-editor-body .cm-content");
      await editor.click();
      await page.keyboard.type("\n\nAdditional journey instructions.");
      await expect(page.locator(".doc-editor-bar-right .btn-signal")).toBeVisible();

      // Open the attach-skills picker; the non-invocable skill is disabled.
      const fsMcpRow = page.locator(".subagent-skill-row", { hasText: "fs-mcp" });
      await expect(fsMcpRow).toBeVisible();
      await expect(fsMcpRow).toHaveAttribute("data-blocked", "true");
      await expect(fsMcpRow.locator('input[type="checkbox"]')).toBeDisabled();
      await expect(fsMcpRow.getByText("not invocable")).toBeVisible();

      // Attach the attachable one (code-review).
      const codeReviewRow = page.locator(".subagent-skill-row", { hasText: "code-review" });
      await codeReviewRow.locator('input[type="checkbox"]').check();
      await expect(codeReviewRow.locator('input[type="checkbox"]')).toBeChecked();

      // Toggle "Can use other skills on demand".
      const discovery = page
        .locator(".subagent-toggle input[type='checkbox']")
        .first();
      await expect(discovery).toBeEnabled();
      await discovery.check();
      await expect(discovery).toBeChecked();
    },
    known: "opus",
  },
  {
    harness: "codex",
    agentName: "pr_triage_bot",
    description: "Triage incoming PRs with a read-only sandbox.",
    // Reach /harness/codex through the Codex "Configure" affordance.
    open: async (page) => {
      await page.goto("/#/harnesses");
      // Match the card's NAME element, not its whole text: a card's body
      // carries other harnesses' names (the Claude Code card mentions
      // Codex), so `hasText` over the container matched two cards.
      const codexCard = page
        .locator(".harness-card")
        .filter({ has: page.locator(".harness-card-name", { hasText: /^Codex$/ }) });
      await expect(codexCard).toBeVisible();
      // The card's single "Configure" button was replaced by named entry
      // rows ("Sub-agents", "Global instructions").
      await codexCard.getByRole("button", { name: /^Sub-agents\b/ }).click();
      await expect(page.locator(".subagent-list")).toBeVisible();
    },
    listChecks: async (page) => {
      // Seeded codex user agents present.
      await expect(page.getByText("pr_explorer", { exact: true })).toBeVisible();
      await expect(page.getByText("release_captain", { exact: true })).toBeVisible();

      // Codex built-ins are read-only — no disable toggle.
      const builtinRow = page.locator(".subagent-builtin-row", { hasText: "default" });
      await expect(builtinRow).toBeVisible();
      await expect(builtinRow.getByText("read-only")).toBeVisible();
      await expect(builtinRow.locator(".subagent-switch")).toHaveCount(0);

      // Project scope is trust-gated: the Project pill is disabled + hinted.
      const projectChip = page.locator('.subagent-scope-bar [role="tab"]', {
        hasText: "Project",
      });
      await expect(projectChip).toBeDisabled();
      await expect(
        page.getByText("Codex project agents ship later (requires project trust).").first(),
      ).toBeVisible();
    },
    dialogChecks: async (page) => {
      // Scope select is locked to User for codex.
      await expect(page.locator(".modal-body select").first()).toBeDisabled();
    },
    edit: async (page) => {
      // Codex behavior: reasoning-effort select, sandbox radio.
      await page.getByRole("combobox", { name: "Reasoning effort" }).click();
      await page.getByRole("option", { name: "high", exact: true }).click();
      await page.getByRole("radio", { name: "Read-only" }).check();
      await expect(page.locator(".doc-editor-bar-right .btn-signal")).toBeVisible();
    },
    known: "gpt-5.3-codex",
  },
];

for (const row of HARNESSES) {
  test(`${row.harness} sub-agents: create, edit, pick a known and a custom model, save, disable, re-enable and delete`, async ({
    page,
  }) => {
    // ── Open the harness's Sub-Agents surface ──
    await row.open(page);
    await row.listChecks(page);

    // ── New sub-agent ──
    await page.getByRole("button", { name: "New sub-agent" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New sub-agent")).toBeVisible();
    if (row.dialogChecks) await row.dialogChecks(page);
    if (row.pickPreset) await row.pickPreset(page);
    await page.getByPlaceholder("code-reviewer").fill(row.agentName);
    await page
      .getByPlaceholder("When this agent should be used…")
      .fill(row.description);
    // Scoped to the dialog: an ambient NavPanel row ("AGENTS.md not
    // created") also matches the bare name "Create" (its accessible name
    // contains "created").
    await dialog.getByRole("button", { name: "Create" }).click();

    // ── Lands in the editor ──
    await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();
    // The name lives in the header now (InlineName), not the form.
    const nameField = page.getByRole("button", { name: /Rename agent name/i });
    await expect(nameField).toHaveText(row.agentName);

    // ── Harness-specific edit (body/skills/discovery, or reasoning/sandbox) ──
    await row.edit(page);

    // ── Pick the known model (themed `Select` combobox, not a native <select>) ──
    const model = page.getByRole("combobox", { name: "Model", exact: true });
    await model.click();
    await page.getByRole("option", { name: row.known, exact: true }).click();

    // ── Save → the unsaved dot on Save clears, success toast, Save disabled ──
    // The primary Save button carries a "⌘S" kbd hint in its accessible
    // name, so target the visible label span (exact, to not match "Saved").
    const saveBtn = page.locator("button", {
      has: page.locator(".btn-label", { hasText: /^Save$/ }),
    });
    await saveBtn.click();
    await expect(
      page.locator(".toast-title", { hasText: new RegExp(`Saved ${row.agentName}`) }),
    ).toBeVisible();
    await expect(page.locator(".doc-editor-bar-right .btn-signal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Save/ })).toBeDisabled();

    // ── Enter a custom model, choose the known model back, then save again ──
    await page.getByRole("button", { name: "Enter custom model" }).click();
    const custom = page.getByRole("textbox", { name: "Model", exact: true });
    await expect.soft(custom).toBeFocused();
    await expect.soft(custom).toHaveValue(row.known);
    await custom.fill("provider/private-model");
    await page.getByRole("button", { name: "Choose known model" }).click();
    await expect.soft(model).toBeFocused();
    await expect.soft(model).toHaveText(/provider\/private-model/);
    await saveBtn.click();
    await expect.soft(page.getByRole("button", { name: /^Save/ })).toBeDisabled();

    // ── Disable from the editor danger zone ──
    // (The editor toggles the deny rule / codex file rename; the disabled
    // state is reflected on the list card — the canonical surface the list
    // cache feeds.)
    await page.getByRole("button", { name: /^Disable$/ }).click();

    // Back to the list — the card reflects the disabled state.
    await page.locator(".header-back").click();
    const card = page.locator(".subagent-card", { hasText: row.agentName });
    await expect(card).toHaveAttribute("data-disabled", "true");
    await expect(card.locator(".subagent-switch input")).not.toBeChecked();

    // ── Re-enable from the card switch ──
    await card.locator(".subagent-switch").click();
    await expect(card).not.toHaveAttribute("data-disabled", "true");
    await expect(card.locator(".subagent-switch input")).toBeChecked();

    // ── Reopen: the custom model survives the disable / re-enable round
    // trip. For Codex this goes through the file-rename path, a stronger
    // check than a plain save/reload. ──
    await card.click();
    await expect(
      page.getByRole("textbox", { name: "Model", exact: true }),
    ).toHaveValue("provider/private-model");

    // ── Delete (confirm) from the editor ──
    await page.getByRole("button", { name: "Delete this agent" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    // Back on the list; the deleted agent is gone.
    await expect(page.getByText(row.agentName, { exact: true })).toHaveCount(0);
  });
}

// ─── Moved from subagents.skill-link.spec.ts (merged into this file) ───────

test("project Sub-Agents tab lists the project's agents", async ({ page }) => {

  await page.goto("/#/project/moon-base");
  // Switch to the Sub-Agents project view via its area card.
  await page
    .getByRole("navigation", { name: "Project areas" })
    .getByRole("button", { name: /^Sub-Agents/ })
    .click();

  // Seeded project-scope agents for moon-base are listed; user agents are not.
  await expect(page.getByText("android-planner", { exact: true })).toBeVisible();
  await expect(page.getByText("spec-runner", { exact: true })).toBeVisible();
  await expect(page.getByText("code-reviewer", { exact: true })).toHaveCount(0);

  // Scope switcher is hidden (the project fixes the scope).
  await expect(page.getByRole("tab", { name: "User" })).toHaveCount(0);

});

test("attach-from-skill: attaching makes the skill appear preloaded", async ({
  page,
}) => {

  // Folded from 'skill detail "Preloaded by" reflects a seeded attachment':
  // code-review is preloaded by the seeded user agent `code-reviewer`.
  await test.step('skill detail "Preloaded by" reflects a seeded attachment', async () => {
    await page.goto("/#/skill/code-review");
    const seededBlock = await openSubagentsBlock(page);
    await expect.soft(seededBlock).toBeVisible();
    await expect.soft(seededBlock.getByText("code-reviewer", { exact: true })).toBeVisible();
  });

  await test.step("attach-from-skill: attaching makes the skill appear preloaded", async () => {
    // brainstorm starts NOT preloaded by anyone.
    await page.goto("/#/skill/brainstorm");
    const block = await openSubagentsBlock(page);
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
  });

});
