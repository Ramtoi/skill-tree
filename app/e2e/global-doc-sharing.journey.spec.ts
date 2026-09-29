import { test, expect } from "./fixtures";

// Global-doc-sharing standing journey, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude —
// the mock's global_doc_read/write and `hub harness doc status|link|unlink`
// are all in-memory (`docSharingState` in the mock). Exercises: opening a
// SOURCE doc and seeing who follows it, opening a FOLLOWER doc and seeing the
// "this is a link" plaque, and detaching it back to its own real file.
//
// Default mock state (tauriCore.ts): claude-code is a plain file that codex
// FOLLOWS; pi is missing; opencode is a plain file nobody follows.


test("claude-code's SHARED WITH shows Codex on → open Codex's doc → follower plaque → Detach → toast", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	// 1. Open claude-code's global doc — it is the SOURCE codex follows.
	await page.goto("/#/harness/claude-code/doc");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	// The section waits on the status CLI round-trip. On a cold parallel start
	// the first navigation also pays Vite's module transforms, so give it
	// longer than the 5s expect default.
	await expect(page.getByText("Shared with")).toBeVisible({ timeout: 20_000 });

	const codexToggle = page.getByRole("checkbox", {
		name: "Share CLAUDE.md with Codex",
	});
	await expect(codexToggle).toBeVisible();
	await expect(codexToggle).toBeChecked();

	// 2. Open Codex's own doc — it is the FOLLOWER.
	await page.goto("/#/harness/codex/doc");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	// Exact + case-sensitive: the plaque eyebrow reads "Follows Claude Code";
	// the (also-present) STATE kv row reads lowercase "follows Claude Code".
	await expect(
		page.getByText("Follows Claude Code", { exact: true }),
	).toBeVisible();
	// The follower plaque replaces the SHARED WITH section entirely.
	await expect(page.getByText("Shared with")).toHaveCount(0);

	// 3. Detach — codex becomes its own real file again.
	await page.getByRole("button", { name: "Detach" }).click();
	await expect(
		page.locator(".toast-title", { hasText: /Detached/ }),
	).toBeVisible();

	// Its own SHARED WITH section appears once it is no longer a follower.
	await expect(page.getByText("Shared with")).toBeVisible();

});

test("linking a harness that has its OWN file: conflict → Replace with link → the card says so", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	// Folded from harness-doc.journey.spec.ts: reach the doc through the
	// Harnesses screen's own "Global instructions" link row, not a direct
	// `goto`, so the card's own navigation stays a real journey reason.
	await page.goto("/#/harnesses");
	await expect(page.locator(".app-main")).toBeVisible();
	const claudeCard = page.locator(".harness-card", {
		has: page.locator(".harness-card-name", { hasText: "Claude Code" }),
	});
	await claudeCard
		.locator(".harness-card-instructions button:has-text('Global instructions')")
		.click();
	await expect(page).toHaveURL(/#\/harness\/claude-code\/doc/);

	// opencode starts as a plain file nobody follows, WITH bytes of its own —
	// so the link comes back as the exit-2 conflict, not a straight success.
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await expect(page.getByText("Shared with")).toBeVisible({ timeout: 20_000 });

	const opencodeToggle = page.getByRole("checkbox", {
		name: "Share CLAUDE.md with opencode",
	});
	await expect(opencodeToggle).not.toBeChecked();
	await expect(page.getByText(/own file · \d+ chars/)).toBeVisible();
	await opencodeToggle.click();

	// The decision dialog — both verbs must be real, reachable controls.
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("opencode has its own AGENTS.md")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Append its text here, then link" }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Replace with link" }).click();

	// The toast names the effect, and the toggle flips off the RE-FETCHED
	// status — not off local optimism.
	await expect(
		page.locator(".toast-title", { hasText: "opencode now reads CLAUDE.md" }),
	).toBeVisible();
	await expect(opencodeToggle).toBeChecked();
	// Both rows now read the same hint — codex was already following.
	await expect(page.getByText("follows Claude Code")).toHaveCount(2);

	// Back to the cards IN-APP (a `goto` would reload the mock's memory) —
	// opencode's own card now reports that it follows.
	await page.locator(".header-back").click();
	await expect(page.locator(".harness-card").first()).toBeVisible();
	const opencodeCard = page.locator(".harness-card", {
		has: page.locator(".harness-card-name", { hasText: "opencode" }),
	});
	await expect(
		opencodeCard.locator(".harness-card-instructions .harness-card-link-hint"),
	).toHaveText("AGENTS.md · follows Claude Code");

	// And Claude Code's card counts BOTH followers now (codex + opencode).
	await expect(
		claudeCard.locator(".harness-card-instructions .harness-card-link-hint"),
	).toHaveText("CLAUDE.md · shared with 2 harnesses");

});
