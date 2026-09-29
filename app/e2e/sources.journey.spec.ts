import { test, expect, type Page } from "./fixtures";

// Sources standing journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches the real registry:
// `source edit|enable|disable` and `bundle new` answer against the in-memory
// mock registry, which each fresh page load resets.
//
// Search + status-chip filtering, rename, disable/undo and the deep-GitHub-
// link and bad-scan-path add-source flows are vitest-only now
// (SourcesScreen.test.tsx, SourceScopedAdd.test.tsx) — no real layout,
// history or focus reason kept them here. This file keeps the flows that
// cross screens or carry a stateful-mock round trip: bundle creation,
// linking/detaching, and the deep-link add-source wizard through Preview and
// Apply against the stateful mock.


const CARD = ".source-card";

function card(page: Page, name: string) {
	return page.locator(CARD).filter({ hasText: name });
}

async function openMenu(page: Page, sourceName: string) {
	const trigger = page.locator(`button[title="Actions for ${sourceName}"]`);
	await trigger.click();
	await page.locator(".overflow-menu-panel").waitFor({ state: "visible", timeout: 10000 });
}

test("create a bundle from a source's skills", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/sources");
	await expect(card(page, "Org Skills")).toBeVisible();

	await openMenu(page, "Org Skills");
	await page.getByRole("menuitem", { name: "Create bundle from source…" }).click();

	// Pre-filled from the source, and the captured skills are shown up front.
	await expect(page.getByLabel("Bundle name")).toHaveValue("org-skills");
	await expect(page.getByText("Skills captured (1)")).toBeVisible();

	await page.getByRole("button", { name: "Create bundle" }).click();

	await expect(page.locator(".toast")).toContainText('Bundle "org-skills" created');
	await expect(page).toHaveURL(/#\/bundle\/org-skills$/);

});

test("linked bundle: create following a source, then detach to edit it", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/sources");
	await expect(card(page, "Org Skills")).toBeVisible();

	await openMenu(page, "Org Skills");
	await page.getByRole("menuitem", { name: "Create bundle from source…" }).click();

	// Following the source is the default — and the copy says what that means.
	const follow = page.getByLabel("Keep in sync with source");
	await expect(follow).toBeChecked();
	await expect(page.getByText(/This bundle follows Org Skills/)).toBeVisible();

	await page.getByLabel("Bundle name").fill("org-linked");
	await page.getByRole("button", { name: "Create bundle" }).click();
	await expect(page).toHaveURL(/#\/bundle\/org-linked$/);

	// The header states the link on its own tag — no lock explanation
	// duplicated three times — and the one SKILLS row (the library list,
	// filtered to the bundle's members) is locked with the same reason.
	const lock = page.locator('[data-testid="bundle-linked-lock"]');
	await expect(lock).toContainText("Follows");
	await expect(lock).toContainText("Org Skills");
	const firstRow = page.locator(".lib-list .skill-row").first();
	await expect(firstRow.locator(".card-lock")).toHaveAttribute(
		"title",
		"Managed by Org Skills",
	);
	// The lock glyph stays visible on hover — a locked row never swaps in the
	// hover-revealed remove action.
	await firstRow.hover();
	await expect(firstRow.locator(".card-lock")).toBeVisible();
	// A locked (linked-bundle) row carries no "remove from bundle" action —
	// membership follows the source, never a per-row decision (§B3).
	await expect(
		firstRow.getByRole("button", { name: /^Remove .* from org-linked$/ }),
	).toHaveCount(0);

	// Detaching is deliberate but not destructive — the verb lives in the
	// header's overflow menu, not a standalone button.
	await page.locator(".main-header").getByTestId("overflow-trigger").click();
	await page.getByRole("menuitem", { name: "Detach from source…" }).click();
	await expect(page.getByText("Stop following Org Skills?")).toBeVisible();
	await page.getByRole("button", { name: "Detach bundle" }).click();

	await expect(lock).toHaveCount(0);
	await expect(firstRow.locator(".card-lock")).toHaveCount(0);
	// The remove action lives in the row's hover-revealed actions slot.
	await firstRow.hover();
	await expect(
		firstRow.getByRole("button", { name: /^Remove .* from org-linked$/ }),
	).toBeVisible();

});

test("a source's linked bundle is marked in its In bundles chips", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/sources");

	// `org-pack` follows org-skills in the mock registry; `android` does not.
	// REVIEW-B #4: "In bundles" rides `BundleChip` (emoji-on-color square);
	// the "follows" marker is now a rendered `link` glyph (`trailing` slot),
	// visible at rest — not just a tooltip on a wrapping `<span>`.
	const bundles = page.locator('[data-testid="source-bundles-org-skills"]');
	const linkedChip = bundles
		.locator(".bundle-chip", { hasText: "org-pack" })
		.first();
	await expect(linkedChip).toBeVisible();
	await expect(
		linkedChip.getByRole("img", { name: "org-pack follows this source" }),
	).toBeVisible();
	// The non-following chip still opens the bundle on click — carries no
	// follows marker.
	const plainChip = bundles.locator('[title="Open bundle android"]');
	await expect(plainChip).toBeVisible();
	await expect(
		plainChip.getByRole("img", { name: /follows this source/ }),
	).toHaveCount(0);

});

// Moved from equip-connections.journey.spec.ts: the one Add-source journey
// that resolves a name conflict through the stateful mock.
test("source conflict: choose import-renamed → apply shows the resolved name", async ({
	page,
}) => {
	await page.goto("/#/sources");
	await expect(page.locator(".app-main")).toBeVisible();

	await page.getByRole("main").getByRole("button", { name: "Add source" }).click();
	await page
		.getByPlaceholder("git@github.com:org/skills.git")
		.fill("git@github.com:org/pack.git");
	await page.getByRole("button", { name: "Preview" }).click();

	// The conflicting candidate surfaces its per-candidate resolver.
	await expect(page.getByTestId("conflict-code-review")).toBeVisible();
	await page.getByRole("button", { name: "Import renamed" }).click();
	// getByTestId, not getByRole("button", { name: "Apply" }): a source card's
	// already-imported skill chips are real <button>s too (S9, keyboard
	// activation), and one whose accessible name contains "...-apply-..."
	// (e.g. "openspec-apply") makes a substring-matched role query ambiguous.
	await page.getByTestId("source-apply").click();

	await expect(page.getByTestId("resolved-code-review")).toContainText(
		"code-review-2",
	);
});
