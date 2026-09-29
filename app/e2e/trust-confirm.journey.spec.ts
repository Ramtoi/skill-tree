import { test, expect } from "./fixtures";

// ux-narrow-color-polish standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.


// (a) Trust-confirm journey — saving a project permissions draft with a
// translatable Bash rule while Codex is installed fires the trust ConfirmDialog;
// a non-translatable rule saves directly with no dialog.
test("trust-confirm: a translatable Bash rule fires the Codex-trust confirm on save", async ({
	page,
}) => {
	// example-app has harnesses:[codex]; codex is installed in the mock caps.
	await page.goto("/#/project/example-app?tab=permissions");
	// The area switcher is `ProjectAreaStrip` now, not a tab strip: its cards are
	// `role="button"` with the rule count in the accessible name
	// ("Permissions 2 rules"), which is the contract ProjectAreaStrip.test.tsx
	// pins. Match the label, not the count, so a fixture change cannot break it.
	// Scoped to main: the icon rail carries its own "Permissions" button.
	await expect(
		page.getByRole("main").getByRole("button", { name: /^Permissions\b/ }),
	).toBeVisible();

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
});

// Cut: TrustConfirm.test.tsx:125 "does NOT fire when the rule is not a
// translatable Bash rule" holds this behavior.
