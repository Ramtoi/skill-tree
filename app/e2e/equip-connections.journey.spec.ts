import { test, expect } from "@playwright/test";

// ux-equip-connections standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

// (a) Equip a skill onto a project directly from a Library row.
test("equip-from-library: row picker toggles a project on", async ({ page }) => {
	await page.goto("/#/");
	await expect(page.getByText("SKILL TREE")).toBeVisible();

	// deep-research is off on example-app in the mock registry.
	const row = page.locator(".resource-row", { hasText: "deep-research" }).first();
	await row.hover();
	await row.getByTitle("Equip on…").click();

	// The popover lists projects with per-project state.
	const box = page.getByRole("checkbox", {
		name: "Equip deep-research example-app",
	});
	await expect(box).not.toBeChecked();
	await box.click();
	await expect(box).toBeChecked();
});

// (b) Add a skill to a bundle from the editor's ConnectionsPanel.
test("editor add-to-bundle: bundles section reflects the new membership", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".connections-panel")).toBeVisible();

	// Disclose the Bundles section, then equip the skill on `openspec`.
	await page.getByRole("button", { name: /Bundles/ }).click();
	const box = page.getByRole("checkbox", {
		name: "Equip rt-android-expert openspec",
	});
	await expect(box).not.toBeChecked();
	await box.click();
	await expect(box).toBeChecked();
});

// (c) Equip a bundle onto a remote from the remote detail.
test("remote equip: toggling a bundle on updates the equipped bundles", async ({
	page,
}) => {
	await page.goto("/#/remote/hermes-main");
	await expect(page.locator(".remote-detail")).toBeVisible();

	await page.getByRole("button", { name: /Equip/ }).first().click();
	// android is off for hermes-main (mock has only openspec).
	const box = page.getByRole("checkbox", { name: "Equip hermes-main android" });
	await expect(box).not.toBeChecked();
	await box.click();
	await expect(box).toBeChecked();
	// The equipped bundle strip picks up the new bundle chip.
	await expect(
		page.locator(".remote-bundle-strip").getByText("android"),
	).toBeVisible();
});

// (d) Resolve a source conflict as import-renamed and apply.
test("source conflict: choose import-renamed → apply shows the resolved name", async ({
	page,
}) => {
	await page.goto("/#/sources");
	await expect(page.locator(".app-main")).toBeVisible();

	await page.getByRole("button", { name: "Add source" }).click();
	await page
		.getByPlaceholder("git@github.com:org/skills.git")
		.fill("git@github.com:org/pack.git");
	await page.getByRole("button", { name: "Preview" }).click();

	// The conflicting candidate surfaces its per-candidate resolver.
	await expect(page.getByTestId("conflict-code-review")).toBeVisible();
	await page.getByRole("button", { name: "Import renamed" }).click();
	await page.getByRole("button", { name: "Apply" }).click();

	await expect(page.getByTestId("resolved-code-review")).toContainText(
		"code-review-2",
	);
});
