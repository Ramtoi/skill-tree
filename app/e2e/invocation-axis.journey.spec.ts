import { test, expect } from "./fixtures";

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
	// RUNTIME (harnesses + triggering) is a collapsed-by-default disclosure — open it before asserting
	// on its contents.
	await page.locator('[data-testid="side-section-runtime"]').click();
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
		.locator(".project-loadout-row", { hasText: "rt-android-expert" })
		.first();
	await card.getByRole("button", { name: / details$/ }).click();
	const detail = card.locator(".resource-detail");
	await detail.locator(".invocation-override-trigger").click();
	await expect(detail.locator(".invocation-outcomes")).toBeVisible();
	await detail.getByRole("menuitemradio", { name: /User-only/ }).click();

	// The requested mode remains visible while its control lives in details.
	await expect(card.locator(".invocation-override-badge")).toBeVisible();
	await expect(
		page.locator(".resource-detail .invocation-override-trigger[data-override]"),
	).toHaveCount(1);
	await card.hover();
	await expect(
		page.locator(".resource-detail .invocation-override-trigger[data-override]"),
	).toBeVisible();

	// The undo toast reverses it back to "no override".
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(
		page.locator(".resource-detail .invocation-override-trigger[data-override]"),
	).toHaveCount(0);
	await expect(card.locator(".invocation-override-badge")).toHaveCount(0);
});

test("workspace override previews each requested mode and keeps global outcomes visible", async ({ page }) => {
	await page.goto("/?invocationNative=codex#/project/example-app");
	await expect(page.locator(".workspace-main")).toBeVisible();

	const portableCard = page.locator(".project-loadout-row", { hasText: "rt-android-expert" }).first();
	await portableCard.getByRole("button", { name: / details$/ }).click();
	const portableDetail = portableCard.locator(".resource-detail");
	await portableDetail.locator(".invocation-override-trigger").click();
	await expect(portableDetail.locator(".invocation-outcomes")).toBeVisible();
	const initialHeight = (await portableDetail.locator(".invocation-outcome-row").first().boundingBox())!.height;
	await portableDetail.getByRole("menuitemradio", { name: /User-only/ }).hover();
	await expect(portableDetail.locator(".invocation-outcome-copy").first()).toContainText(
		"Manual invocation only",
	);
	await portableDetail.getByRole("menuitemradio", { name: /Model-only/ }).focus();
	await expect(portableDetail.locator(".invocation-outcome-copy").first()).toContainText(
		"Manual invocation stays available",
	);
	const box = await portableDetail.getByRole("menu", { name: "Triggering override" }).boundingBox();
	expect(box).not.toBeNull();
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 28);
	const workspaceBox = await page.locator(".workspace-main").boundingBox();
	expect(box!.y).toBeGreaterThanOrEqual(workspaceBox!.y);
	expect(box!.y + box!.height).toBeLessThanOrEqual(workspaceBox!.y + workspaceBox!.height);

	expect((await portableDetail.locator(".invocation-outcome-row").first().boundingBox())!.height).toBe(initialHeight);
	await portableDetail.locator(".invocation-outcome-card").first().focus();
	await expect(page.locator(".invocation-outcome-tooltip")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator(".invocation-outcome-tooltip")).toHaveCount(0);
	await expect(portableDetail.getByRole("menu", { name: "Triggering override" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(portableDetail.locator(".invocation-override-trigger")).toBeFocused();

	const globalCard = page.locator(".project-loadout-row", { hasText: "brainstorm" }).first();
	await globalCard.getByRole("button", { name: / details$/ }).click();
	const globalDetail = globalCard.locator(".resource-detail");
	await globalDetail.locator(".invocation-override-trigger").click();
	await expect(globalDetail.locator(".invocation-outcomes")).toBeVisible();
	await expect(globalDetail.getByRole("menuitemradio")).toHaveCount(0);
});

// (c) Global-scope skill: the precedence explanation and the requested-mode
// badge staying visible with its details collapsed are covered in
// Invocation.test.tsx ("disables the control for a global-scope skill with
// the precedence explanation" and "shows the at-rest override badge only
// when overridden, and moves the trigger into .resource-detail, not meta").

// Only "codex" keeps a real browser row — a real navigation and a real
// checked-radio click. The other four invocationNative scenes (opencode
// variants and yaml-failure) only pin the outcome-label mapping, which
// Invocation.test.tsx's "each invocationNative scene reports its outcome
// label after saving User-only" now covers.
test("native invocation reports codex after saving User-only", async ({ page }) => {
	await page.goto("/?invocationNative=codex#/skill/brainstorm");
	await page.locator('[data-testid="side-section-runtime"]').click();
	const outcomes = page.getByLabel("Invocation outcomes");
	await expect(outcomes).toBeVisible();
	await page.getByRole("radio", { name: "User-only", exact: true }).check();
	await expect(outcomes.getByText("Enforced", { exact: true })).toBeVisible();
	await expect(page.getByRole("radio", { name: "User-only", exact: true })).toBeChecked();
});

// (d) Library: filter by invocation facet, both through the inline path (wide
// enough for the SOURCE, TRIGGER, CLASS, MODE, and CLASS MATCHING facets to
// sit directly in the row, with no Filter popover — the SOURCE facet is a
// `Select`, a fixed-width combobox, not a chip per source) and through the
// collapsed path: narrow enough that the SOURCE/TRIGGER facets don't fit, so
// the row shows a Filter chip that opens an anchored popover carrying the
// same TRIGGER group.
//
// `useFitsInline` measures against the ROW's own available width (row minus
// its padding minus the right cluster's rendered width minus the gap), not
// against `.main-subheader-left`'s own box — that child's box reshapes at the
// `@container appmain (max-width: 780px)` wrap breakpoint (it gets a full row
// to itself once the subheader wraps), which used to read as "more room" at
// exactly the width where the two clusters had in fact stopped sharing a
// line — a non-monotonic collapse/inline flip as the window narrowed.
// Measured with the real mock (4 git sources + Local + Starter Pack): the row
// is now collapsed at every width from ~520 up to ~1150, and inline from
// ~1200 up — one flip, matching the fix. 1120 sits comfortably inside the
// collapsed range.
test("library filter: the TRIGGER facet narrows to User-only inline and in the Filter popover", async ({ page }) => {
	await test.step("inline: the TRIGGER chip is clicked directly in the subheader", async () => {
		await page.setViewportSize({ width: 2560, height: 900 });
		await page.goto("/#/");
		await expect(page.getByText("SKILL TREE")).toBeVisible();

		await page.getByRole("button", { name: "User-only" }).click();

		// deep-research is user-only in the mock; auto skills (brainstorm) drop out.
		await expect(
			page.locator(".resource-row", { hasText: "deep-research" }),
		).toBeVisible();
		await expect(
			page.locator(".resource-row", { hasText: "brainstorm" }),
		).toHaveCount(0);
	});

	await test.step("collapsed: Filter opens a popover with the TRIGGER group", async () => {
		await page.setViewportSize({ width: 1120, height: 900 });
		await page.goto("/#/"); // clears the inline facet from the step above.
		await expect(page.getByText("SKILL TREE")).toBeVisible();

		await page.getByRole("button", { name: /^Filter/ }).click();
		const dialog = page.getByRole("dialog", { name: "Filter skills" });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "User-only" }).click();

		await expect(
			page.locator(".resource-row", { hasText: "deep-research" }),
		).toBeVisible();
		await expect(
			page.locator(".resource-row", { hasText: "brainstorm" }),
		).toHaveCount(0);
	});
});

