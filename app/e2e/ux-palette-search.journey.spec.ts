import { test, expect, type Page } from "./fixtures";

async function searchLibraryFromPalette(page: Page, query: string) {
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
	const input = palette.locator("input");
	await expect(input).toBeFocused();
	// Opening resets the palette query in an effect. After a dirty-editor
	// cancel, the dialog can mount before that reset has committed; wait for the
	// root-stage value before filling so the opening reset cannot erase this
	// attempt's query.
	await expect(input).toHaveValue("");
	await input.fill(query);
	await expect(
		palette.getByRole("option", { name: `Search Library for \u201c${query}\u201d` }),
	).toBeVisible();
	await page.keyboard.press("Enter");
}

test("an unmatched palette query opens the all-kind Library search, focused, and returns from a result", async ({ page }) => {
	// Start in a narrowed Library so the handoff has to discard the old list
	// mode instead of carrying it into the exact-query search.
	await page.goto("/#/?kind=snippet");
	await expect(page.getByTestId("floating-search-input")).toBeVisible();

	await searchLibraryFromPalette(page, "derivedStateOf");
	await expect(page).toHaveURL(/#\/\?q=derivedStateOf$/);
	const input = page.getByTestId("floating-search-input");
	await expect(input).toHaveValue("derivedStateOf");
	await expect(input).toBeFocused();
	await expect(page.getByTestId("floating-search-kinds").locator(".chip")).toHaveCount(5);

	// The normal Library result path remains in charge of return state.
	await page.keyboard.press("Enter");
	await expect(page.locator(".header-back")).toBeVisible();
	await page.locator(".header-back").click();
	await expect(input).toHaveValue("derivedStateOf");
	await expect(input).toBeFocused();
});

test("the palette Library fallback obeys the dirty-editor guard on cancel and discard", async ({ page }) => {
	await page.goto("/#/skill/brainstorm");
	const editor = page.locator(".doc-editor-body .cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("PALETTE_UNSAVED\n");

	await searchLibraryFromPalette(page, "no match & more");
	const confirm = page.getByRole("dialog", { name: "Discard unsaved changes?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(page).toHaveURL(/#\/skill\/brainstorm$/);
	await expect(editor).toContainText("PALETTE_UNSAVED");

	await searchLibraryFromPalette(page, "no match & more");
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Discard and leave" }).click();
	await expect(page).toHaveURL(/#\/\?q=no\+match\+%26\+more$/);
	await expect(page.getByTestId("floating-search-input")).toBeFocused();
});
