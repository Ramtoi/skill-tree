import { test, expect, type Page } from "@playwright/test";

// Regression guard for the Snippets editor blank-body bug: the CodeMirror edit
// pane borrowed its height from the details-panel sibling, so it collapsed to 0
// whenever that panel was collapsed or dropped into narrow-width overlay mode.
// Driven against the mocked-Tauri dev server (VISUAL_MOCK=1). NEVER touches
// ~/.claude. The gate is the REAL rendered height of .cm-content — jsdom/vitest
// cannot catch a layout collapse, only a real browser can.

// A filled editor is hundreds of px tall (viewport 900); a collapsed one is ~0.
const MIN_EDITOR_HEIGHT = 200;

async function openFirstSnippet(page: Page) {
	await page.goto("/#/snippets");
	await expect(page.locator(".snip-row").first()).toBeVisible();
	await page.locator(".snip-row").first().click();
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
}

async function editorHeight(page: Page): Promise<number> {
	const box = await page.locator(".doc-editor-body .cm-content").boundingBox();
	return box?.height ?? 0;
}

test("snippet editor keeps height when Details panel is collapsed (wide)", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openFirstSnippet(page);

	// Baseline: Details expanded → editor fills.
	expect(await editorHeight(page)).toBeGreaterThan(MIN_EDITOR_HEIGHT);

	// Collapse the Details panel — the editor must NOT go blank.
	await page.getByRole("button", { name: "Collapse Details" }).click();
	await expect(
		page.getByRole("button", { name: "Open Details" }),
	).toBeVisible();
	expect(await editorHeight(page)).toBeGreaterThan(MIN_EDITOR_HEIGHT);
});

test("snippet editor + details overlay keep height at narrow width", async ({
	page,
}) => {
	// Below --bp-nav the details panel docks to an absolute overlay that anchors
	// to the split container, contributing no row height. Both the editor AND the
	// overlay panel must stand on the shell's own definite height (the overlay
	// went stunted-blank when the shell collapsed).
	await page.setViewportSize({ width: 520, height: 900 });
	await openFirstSnippet(page);
	expect(await editorHeight(page)).toBeGreaterThan(MIN_EDITOR_HEIGHT);

	// Open the Details overlay (the stunted floating box in the bug report).
	await page.getByRole("button", { name: "Open Details" }).click();
	const overlay = page.locator(".resizable-split-overlay").first();
	await expect(overlay).toBeVisible();
	const box = await overlay.boundingBox();
	expect(box?.height ?? 0).toBeGreaterThan(MIN_EDITOR_HEIGHT);
	// Editor stays rendered behind the overlay.
	expect(await editorHeight(page)).toBeGreaterThan(MIN_EDITOR_HEIGHT);
});
