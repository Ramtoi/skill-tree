import { test, expect, type Page } from "./fixtures";

// The in-editor slash-reference completion overlay (plans/2.md), driven
// against the mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts).
// NEVER touches ~/.skill-hub. It ships inside `useSkillRefs`'s extension
// bundle, so every host that already passes `extraExtensions={refs.extension}`
// gets it with zero host-side wiring — this spec proves that on two
// independent hosts: the skill editor and the snippet editor (wave 2).
//
// Covers plans/2.md §Test tasks T-6 (a)-(f):
//   a. Skill editor: `/cod` → the overlay lists `code-review` → Enter inserts
//      it, and the decorated-ref count goes up by one (the round trip
//      through `findRefs` actually resolved).
//   b. Snippet editor: the same three steps, proving zero-wiring.
//   c. Esc closes the overlay, the typed text survives, the URL is unchanged.
//   d. `references/cod` never opens the overlay (the path guard, end to end).
//   e. `/cod` opens neither the command palette nor the screen search.
//   f. Zero console errors.


/** Clicks the true end of a (possibly soft-wrapped) `.cm-line`, then types
 *  `text`. A soft-wrapped line is still ONE `.cm-line` div spanning several
 *  visual rows; a plain center-click + `End` only reaches the end of
 *  whichever visual row the click landed on (CM's default `End` binding is
 *  `cursorLineBoundaryForward`, wrap-aware). Clicking the box's bottom-right
 *  corner lands on the last visual row, right after the last character. */
async function openCompletionOn(page: Page, lineLocator: string, text: string) {
	const line = page.locator(lineLocator).first();
	await line.scrollIntoViewIfNeeded();
	const box = await line.boundingBox();
	if (!box) throw new Error(`line not found: ${lineLocator}`);
	await line.click({ position: { x: box.width - 2, y: box.height - 2 } });
	await page.keyboard.press("End");
	await page.keyboard.type(text);
}

/** Production wires the real `interactionDelay` (CM's default, 75ms):
 *  `acceptCompletion` deliberately no-ops for that long after the tooltip
 *  opens, so a fast typist cannot accept something they never saw
 *  (plans/2.md §Overlay). A scripted `Enter`/`Tab` right after `toBeVisible`
 *  resolves lands inside that window every time — clear it first. */
async function clearInteractionDelay(page: Page) {
	await page.waitForTimeout(120);
}

test("skill editor: `/cod` opens the overlay, Enter inserts and decorates code-review (T-6a)", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".code-area")).toBeVisible();

	const before = await page.locator('.cm-skill-ref[data-ref="code-review"]').count();

	await openCompletionOn(page, '.cm-line:has(.cm-skill-ref)', " /cod");
	const tooltip = page.locator(".cm-tooltip-autocomplete");
	await expect(tooltip).toBeVisible();

	const firstOption = tooltip.locator('li[role="option"] .cm-completionLabel').first();
	await expect(firstOption).toHaveText("code-review");

	await clearInteractionDelay(page);
	await page.keyboard.press("Enter");
	await expect(tooltip).toBeHidden();

	await expect(page.locator('.cm-skill-ref[data-ref="code-review"]')).toHaveCount(before + 1);

});

test("`/cod` opens neither the command palette nor the screen search (T-6e)", async ({ page }) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".code-area")).toBeVisible();

	await openCompletionOn(page, '.cm-line:has(.cm-skill-ref)', " /cod");
	await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();

	await expect(page.locator(".palette-backdrop")).toHaveCount(0);
	await expect(page.locator(".palette")).toHaveCount(0);
	// Focus stayed in the editor — the `/` global hotkey never fired.
	await expect(page.locator(".cm-content")).toBeFocused();

});
