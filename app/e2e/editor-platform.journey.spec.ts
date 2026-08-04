import { test, expect, type Page } from "@playwright/test";

// ux-editor-platform standing journey, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). Same boot path as the visual
// harness. NEVER touches ~/.claude. Exercises the CodeArea v2 platform end to
// end: full-fidelity preview (real ordered lists), the real aligned diff
// (single changed line + frontmatter-aware metadata edit), ⌘S save through the
// shell, and the wide-width side-by-side split.

function trackConsoleErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	return () =>
		expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

async function clickTab(page: Page, label: string) {
	await page.locator(`button[role="tab"]:has-text("${label}")`).first().click();
}

test("skill editor: preview ol → diff one line + frontmatter → ⌘S → split", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	// Wide enough that the editor pane clears --bp-nav (680) so split is offered.
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	// ── Preview v2: the ordered list keeps real <ol> numbering (not a <ul>). ──
	await clickTab(page, "Preview");
	const ol = page.locator(".md-prose ol").first();
	await expect(ol).toBeVisible();
	await expect(ol.locator("li")).toHaveCount(3);
	await expect(page.locator(".md-prose ol li").first()).toContainText("Survey");

	// ── Edit the body: insert exactly one line at the top. ──
	await clickTab(page, "Edit");
	const cm = page.locator(".doc-editor-body .cm-content");
	await cm.click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("NEWLINE_MARKER\n");

	// ── Diff v2: exactly one added line for the single insertion. ──
	await clickTab(page, "Diff");
	const added = page.locator('.diff-line[data-kind="+"]');
	await expect(added.filter({ hasText: "NEWLINE_MARKER" })).toHaveCount(1);
	// The naive index-aligned diff would cascade removals; the real diff must not.
	await expect(page.locator('.diff-line[data-kind="-"]')).toHaveCount(0);

	// ── Frontmatter-aware diff: a metadata edit (description) surfaces too. ──
	const descField = page.locator(".editor-side textarea").first();
	await descField.click();
	await page.keyboard.press("End");
	await page.keyboard.type(" METADATA_EDIT");
	await clickTab(page, "Diff");
	await expect(
		page.locator('.diff-line[data-kind="+"]').filter({ hasText: "METADATA_EDIT" }),
	).toHaveCount(1);

	// ── ⌘S saves through the shell → UNSAVED clears. ──
	await expect(page.getByText("UNSAVED")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+s");
	await expect(page.getByText("UNSAVED")).toHaveCount(0);

	// ── Split at wide width: Edit + Preview render side by side. ──
	const splitTab = page.locator('button[role="tab"]:has-text("Split")');
	await expect(splitTab).toBeVisible();
	await splitTab.click();
	await expect(page.locator(".code-area--edit")).toBeVisible();
	await expect(page.locator(".code-area--preview")).toBeVisible();

	assertNoErrors();
});