for (const width of [1120, 1440]) {
	test(`target preview cards keep their height and chip colors at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto("/?invocationNative=all#/skill/brainstorm");
		await page.locator('[data-testid="side-section-runtime"]').click();
		await expect(page.locator(".invocation-heading")).toContainText("Who can trigger /brainstorm");
		await expect(page.locator(".triggering-consequence, .triggering-harness-hint")).toHaveCount(0);
		const rows = page.locator(".invocation-outcome-row");
		await expect(rows).toHaveCount(4);
		const initial = await rows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
		expect(new Set(initial).size).toBe(1);
		for (const mode of ["User-only", "Model-only", "Auto"]) {
			await page.getByRole("radio", { name: mode, exact: true }).hover();
			await expect.poll(() => rows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))).toEqual(initial);
		}
		const colors = await page.locator('.invocation-heading .affinity-chip').evaluateAll((nodes) => nodes.map((node) => {
			const style = getComputedStyle(node);
			return [style.color, style.backgroundColor, getComputedStyle(node.querySelector('.harness-glyph')!).color];
		}));
		expect(new Set(colors.map((color) => JSON.stringify(color))).size).toBe(1);
		await page.getByRole("radio", { name: "User-only", exact: true }).check();
		const claude = rows.filter({ hasText: "Claude Code" });
		await claude.getByRole("button").focus();
		await expect(page.locator(".invocation-outcome-tooltip")).toContainText("Automatic loading and subagent preloading are disabled.");
		await rows.filter({ hasText: "Codex" }).hover();
		await expect(page.locator(".invocation-outcome-tooltip")).toHaveCount(1);
		await expect(page.locator(".invocation-outcome-tooltip")).toContainText("Codex CLI");
		await page.keyboard.press("Escape");
		await expect(page.locator(".invocation-outcome-tooltip")).toHaveCount(0);
		await page.mouse.move(0, 0);
		await claude.getByRole("button").blur();
		await claude.hover();
		await expect(page.locator(".invocation-outcome-tooltip")).toBeVisible();
		await page.locator(".invocation-outcome-tooltip").hover();
		await expect(page.locator(".invocation-outcome-tooltip")).toBeVisible();
	});
}
