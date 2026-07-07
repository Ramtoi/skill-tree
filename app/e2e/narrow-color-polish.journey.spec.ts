import { test, expect, type Page } from "@playwright/test";

// ux-narrow-color-polish standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

function trackConsoleErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	return () =>
		expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

// (a) Trust-confirm journey — saving a project permissions draft with a
// translatable Bash rule while Codex is installed fires the trust ConfirmDialog;
// a non-translatable rule saves directly with no dialog.
test("trust-confirm: a translatable Bash rule fires the Codex-trust confirm on save", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	// example-app has harnesses:[codex]; codex is installed in the mock caps.
	await page.goto("/#/project/example-app?tab=permissions");
	await expect(page.getByRole("tab", { name: "Permissions" })).toBeVisible();

	// Add a project-own translatable Bash rule.
	await page.getByRole("button", { name: "Add allow" }).click();
	// exact: the autocomplete listbox ("Existing patterns") must not match
	const patterns = page.getByLabel("Pattern", { exact: true });
	const last = patterns.last();
	await last.fill("Bash(pytest:*)");

	// Save (the header primary button; its accessible name includes the ⌘S kbd)
	// → the trust ConfirmDialog intercepts.
	await page.locator(".main-header").getByRole("button", { name: /Save/ }).click();
	await expect(
		page.getByText("Grant Codex trust to this project?"),
	).toBeVisible();
	assertNoErrors();
});

test("trust-confirm: a non-translatable rule saves with no dialog", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	await page.goto("/#/project/example-app?tab=permissions");
	await expect(page.getByRole("tab", { name: "Permissions" })).toBeVisible();

	await page.getByRole("button", { name: "Add allow" }).click();
	await page.getByLabel("Pattern", { exact: true }).last().fill("Read(config/**)");

	await page.locator(".main-header").getByRole("button", { name: /Save/ }).click();
	// No trust dialog; the save proceeds.
	await expect(
		page.getByText("Grant Codex trust to this project?"),
	).toHaveCount(0);
	assertNoErrors();
});

// (b) Tree-navigate journey — clicking a bundle-provided skill in the tree
// navigates to the providing bundle (kills the dead-end toast).
test("tree-navigate: clicking a bundle-provided skill opens its bundle", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	await page.goto("/#/project/example-app");
	await expect(page.getByText("SKILL TREE")).toBeVisible();

	// Switch to the Tree view.
	await page.getByRole("tab", { name: "Tree" }).click();
	// rt-android-expert is provided by the applied `android` bundle (not direct).
	await page.locator(".tree-node", { hasText: "rt-android-expert" }).click();

	await expect(page).toHaveURL(/#\/bundle\/android$/);
	assertNoErrors();
});
