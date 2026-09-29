import { test, expect } from "./fixtures";

// Skill-share standing journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches the real registry —
// the mock's pick_file / save_file_dialog return fake paths and the `hub skill
// export|import` branches answer in-memory. Exercises both directions of the
// `.skillpack` feature end to end:
//   1. Library → Import → dry-run preview dialog → confirm → /#/skill/<name>
//   2. Skill editor → Export button present (also for read-only skills), and
//      the unsaved state shows as a dot ON Save (no standalone UNSAVED pill).


const SAVE_DOT = ".doc-editor-bar-right .btn-signal";

test("library: Import → pack preview → confirm lands on the imported skill", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/");
	await expect(page.locator(".lib-nav-row").first()).toBeVisible();

	// The Import affordance sits beside the New-skill primary…
	const importBtn = page.getByRole("button", { name: "Import", exact: true });
	await expect(importBtn).toBeVisible();
	// …and must NOT compete with it — exactly one primary button in the header.
	await expect(page.locator(".main-header .btn-primary")).toHaveCount(1);

	await importBtn.click();

	// The dry-run preview dialog opens with the pack's identity + file manifest.
	const dialog = page.locator('[data-testid="import-skill-dialog"]');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(".import-pack-name")).toHaveText("shared-widget");
	await expect(dialog.getByText("v1.4.0")).toBeVisible();
	const files = page.locator('[data-testid="import-pack-files"] li');
	await expect(files).toHaveCount(3);
	await expect(files.filter({ hasText: "SKILL.md" })).toHaveCount(1);
	// A script in the pack is visible BEFORE the write — that's the whole point
	// of previewing a file someone else authored.
	await expect(files.filter({ hasText: "scripts/build.py" })).toHaveCount(1);
	// Sizes are shown, not just names.
	await expect(files.first()).toContainText("KB");

	// Confirm → the registry mutates and we land on the new skill's editor.
	await page.getByRole("button", { name: "Import", exact: true }).last().click();
	await expect(page).toHaveURL(/#\/skill\/shared-widget$/);
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

});

test("skill editor: Export is offered, and the unsaved state is a dot on Save", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	// Export rides in the shell's header actions, left of Save.
	const exportBtn = page.locator(".doc-editor-bar-right").getByRole("button", {
		name: "Export",
	});
	await expect(exportBtn).toBeVisible();

	// Typing marks it dirty → the dot appears ON the Save button. This is a
	// real CodeMirror edit (TESTS.md section 2); the clean-state and the
	// retired UNSAVED-pill checks are `documentEditorShell.test.tsx`'s
	// "carries the unsaved state as a dot on Save, not a separate pill".
	const cm = page.locator(".doc-editor-body .cm-content");
	await cm.click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("SHARE_MARKER\n");
	await expect(page.locator(SAVE_DOT)).toBeVisible();

	// Export writes through the save sheet → success toast naming the file.
	await exportBtn.click();
	await expect(page.locator(".toast-success")).toBeVisible();
	await expect(page.locator(".toast-success")).toContainText(
		"rt-android-expert",
	);

});
