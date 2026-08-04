import { test, expect, type Page } from "@playwright/test";

// Global agent-doc editor standing journey, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude — the
// mock's global_doc_read/write are in-memory. Exercises: navigating from the
// Harnesses screen via the per-card "Instructions" affordance into the editor,
// editing the CodeArea, the UNSAVED pill, and ⌘S save through the shell.

function trackConsoleErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	return () =>
		expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

test("harnesses → Instructions affordance → edit CLAUDE.md → ⌘S", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto("/#/harnesses");
	await expect(page.locator(".app-main")).toBeVisible();

	// Click the claude-code card's Instructions affordance.
	const claudeCard = page.locator(".harness-card", {
		hasText: "Claude Code",
	});
	await claudeCard
		.locator(".harness-card-instructions button:has-text('Instructions')")
		.click();

	// The editor shell mounts on the global-doc route.
	await expect(page).toHaveURL(/#\/harness\/claude-code\/doc/);
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	// Type into the editor → UNSAVED appears.
	const cm = page.locator(".doc-editor-body .cm-content");
	await cm.click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("PREPENDED_LINE\n");
	await expect(page.getByText("UNSAVED")).toBeVisible();

	// ⌘S saves through the shell → the pill clears.
	await page.keyboard.press("ControlOrMeta+s");
	await expect(page.getByText("UNSAVED")).toHaveCount(0);

	assertNoErrors();
});
