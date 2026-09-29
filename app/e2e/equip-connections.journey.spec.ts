import { test, expect } from "./fixtures";

// ux-equip-connections standing journeys, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

// (b) Add a skill to a bundle from the editor's ConnectionsPanel.
test("editor add-to-bundle: bundles section reflects the new membership", async ({
	page,
}) => {
	await page.goto("/#/skill/rt-android-expert");
	await expect(page.locator(".connections-panel")).toBeVisible();

	// Bundles are a sub-group of the open USED BY well (no head to disclose);
	// equip the skill on `openspec`.
	await expect(page.locator(".equip-stack .equip-group-name", { hasText: "Bundles" })).toBeVisible();
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

	// B5: the merged "Skills on this remote" list surfaces a drifted unit
	// with its resolve actions visible WITHOUT hover.
	const drifted = page.locator(".resource-row", { hasText: "code-review" }).first();
	await expect(drifted).toHaveAttribute("data-drift", "needs-resolve");
	await expect(drifted.getByRole("button", { name: "Pull" })).toBeVisible();
});
