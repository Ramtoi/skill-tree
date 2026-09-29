import { test, expect } from "./fixtures";

// Dropped-upstream skills + honest archive, driven against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). `?contextAttention=1`
// seeds two dropped skills into the in-memory mock registry: `diagnose`
// (renamed to `diagnosing-bugs`, unequipped) and `ds-tokens` (deleted,
// equipped on `example-app`, carries a below-confidence hedge candidate) —
// see `ensureContextAttentionFixtures` in `src/mocks/tauriCore.ts`. NEVER
// touches the real registry: every page load resets the in-memory mock.
//
// Covers:
//   1. Opening a dropped skill: DROPPED UPSTREAM pill + the right primary
//   2. Forget on the unequipped skill: no dialog, page locks while in flight,
//      undo toast restores it
//   3. Forget on the equipped skill: ConfirmDialog with the blast radius
//   4. The Sources card's "Dropped upstream" block + "Forget all"


test("Forget on the unequipped skill goes straight through, locks the page while in flight, and undoes cleanly", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	// `?archiveHangs=1` never resolves the mocked `archive`, so the locked
	// page can actually be observed (mirrors the visual scene's own need).
	await page.goto("/?contextAttention=1&archiveHangs=1#/skill/diagnose");
	await expect(page.getByText("DROPPED UPSTREAM", { exact: true })).toBeVisible();

	// "diagnose" is unequipped, and Forget lives in the overflow here (the
	// primary is "Open successor").
	await page.getByRole("button", { name: "More actions" }).first().click();
	await page.getByRole("menuitem", { name: "Forget" }).click();

	// No confirm dialog for an unequipped skill.
	await expect(page.getByRole("dialog")).toHaveCount(0);
	// The page is locked — scoped to the SCREEN ROOT (`data-busy`, unique to
	// the wrapper), not just any busy descendant (a busy LoadingButton also
	// carries its own `aria-busy`, which a bare `.first()` could match instead).
	await expect(page.locator('[data-busy="true"]')).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Open successor" }).first()).toBeDisabled();

});

test("undo after Forget restores the skill", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto("/?contextAttention=1#/skill/diagnose");
	await expect(page.getByText("DROPPED UPSTREAM", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "More actions" }).first().click();
	await page.getByRole("menuitem", { name: "Forget" }).click();

	// Success navigates away (the skill it was editing no longer exists) and
	// leaves an undo toast behind.
	await expect(page).toHaveURL(/#\/$/);
	const toast = page.locator(".toast").filter({ hasText: "Forgot diagnose" });
	await expect(toast).toBeVisible();

	await toast.getByRole("button", { name: "Undo" }).click();

	// Still on the Library (the target of the archive's navigate) → the undo
	// callback follows the user back to the restored skill automatically.
	await expect(page).toHaveURL(/#\/skill\/diagnose$/);
	await expect(page.getByText("DROPPED UPSTREAM", { exact: true })).toBeVisible();

});

test("Forget on the equipped skill opens the blast-radius confirm", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto("/?contextAttention=1#/skill/ds-tokens");
	await expect(page.getByText("DROPPED UPSTREAM", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Forget", exact: true }).first().click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Forget "ds-tokens"?');
	// The lead sentence states the consequence and the undo window, not just a
	// bare "Projects: example-app" line.
	await expect(dialog).toContainText(
		"ds-tokens is equipped in 1 project and 0 bundles",
	);
	await expect(dialog).toContainText("undo from the toast for 7 seconds");
	await expect(dialog).toContainText("example-app");

	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	// Still on the skill — cancelling never touched anything.
	await expect(page).toHaveURL(/#\/skill\/ds-tokens$/);

});

test("Sources card: the Dropped upstream block and Forget all", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });

	await page.goto("/?contextAttention=1#/sources");
	const block = page.locator('[data-testid="source-dropped-design-system"]');
	await expect(block).toBeVisible();
	await expect(block).toContainText("Dropped upstream · 2");
	await expect(block).toContainText("ds-tokens");
	await expect(block).toContainText("deleted");
	await expect(block).toContainText("diagnose");
	await expect(block).toContainText("renamed → diagnosing-bugs");
	await expect(
		page.locator('[data-testid="source-dropped-count-design-system"]'),
	).toContainText("2");

	await block.getByRole("button", { name: /Forget all 2/ }).click();

	// Batch forget always confirms, and lists what would be lost.
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Forget 2 skills?");
	// The lead sentence names every skill in the batch, not just a count.
	await expect(dialog).toContainText("2 skills will be forgotten: ds-tokens, diagnose");
	await expect(dialog).toContainText("example-app");
	await dialog.getByRole("button", { name: "Forget", exact: true }).click();

	await expect(page.locator(".toast").filter({ hasText: "Forgot 2 skills" })).toBeVisible();
	await expect(block).toHaveCount(0);

});
