import { test, expect } from "./fixtures";

// Linked-twin sub-agent journeys against the mocked-Tauri dev server. A linked
// agent shares one core across the Claude + Codex files; a divergent field is
// surfaced as drift (frozen until resolved), and a same-named unlinked pair is
// surfaced as a suggestion. Mock state resets on each full page load.


test("linked twin: drift banner → resolve → edit shared field → co-write toast", async ({
  page,
}) => {

  // shared-agent is linked (claude+codex) with a drifted `description`.
  await page.goto("/#/harness/claude-code");
  await page.getByText("shared-agent", { exact: true }).click();
  await expect(page.getByRole("button", { name: /^Sav/ })).toBeVisible();

  // ── Drift banner shows BOTH sides' description values ──
  const banner = page.locator(".subagent-drift-banner");
  await expect(banner).toBeVisible();
  await expect(
    banner.getByText("Shared agent — the Claude-side description."),
  ).toBeVisible();
  await expect(
    banner.getByText("Shared agent — the Codex-side description (drifted)."),
  ).toBeVisible();

  // ── The drifted field is locked in the form ──
  await expect(page.locator(".subagent-drift-lockhint").first()).toBeVisible();
  const descField = page.locator(".subagent-editor-form textarea").first();
  await expect(descField).toHaveAttribute("readonly", "");

  // ── Resolve keeping the Claude side (the default winner is the shown harness) ──
  await banner.getByRole("button", { name: /Apply resolution/ }).click();
  await expect(page.locator(".toast-title", { hasText: /resolved/ })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // ── The field is now editable; a shared-core edit co-writes the twin ──
  await expect(descField).not.toHaveAttribute("readonly", "");
  await descField.fill("Shared agent — unified description.");
  await expect(page.locator(".doc-editor-bar-right .btn-signal")).toBeVisible();

  const saveBtn = page.locator("button", {
    has: page.locator(".btn-label", { hasText: /^Save$/ }),
  });
  await saveBtn.click();

  // Co-write surfaces an "also updated Codex" note on the success toast.
  await expect(
    page.locator(".toast-title", { hasText: /Saved shared-agent/ }),
  ).toBeVisible();
  await expect(page.getByText("Also updated Codex.")).toBeVisible();
  await expect(page.locator(".doc-editor-bar-right .btn-signal")).toHaveCount(0);

});

test("link suggestion: link a same-named pair, then unlink → suggestion returns", async ({
  page,
}) => {

  // twin-suggest exists in both stores but is NOT linked → suggestion chip.
  await page.goto("/#/harness/claude-code");
  const card = page.locator(".subagent-card", { hasText: "twin-suggest" });
  await expect(card).toBeVisible();
  const suggestChip = card.locator('.subagent-link-chip[data-tone="suggest"]');
  await expect(suggestChip).toBeVisible();

  // ── Link from the suggestion chip → durable link chip on the card ──
  await suggestChip.click();
  await expect(
    card.locator('.subagent-link-chip[data-tone="linked"]'),
  ).toBeVisible();

  // ── Open the editor and unlink ──
  // Linked twin is now a `SidePanelSection` (a button head, not a heading),
  // closed by default.
  await card.click();
  await page.getByRole("button", { name: /^Linked twin/ }).click();
  await page.getByRole("button", { name: "Unlink" }).click();
  await expect(
    page.locator(".toast-title", { hasText: /Unlinked twin-suggest/ }),
  ).toBeVisible();

  // ── Back on the list, the suggestion has returned (unlink is durable) ──
  await page.locator(".header-back").click();
  const card2 = page.locator(".subagent-card", { hasText: "twin-suggest" });
  await expect(
    card2.locator('.subagent-link-chip[data-tone="suggest"]'),
  ).toBeVisible();

});
