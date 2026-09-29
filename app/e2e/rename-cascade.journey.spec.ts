import { test, expect } from "./fixtures";

// The skill rename cascade, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts).


test("renames a skill and rewrites references in the referring skill", async ({ page }) => {

	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	await page
		.getByRole("button", { name: "Rename skill name: rt-android-expert" })
		.click();
	const field = page.getByRole("textbox", { name: "Skill name" });
	await field.fill("rt-android-planner");
	await field.press("Enter");
	await page.keyboard.press("ControlOrMeta+s");

	await expect(page.getByTestId("rename-refs-dialog")).toBeVisible();
	await expect(page.getByTestId("rename-refs-group-skills")).toBeVisible();
	await expect(page.getByTestId("rename-refs-agent-docs")).not.toBeChecked();
	await expect(page.getByTestId("rename-refs-skipped")).toBeVisible();

	await page.getByTestId("rename-refs-rewrite").click();
	await expect(page.getByTestId("rename-refs-done")).toBeVisible();
	await page.getByTestId("rename-refs-done").click();
	await expect(page).toHaveURL(/#\/skill\/rt-android-planner$/);
	await expect(
		page.locator(".main-header .title-mono", { hasText: "rt-android-planner" }),
	).toBeVisible();

	await page.goto("/#/skill/brainstorm");
	await expect(page.locator(".cm-content")).toContainText("/rt-android-planner");
	await expect(page.locator(".cm-content")).not.toContainText("/rt-android-expert");

});
