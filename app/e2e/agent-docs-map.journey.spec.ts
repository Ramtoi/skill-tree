import { test, expect, type Page } from "./fixtures";

// The Agent Docs instruction map, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). Covers the journey the change
// exists for: a file the agent loads but the map could not render, a filter
// that says where a match actually is instead of "no results", and a browse
// toggle that no longer throws the tree away.


async function openAgentDocs(page: Page) {
	await page.goto("/#/project/moon-base?tab=agent-docs");
	await expect(page.locator(".agent-docs-map")).toBeVisible();
}

const filter = (page: Page) => page.locator(".agent-docs-filter input");
const row = (page: Page, name: string) =>
	page.locator(".ad-file", { has: page.locator(`.ad-file-name:text-is("${name}")`) });

test("browse toggle keeps expansion and selection", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openAgentDocs(page);

	await page.locator('[data-testid="agent-docs-show-all-markdown"]').check();
	await expect(page.locator(".agent-docs-eyebrow")).toContainText("Markdown files");

	// A folder that exists only in the browse view starts collapsed — this view
	// can hold thousands of rows, not the handful the instruction map does.
	await expect(row(page, "README.md").nth(1)).toHaveCount(0);
	const android = page.locator(".ad-folder-name", { hasText: "notesapp/pre" });
	await expect(android).toHaveCount(1);
	await android.click();
	await page.locator(".ad-folder-name", { hasText: "board/" }).first().click();
	const boardReadme = page
		.locator(".ad-file")
		.filter({ has: page.locator('.ad-file-name:text-is("README.md")') })
		.last();
	await boardReadme.click();
	await expect(page.locator(".ad-doc-name")).toHaveText(
		"app/src/main/java/com/notesapp/presentation/board/README.md",
	);

	// Flip to the instruction map and back. Clearing the tree on every flip is
	// what made the toggle feel like it threw the user's work away.
	await page.locator('[data-testid="agent-docs-show-all-markdown"]').uncheck();
	await expect(page.locator(".agent-docs-eyebrow")).toContainText("Instruction map");
	// The buffer survives, but with no row for it saving is refused rather than
	// writing a file the map cannot show.
	await expect(page.locator(".agent-docs-editor .cm-editor")).toBeVisible();
	await expect(page.locator('[data-testid="agent-docs-save"]')).toBeDisabled();

	await page.locator('[data-testid="agent-docs-show-all-markdown"]').check();
	await expect(page.locator(".agent-docs-eyebrow")).toContainText("Markdown files");
	await expect(
		page.locator(".ad-folder-name", { hasText: "board/" }),
	).toHaveCount(1);
	await expect(page.locator(".ad-doc-name")).toHaveText(
		"app/src/main/java/com/notesapp/presentation/board/README.md",
	);

});

test("the `/` hotkey focuses the map filter", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openAgentDocs(page);

	await page.locator(".app-main").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("/");
	await expect(filter(page)).toBeFocused();

});
