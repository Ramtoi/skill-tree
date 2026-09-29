import { expect, test, type Locator, type Page } from "./fixtures";

const CLASSIFICATION_LIBRARY = "/?classification=1#/";

function skillRows(page: Page, name: string): Locator {
	return page.locator(".lib-nav-row").filter({
		has: page.locator(`.resource-name[title="${name}"]`),
	});
}

async function choose(page: Page, container: () => Locator, label: string, option: string, selection: "click" | "keyboard" = "click") {
	const select = container().getByRole("combobox", { name: label, exact: true });
	await expect(select).toBeVisible();
	await select.click();
	if (option === "Local" && selection === "keyboard") {
		await select.press("l");
		await expect(select).toHaveAttribute("aria-activedescendant", /-opt-1$/);
		await select.press("Enter");
		await expect(select).toHaveText("Local");
		return;
	}
	await page.getByRole("option", { name: new RegExp(`^${option}(?:\\s|$)`) }).click();
}

async function expectHashParam(page: Page, name: string, value: string) {
	await expect.poll(() => {
		const hash = new URL(page.url()).hash;
		return new URLSearchParams(hash.slice(hash.indexOf("?") + 1)).get(name);
	}).toBe(value);
}

/** Apply the complete list state through the controls a user sees. */
async function applyAndroidClassificationFilters(
	page: Page,
	route = CLASSIFICATION_LIBRARY,
	options: { sourceFirst?: boolean; sourceSelection?: "click" | "keyboard" } = {},
) {
	await page.setViewportSize({ width: 1600, height: 900 });
	if (route) await page.goto(route);
	await expect(page.getByTestId("floating-search")).toBeVisible();
	await page.getByTestId("floating-search-input").fill("android");
	await expectHashParam(page, "q", "android");
	// At 1600px, this route's Source/Class/mixed-mode facet cluster does not
	// fit `.main-subheader` beside the right-side actions, so it deterministically
	// collapses to the Filter chip (verified: SkillLibrary.tsx's row-vs-right
	// measurement, not the viewport width alone).
	const filter = page.locator(".main-subheader").getByRole("button", { name: /^Filter/ });
	await expect(filter).toBeVisible();
	await filter.click();
	const controls = () => page.getByRole("dialog", { name: "Filter skills" });
	await expect(controls()).toBeVisible();
	if (options.sourceFirst !== false) await choose(page, controls, "Source", "Local", options.sourceSelection ?? "keyboard");
	if (options.sourceFirst !== false) await expectHashParam(page, "source", "local");
	await choose(page, controls, "Class", "process");
	await expectHashParam(page, "class", "process");
	await controls().getByRole("button", { name: "mixed", exact: true }).click();
	await expectHashParam(page, "mode", "mixed");
	await controls().getByRole("button", { name: "Assigned only", exact: true }).click();
	await expectHashParam(page, "classScope", "assigned");
	if (options.sourceFirst === false) await choose(page, controls, "Source", "Local", options.sourceSelection ?? "click");
	if (options.sourceFirst === false) await expectHashParam(page, "source", "local");
	await controls().getByRole("button", { name: "Auto", exact: true }).click();
	await expectHashParam(page, "trigger", "auto");
	await expect(page).toHaveURL(route ? /#\/\?q=android/ : /#\/bundle\/android\?q=android/);
	await expect(page).toHaveURL(/[?&]class=process/);
	await expect(page).toHaveURL(/[?&]mode=mixed/);
	await expect(page).toHaveURL(/[?&]classScope=assigned/);
	await expect(page).toHaveURL(/[?&]source=local/);
	await expect(page).toHaveURL(/[?&]trigger=auto/);
}

async function openRuntime(page: Page) {
	const runtime = page.getByTestId("side-section-runtime");
	await expect(runtime).toBeVisible();
	if ((await runtime.getAttribute("aria-expanded")) === "false") await runtime.click();
	await expect(runtime).toHaveAttribute("aria-expanded", "true");
	const body = page.locator('[data-section-id="runtime"] .classification-section-body');
	await expect(body).toBeVisible();
}

async function pathInspector(page: Page): Promise<Locator> {
	const inspector = page.locator(".classification-path-inspector");
	await expect(inspector).toBeVisible();
	return inspector;
}

test.describe("classification library journeys", () => {
	test("Library keeps class previews out of rows before and after grouping", async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.goto(CLASSIFICATION_LIBRARY);
		const row = skillRows(page, "rt-android-expert");
		await expect(row).toHaveCount(1);
		await expect(row.locator(".classification-value-label")).toHaveCount(0);
		await expect(row.locator(".resource-name")).toBeInViewport();
		await expect(row.locator(".resource-desc")).toBeInViewport();
		await expect(row.locator(".resource-detail")).toHaveCount(0);
		await page.getByTitle("Group by class").click();
		await expect(row).toHaveCount(1);
		await expect(row.locator(".classification-value-label")).toHaveCount(0);
		await expect(row.locator(".resource-desc")).toBeInViewport();
	});

	test("bundle keeps a source selected after later classification facets", async ({ page }) => {
		await page.goto("/?classification=1#/bundle/android");
		await applyAndroidClassificationFilters(page, "", { sourceFirst: false, sourceSelection: "click" });
		await expect(page).toHaveURL(/#\/bundle\/android\?q=android/);
		await expect(page).toHaveURL(/[?&]class=process/);
		await expect(page).toHaveURL(/[?&]mode=mixed/);
		await expect(page).toHaveURL(/[?&]classScope=assigned/);
		await expect(page).toHaveURL(/[?&]source=local/);
		await expect(page).toHaveURL(/[?&]trigger=auto/);
		await expect(page.locator(".lib-list .skill-row")).toHaveCount(1);
		await expect(page.locator('.lib-list .skill-row .resource-name[title="rt-android-expert"]')).toBeVisible();
	});

	test("android bundle lens keeps the combined list state and narrows to its exact member", async ({ page }) => {
		await applyAndroidClassificationFilters(page);

		// The plain Library's own combined filters, on the list before the
		// bundle switch (the cut "plain Library combines search,
		// classification, source, and trigger filters").
		const plainRows = page.locator(".lib-list .skill-row");
		await expect(plainRows).toHaveCount(1);
		await expect(plainRows.first().locator('.resource-name[title="rt-android-expert"]')).toBeVisible();
		await expect(plainRows.first().locator('.resource-name[title="android-compose-ui"]')).toHaveCount(0);
		await expect(page.locator(".main-header")).toContainText("1 of");

		const androidBundle = page.locator('[data-testid="library-body-hit"][data-kind="bundle"][data-id="android"]');
		await expect(androidBundle).toBeVisible();
		await androidBundle.click();
		await expect(page).toHaveURL(/#\/bundle\/android$/);
		// Bundle mode starts its own list state. Apply the same combined filters
		// through its controls, then prove the skill route returns to this exact
		// bundle query after an explicit Back.
		await applyAndroidClassificationFilters(page, "");
		await expect(page).toHaveURL(/#\/bundle\/android\?q=android/);
		await expect(page).toHaveURL(/[?&]class=process/);
		await expect(page).toHaveURL(/[?&]mode=mixed/);
		await expect(page).toHaveURL(/[?&]classScope=assigned/);
		await expect(page).toHaveURL(/[?&]source=local/);
		await expect(page).toHaveURL(/[?&]trigger=auto/);

		const rows = page.locator(".lib-list .skill-row");
		await expect(rows).toHaveCount(1);
		await expect(rows.first().locator('.resource-name[title="rt-android-expert"]')).toBeVisible();
		await expect(rows.first().locator('.resource-name[title="android-compose-ui"]')).toHaveCount(0);
		await rows.first().click();
		await expect(page).toHaveURL(/#\/skill\/rt-android-expert/);
		await expect(page.getByRole("button", { name: "Back to android", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to android", exact: true }).click();
		await expect(page).toHaveURL(/#\/bundle\/android\?q=android/);
		await expect(page).toHaveURL(/[?&]class=process/);
		await expect(page).toHaveURL(/[?&]mode=mixed/);
		await expect(page).toHaveURL(/[?&]classScope=assigned/);
		await expect(page).toHaveURL(/[?&]source=local/);
		await expect(page).toHaveURL(/[?&]trigger=auto/);
	});

	test("responsive Filter exposes class, mode, and class-scope controls", async ({ page }) => {
		await page.setViewportSize({ width: 540, height: 900 });
		await page.goto(CLASSIFICATION_LIBRARY);
		const filter = page.locator(".main-subheader").getByRole("button", { name: /^Filter/ });
		await expect(filter).toBeVisible();
		await filter.click();

		const dialog = page.getByRole("dialog", { name: "Filter skills" });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("CLASS", { exact: true })).toBeVisible();
		await expect(dialog.getByRole("combobox", { name: "Class", exact: true })).toBeVisible();
		await expect(dialog.getByText("MODE", { exact: true })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "mixed", exact: true })).toBeVisible();
		await expect(dialog.getByText("CLASS MATCHING", { exact: true })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Assigned only", exact: true })).toBeVisible();
		const sourceBox = await dialog.getByRole("combobox", { name: "Source", exact: true }).boundingBox();
		const classBox = await dialog.getByRole("combobox", { name: "Class", exact: true }).boundingBox();
		expect(sourceBox).not.toBeNull();
		expect(classBox).not.toBeNull();
		expect(Math.abs(sourceBox!.y - classBox!.y)).toBeLessThan(1);
		expect(Math.abs(sourceBox!.width - classBox!.width)).toBeLessThan(1);
		const modeButtons = dialog.locator(".filter-group").filter({ has: page.getByText("MODE", { exact: true }) }).locator(".chip");
		const widths = await modeButtons.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
		expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
		const matchingButtons = dialog.locator(".filter-group").filter({ has: page.getByText("CLASS MATCHING", { exact: true }) }).locator(".chip");
		const matchingWidths = await matchingButtons.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
		expect(Math.abs(matchingWidths[0] - matchingWidths[1])).toBeLessThan(1);
		const triggerButtons = dialog.locator(".filter-group").filter({ has: page.getByText("TRIGGER", { exact: true }) }).locator(".chip");
		const triggerBoxes = await triggerButtons.evaluateAll((buttons) => buttons.map((button) => {
			const { y, width } = button.getBoundingClientRect();
			return { y, width };
		}));
		expect(triggerBoxes).toHaveLength(5);
		for (const row of [triggerBoxes.slice(0, 3), triggerBoxes.slice(3)]) {
			expect(Math.max(...row.map((box) => box.y)) - Math.min(...row.map((box) => box.y))).toBeLessThan(1);
			expect(Math.max(...row.map((box) => box.width)) - Math.min(...row.map((box) => box.width))).toBeLessThan(1);
		}
		expect(triggerBoxes[3].y).toBeGreaterThan(triggerBoxes[0].y);

		for (const group of await dialog.locator(".chips").all()) {
			expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		}
		for (const button of await dialog.locator(".chip").all()) {
			expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		}

	});

	test("imported Runtime persists a custom class while native triggering stays locked", async ({ page }) => {
		await page.setViewportSize({ width: 520, height: 900 });
		await page.goto("/?classification=1#/skill/android-compose-ui");
		await expect(page.locator(".doc-editor-shell")).toBeVisible();
		// At 520px the editor's ResizableSplit (paneLabel "Details") cannot dock
		// its fixed pane, so it deterministically renders as a collapsed overlay.
		const openDetails = page.getByRole("button", { name: "Open Details", exact: true });
		await expect(openDetails).toBeVisible();
		await openDetails.click();
		await openRuntime(page);
		const outputChoices = page.locator(".classification-section-body");
		await expect(outputChoices).toBeVisible();
		const outputGeometry = await outputChoices.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
		expect(outputGeometry.scroll).toBeLessThanOrEqual(outputGeometry.width + 1);

		await page.setViewportSize({ width: 1600, height: 900 });
		await openRuntime(page);
		await page.getByRole("button", { name: "Edit classes", exact: true }).click();
		await page.getByRole("button", { name: "Add custom", exact: true }).click();
		const addClass = page.getByRole("textbox", { name: "Add class", exact: true });
		await expect(addClass).toBeEnabled();
		await addClass.fill("external-proof");
		await addClass.press("Enter");
		await page.getByRole("button", { name: "Apply", exact: true }).click();
		const savedClasses = page.locator(".classification-section-body").getByRole("status").filter({ hasText: "Saved classes" });
		await expect(savedClasses).toBeVisible();
		await expect(page.locator('.main-header .classification-header-value[title^="external-proof"]')).toBeVisible();

		await page.getByRole("button", { name: "Edit classes", exact: true }).click();
		await page.getByRole("checkbox", { name: "external-proof", exact: true }).uncheck();
		await page.getByRole("button", { name: "Apply", exact: true }).click();
		await expect(savedClasses).toBeVisible();
		await expect(page.locator('.main-header .classification-header-value[title^="external-proof"]')).toHaveCount(0);

		const triggering = page.getByRole("radiogroup", { name: "Triggering", exact: true });
		await expect(triggering).toHaveAttribute("aria-disabled", "true");
		await expect(triggering.getByRole("radio")).toHaveCount(3);
		await expect(triggering.getByRole("radio").first()).toBeDisabled();
		await expect(page.getByText("READ-ONLY", { exact: true })).toBeVisible();
	});

	test("output contribution inspection shows every path, follows a contributor, and restores the exact filtered occurrence", async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.goto(`${CLASSIFICATION_LIBRARY}?q=android`);
		await expect(page.getByTestId("floating-search-input")).toHaveValue("android");
		await page.getByTitle("Group by class").click();
		const occurrences = skillRows(page, "rt-android-expert");
		await expect(occurrences).toHaveCount(1);
		const processHeader = page.locator(".section-header").filter({ has: page.getByText("PROCESS", { exact: true }) });
		await expect(processHeader).toHaveCount(1);
		const processRow = occurrences.first();
		await expect(processRow.locator("xpath=preceding-sibling::div[contains(@class, 'section-header')][1]").getByText("PROCESS", { exact: true })).toBeVisible();
		await expect(processRow.locator('.resource-name[title="rt-android-expert"]')).toBeVisible();
		await processRow.focus();
		await page.keyboard.press("ArrowRight");
		// Assigned-class grouping and the ArrowRight expand, folded from the
		// cut "class grouping uses assigned classes and ArrowRight expands
		// the focused occurrence".
		await expect(processRow.locator(".resource-detail")).toBeVisible();
		await expect(occurrences.filter({ has: page.locator(".resource-detail") })).toHaveCount(1);
		await expect(processRow).toHaveAttribute("data-listnav-active", "true");
		const output = processRow.getByRole("button", { name: /^code change,/i });
		await output.focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/#\/\?q=android/);

		const inspector = await pathInspector(page);
		await expect(inspector).toBeInViewport();
		await expect(inspector.locator(".classification-path").first()).toBeVisible();
		await expect(inspector.getByRole("button", { name: "android-compose-ui", exact: true })).toBeVisible();
		await expect(inspector.locator(".classification-path")).toHaveCount(2);
		await expect(inspector.locator(".classification-path").filter({ hasText: "rt-android-expert → android-compose-ui" })).toHaveCount(1);
		await expect(inspector.locator(".classification-path").filter({ hasText: "rt-android-expert → brainstorm → android-compose-ui" })).toHaveCount(1);

		await inspector.getByRole("button", { name: "android-compose-ui", exact: true }).click();
		await expect(page).toHaveURL(/#\/skill\/android-compose-ui/);
		await expect(page.getByRole("button", { name: "Back to Library", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to Library", exact: true }).click();
		await expect(page).toHaveURL(/#\/\?q=android/);
		await expect(page).not.toHaveURL(/[?&]classScope=/);
		await expect(page.locator(".section-header").filter({ has: page.getByText("PROCESS", { exact: true }) })).toBeVisible();
		await expect(skillRows(page, "rt-android-expert")).toHaveCount(1);
		const restoredActive = page.locator('[data-listnav-active="true"]').filter({ has: page.locator('.resource-name[title="rt-android-expert"]') });
		await expect(restoredActive).toHaveCount(1);
		await expect(restoredActive.locator("xpath=preceding-sibling::div[contains(@class, 'section-header')][1]").getByText("PROCESS", { exact: true })).toBeVisible();
		await expect(occurrences).toHaveCount(1);
	});
});

test("nested editor contribution navigation returns through each explicit Back arrow", async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.goto("/?classification=1#/skill/rt-android-expert");
		await expect(page.locator(".doc-editor-shell")).toBeVisible();
		await openRuntime(page);

		const rootImplementation = page.locator(".main-header .classification-header-value").filter({ hasText: /^implementation$/i });
		await expect(rootImplementation).toBeVisible();
		await rootImplementation.click();
		let inspector = await pathInspector(page);
		await expect(inspector.locator(".classification-path").first()).toBeVisible();
		await inspector.getByRole("button", { name: "android-compose-ui", exact: true }).click();
		await expect(page).toHaveURL(/#\/skill\/android-compose-ui/);
		await openRuntime(page);

		const androidProcess = page.locator(".main-header .classification-header-value").filter({ hasText: /^process$/i });
		await expect(androidProcess).toBeVisible();
		await androidProcess.click();
		inspector = await pathInspector(page);
		await expect(inspector.locator(".classification-path").first()).toBeVisible();
		await inspector.getByRole("button", { name: "rt-android-expert", exact: true }).click();
		await expect(page).toHaveURL(/#\/skill\/rt-android-expert/);

		await page.getByRole("button", { name: "Back to android-compose-ui", exact: true }).click();
		await expect(page).toHaveURL(/#\/skill\/android-compose-ui/);
		await page.getByRole("button", { name: "Back to rt-android-expert", exact: true }).click();
		await expect(page).toHaveURL(/#\/skill\/rt-android-expert/);
});

async function openClassificationSection(page: import("@playwright/test").Page, panelWidth: number) {
	await page.setViewportSize({ width: 1800, height: 1200 });
	await page.addInitScript((width) => localStorage.setItem("st:layout:skill-editor", String(width)), panelWidth);
	await page.goto("/?classification=1#/skill/rt-android-expert");
	await openRuntime(page);
	return page.locator(".classification-section-body");
}

// The loop keeps only the geometry it measures at each width; the
// interactions run once, at the narrowest width, below.
for (const panelWidth of [280, 360, 560]) {
	test(`classification controls wrap at side panel width ${panelWidth}`, async ({ page }) => {
		const section = await openClassificationSection(page, panelWidth);
		const geometry = await section.evaluate((element) => ({
			width: element.clientWidth, scroll: element.scrollWidth,
			clipped: [...element.querySelectorAll<HTMLElement>(".chip-label, .chip-label-text")].filter((label) => label.scrollWidth > label.clientWidth + 1).map((label) => label.textContent),
		}));
		expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
		expect(geometry.clipped).toEqual([]);
	});
}

test("classification controls toggle, clear and inspect at the narrowest side panel", async ({ page }) => {
	const section = await openClassificationSection(page, 280);
	await section.locator("summary").filter({ hasText: "Behavior" }).click();
	await section.getByRole("radio", { name: "conversational", exact: true }).check();
	await expect(section.getByRole("radio", { name: "conversational", exact: true })).toBeChecked();
	await section.getByRole("button", { name: "Clear interaction style" }).click();
	await expect(section.getByRole("radio", { name: "conversational", exact: true })).not.toBeChecked();
	await expect(section.getByRole("radio", { name: "conversational", exact: true })).toBeFocused();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox")).toHaveCount(9);
	await section.getByRole("button", { name: "Add custom", exact: true }).click();
	await section.getByRole("textbox", { name: "Add output", exact: true }).fill("code change");
	await section.getByRole("textbox", { name: "Add output", exact: true }).press("Enter");
	await section.getByRole("button", { name: "Apply", exact: true }).click();
	await section.getByRole("button", { name: "code change, Direct reference", exact: true }).click();
	await expect(section.locator(".classification-path-inspector")).toContainText("android-compose-ui");
	await expect(section.locator(".classification-contributors").getByRole("button", { name: "rt-android-expert", exact: true })).toHaveCount(0);
	await section.getByRole("button", { name: "Close contribution" }).click();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { name: "code change", exact: true })).toBeChecked();
	await section.getByRole("checkbox", { name: "Report", exact: true }).check();
	await section.getByRole("button", { name: "Apply", exact: true }).click();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { name: "Report", exact: true })).toBeChecked();
	await section.getByRole("checkbox", { name: "Report", exact: true }).uncheck();
	await section.getByRole("button", { name: "Apply", exact: true }).click();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { name: "Report", exact: true })).not.toBeChecked();
	const editorGeometry = await section.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
	expect(editorGeometry.scroll).toBeLessThanOrEqual(editorGeometry.width + 1);
	await section.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("classification drafts search former terms and preserve assignments until Apply", async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto("/?classification=1#/skill/rt-android-expert");
	await openRuntime(page);
	const section = page.locator(".classification-section-body");
	await expect(section.getByRole("checkbox")).toHaveCount(0);
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox")).toHaveCount(9);
	const search = section.getByRole("textbox", { name: "Search outputs", exact: true });
	await search.fill("regression evidence");
	await expect(section.getByRole("checkbox")).toHaveCount(1);
	await section.getByRole("checkbox", { name: "Evidence", exact: true }).check();
	await page.keyboard.press("Escape");
	await expect(section.getByRole("button", { name: "Edit outputs", exact: true })).toBeFocused();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { name: "Evidence", exact: true })).not.toBeChecked();
	await section.getByRole("checkbox", { name: "Evidence", exact: true }).check();
	await section.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(section.getByRole("button", { name: "Edit outputs", exact: true })).toBeFocused();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { name: "Evidence", exact: true })).toBeChecked();
	await expect(section.getByRole("checkbox", { name: "Plan", exact: true })).toBeChecked();
	await section.getByRole("button", { name: "Clear selection", exact: true }).click();
	await section.getByRole("button", { name: "Apply", exact: true }).click();
	await section.getByRole("button", { name: "Edit outputs", exact: true }).click();
	await expect(section.getByRole("checkbox", { checked: true })).toHaveCount(0);
});
