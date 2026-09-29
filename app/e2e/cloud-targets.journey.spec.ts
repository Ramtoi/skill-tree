import { test, expect } from "./fixtures";

// Cloud-apps journey, driven against the mocked-Tauri dev server (VISUAL_MOCK=1
// → src/mocks/tauriCore.ts, which models `hub cloud …` including the export
// sidecar). NEVER touches ~/.claude and never opens a real browser: the opener
// plugin is a no-op stub in the mock build.

test("cloud apps: glance at drift on Remotes, then equip and export a target", async ({
	page,
}) => {
	await page.goto("/#/remotes");
	await expect(page.locator(".remotes-screen")).toBeVisible();

	// The Cloud apps band sits under the remote boxes and is zero-click: the
	// drift cluster answers "is claude.ai stale?" without opening anything.
	const section = page.getByTestId("cloud-apps");
	await expect(section).toBeVisible();
	await expect(section).toContainText("claude.ai");
	await expect(section).toContainText("ChatGPT (web)");
	const drift = page.getByTestId("cloud-drift-claude-ai");
	await expect(drift).toContainText("changed");
	await expect(drift).toContainText("new");

	// The ChatGPT DESKTOP app is a no-action info card — the zero-work path made
	// legible (the codex harness already writes the folder it reads).
	const desktop = page.getByTestId("chatgpt-desktop-card");
	await expect(desktop).toBeVisible();
	await expect(desktop).toContainText("~/.agents/skills");

	// Open the target.
	await section.locator('.cloud-card[data-target="claude-ai"]').click();
	await expect(page.locator(".cloud-detail")).toBeVisible();
	await expect(page.getByTestId("cloud-export")).toContainText(
		"Export & open claude.ai",
	);
	// The limits are quoted from the backend, not paraphrased into a promise.
	await expect(page.getByTestId("cloud-notes")).toContainText(
		"MCP servers are NOT uploadable here",
	);

	// A skill row carries its own drift badge, and an MCP server is refused.
	const list = page.getByTestId("cloud-skill-list");
	await expect(list).toContainText("openspec-apply");
	await expect(list.locator('[data-status="changed"]')).toHaveCount(1);
	await expect(page.locator(".cloud-detail")).toContainText("Not exportable");

	// Equip another skill — registry-only, no confirmation dialog anywhere.
	await page.getByRole("button", { name: /Equip…/ }).click();
	await page.getByRole("button", { name: "Skills", exact: true }).click();
	await page
		.getByLabel(/Equip claude\.ai rt-android-expert/)
		.click();
	await expect(list).toContainText("rt-android-expert");
	await expect(page.locator('[role="dialog"]')).toHaveCount(0);

	// Export: every row settles to "up to date" (the ZIPs now match the library).
	await page.getByTestId("cloud-export").click();
	await expect(page.locator(".toast")).toContainText("Exported");
	await expect(page.locator(".toast")).toContainText("exports/claude-ai");
	await expect(list.locator('[data-status="changed"]')).toHaveCount(0);
	await expect(list.locator('[data-status="new"]')).toHaveCount(0);

	// Back on the list, the cluster collapses to the settled green badge.
	await page.getByRole("button", { name: /Remotes/ }).first().click();
	await expect(page.getByTestId("cloud-drift-claude-ai")).toContainText(
		"up to date",
	);
});

test("cloud apps: the palette navigates straight to a target", async ({ page }) => {
	await page.goto("/#/");
	await expect(page.locator(".app-main")).toBeVisible();
	await page.keyboard.press("Meta+k");
	const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
	await expect(palette.getByRole("textbox")).toBeFocused();
	await page.keyboard.type("chatgpt");
	await expect(palette.getByRole("option", { name: /Open ChatGPT/ })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.locator(".cloud-detail")).toBeVisible();
	// Nothing equipped → the primary is inert with a reason, not a dead click.
	await expect(page.getByTestId("cloud-export")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
});
