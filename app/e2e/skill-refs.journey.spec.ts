import { test, expect, type Page } from "./fixtures";

// Skill cross-references, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude. The
// referrer is rt-android-expert, whose SKILL.md body (src/mocks/tauriCore.ts's
// `skillBody`) mentions `code-review` twice, /brainstorm once, and
// `needs-global` once; android-compose-ui's mocked search-corpus body mentions
// /rt-android-expert back, giving the MENTIONED BY side a real row.
//
// Covers:
//   1. Edit mode: hovering a token shows the target's description
//   2. Edit mode: clicking the hover card's name opens the target
//   3. Preview mode: a ref link opens the target
//   4. Side panel: a MENTIONED BY row opens the referrer with a back arrow
//   5. Edit mode: a plain click does not navigate
// ⌘/Ctrl-click navigation and back are covered by ref-navigation.journey.spec.ts
// ("skill editor: ...").


async function clickTab(page: Page, label: string) {
	await page.locator(`button[role="tab"]:has-text("${label}")`).first().click();
}

test("edit mode: hovering a token shows the target's description", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	await page.locator('.cm-skill-ref[data-ref="code-review"]').first().hover();

	const card = page.locator(".cm-tooltip-hover .skill-ref-card");
	await expect(card).toBeVisible();
	await expect(card.locator(".skill-ref-card-name")).toHaveText("code-review");
	await expect(card.locator(".skill-ref-card-desc")).toContainText(
		"Review the current diff for correctness bugs and cleanups.",
	);
	await expect(card.locator(".skill-ref-card-hint")).toHaveText("⌘-click to open");

});

test("edit mode: clicking the hover card's name opens the target", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	await page.locator('.cm-skill-ref[data-ref="code-review"]').first().hover();
	const cardName = page.locator(".cm-tooltip-hover .skill-ref-card-name");
	await expect(cardName).toBeVisible();
	await cardName.click();

	await expect(page).toHaveURL(/#\/skill\/code-review$/);
	await expect(page.locator(".header-back")).toHaveAccessibleName("Back to rt-android-expert");

});

test("preview mode: a ref link opens the target", async ({ page }) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	await clickTab(page, "Preview");
	const ref = page.locator(".md-skill-ref").first();
	await expect(ref).toBeVisible();
	await ref.click();

	await expect(page).toHaveURL(/#\/skill\/code-review$/);

});

test("side panel: a MENTIONED BY row opens the referrer with a back arrow to this skill", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".editor-side")).toBeVisible();

	const head = page.locator('[data-testid="side-section-refs"]');
	await expect(head).toBeVisible();
	if ((await head.getAttribute("aria-expanded")) === "false") {
		await head.click();
	}
	await expect(head).toHaveAttribute("aria-expanded", "true");

	const row = page.locator('[data-testid="skill-ref-row-in-android-compose-ui"]');
	await expect(row).toBeVisible();
	await row.click();

	await expect(page).toHaveURL(/#\/skill\/android-compose-ui$/);
	await expect(page.locator(".header-back")).toHaveAccessibleName("Back to rt-android-expert");

});
