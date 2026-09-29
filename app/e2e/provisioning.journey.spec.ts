import { test, expect, type Page } from "./fixtures";

// Attach-skill provisioning journey (D5) against the mocked-Tauri dev server.
// Attaching a registry-known-but-unresolved skill blocks the save with a
// consequence prompt; confirming provisions it then auto re-saves.
//   - needs-global : plain make-global → success
// The other two shapes (remote-note dead-stop, codex-only widen prompt) and
// the skill-side cross-harness attach picker are covered by
// SubagentsProvisioning.test.tsx. Mock state resets per load.


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

});

