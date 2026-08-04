import { test, expect } from "@playwright/test";

// skill-invocation-axis standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
// The mock registry seeds deep-research=user-only, openspec-apply=model-only,
// code-review=conflicted, and a moon-base override — plus stateful handlers for
// `set-meta --invocation` and `project invocation`.

// (a) Edit a library skill's triggering in the editor → badge appears in the list.
test("editor triggering: set a skill user-only → its Library row shows the badge", async ({
	page,
}) => {
	await page.goto("/#/skill/brainstorm");
	await expect(page.locator(".triggering-block")).toBeVisible();

	// brainstorm starts as `auto` — no badge on its row yet is proven by (a→list).
	await page.getByRole("radio", { name: /User-only/ }).check();

	// Client-side nav back to the Library (no reload → mock state persists).
	await page.locator(".header-back").click();
	const row = page.locator(".resource-row", { hasText: "brainstorm" }).first();
	await expect(row.locator(".invocation-badge")).toBeVisible();
});

// (b) Workspace: set a per-project override → indicator appears → undo restores.
test("workspace override: set → indicator → undo clears it", async ({ page }) => {
	await page.goto("/#/project/example-app");
	await expect(page.locator(".workspace-main")).toBeVisible();

	const card = page
		.locator(".skill-card", { hasText: "rt-android-expert" })
		.first();
	await card.locator(".invocation-override-trigger").click();
	await page.getByRole("menuitemradio", { name: /User-only/ }).click();

	// The trigger now carries the active-override marker.
	await expect(
		card.locator(".invocation-override-trigger[data-override]"),
	).toBeVisible();

	// The undo toast reverses it back to "no override".
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(
		card.locator(".invocation-override-trigger[data-override]"),
	).toHaveCount(0);
});

// (c) Global-scope skill: the override control explains instead of failing.
test("workspace override: a global-scope skill shows the precedence explanation", async ({
	page,
}) => {
	await page.goto("/#/project/example-app");
	await expect(page.locator(".workspace-main")).toBeVisible();

	const card = page.locator(".skill-card", { hasText: "brainstorm" }).first();
	await card.locator(".invocation-override-trigger").click();

	await expect(
		page.getByText(/User-level skills take precedence/),
	).toBeVisible();
	// Gated → no settable options are offered.
	await expect(page.getByRole("menuitemradio")).toHaveCount(0);
});

// (d) Library: filter by invocation facet.
test("library filter: the invocation facet narrows to a triggering mode", async ({
	page,
}) => {
	await page.goto("/#/");
	await expect(page.getByText("SKILL TREE")).toBeVisible();

	await page.getByRole("button", { name: /^Filter/ }).click();
	await page.getByRole("button", { name: "User-only" }).click();

	// deep-research is user-only in the mock; auto skills (brainstorm) drop out.
	await expect(
		page.locator(".resource-row", { hasText: "deep-research" }),
	).toBeVisible();
	await expect(
		page.locator(".resource-row", { hasText: "brainstorm" }),
	).toHaveCount(0);
});
