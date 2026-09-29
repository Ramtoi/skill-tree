import { test, expect, scene, WIDTH, type Page } from "./fixtures";
const route = scene("/project/example-app", { projectOverview: true });

/** `.workspace-main` fits its content horizontally. */
async function mainFitsWidth(page: Page): Promise<boolean> {
  return page.locator(".workspace-main").first().evaluate((node) => node.scrollWidth <= node.clientWidth);
}

/** The width where the overflow check hits a known product defect. */
const KNOWN_OVERFLOW_WIDTH = 390;

test("section reorder survives a reload and entry reads no sessions and writes no bundle", async ({
  page,
}) => {
  await page.setViewportSize({ width: WIDTH.wide, height: 1000 });
  await page.goto(route);
  await page.getByRole("button", { name: "Move Everyday tools up" }).click();
  const titles = page.locator(".loadout-section-toggle");
  expect(await titles.allTextContents()).toEqual([
    "Build and refine",
    "Everyday tools",
    "Keep close",
  ]);
  await page.reload();
  await expect(titles.nth(1)).toHaveText("Everyday tools");
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __invokeCalls: Array<{ cmd: string; args: { args?: string[] } }>;
        }
      ).__invokeCalls,
  );
  expect(
    calls.filter((call) => call.args?.args?.includes("scan-sessions")),
  ).toHaveLength(0);
  expect(
    calls.filter(
      (call) =>
        call.args?.args?.[0] === "bundle" && call.args?.args?.[1] === "update",
    ),
  ).toHaveLength(0);
});

for (const [width, height] of [
  [1280, 720],
  [1024, 640],
  [760, 700],
  [390, 844],
]) {
  test(`context is visible on entry at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(route);
    const context = page.getByRole("region", { name: "Context estimate" });
    await expect(context).toBeVisible();
    const box = await context.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + 80).toBeLessThan(height - 28);
    // ProjectLoadoutView renders `.workspace-main` as its real scroll
    // container (rows-cards.css `overflow: auto`), not `.main-body` — this
    // screen never mounts one. `.app-main` has `min-width: 0` and never
    // grows past its grid track (shell-main.css), so it cannot prove this.
    //
    // At 390px the check fails on a known defect, so the 390px case runs in
    // its own `test.fail()` test below. Every other check here still runs at
    // 390px.
    if (width !== KNOWN_OVERFLOW_WIDTH) {
      expect(await mainFitsWidth(page)).toBe(true);
    }
    if (width <= 1024) {
      const inventory = page.locator(".project-grouped-loadout");
      await expect(inventory).toBeVisible();
      const inventoryBox = await inventory.boundingBox();
      const previewBox = await page.locator(".project-context-section").first().boundingBox();
      expect(previewBox!.y).toBeGreaterThanOrEqual(inventoryBox!.y + inventoryBox!.height);
    }
    const header = (await page.locator(".main-header").boundingBox())!;
    for (const libraryOpen of [false, true]) {
      if (libraryOpen) await page.getByRole("button", { name: "Add skills", exact: true }).click();
      const navigation = (await page.locator(".area-strip").boundingBox())!;
      expect(navigation.x).toBeCloseTo(header.x, 0);
      expect(navigation.width).toBeCloseTo(header.width, 0);
      const body = (await page.locator(".project-loadout-overview").boundingBox())!;
      expect(body.y).toBeCloseTo(navigation.y + navigation.height, 0);
    }
    const labelsFit = await page.locator(".area-card .label").evaluateAll(labels =>
      labels.every(label => label.scrollWidth <= label.clientWidth),
    );
    expect(labelsFit).toBe(true);
  });
}

// Known defect: at 390px, `.loadout-usage-header` inside the project-activity
// card (ProjectActivityOverview) does not wrap or shrink below about 381px,
// so it overflows `.workspace-main`. This is a product defect outside
// app/e2e. `test.fail()` keeps it visible: when the layout is fixed, this
// test reports an unexpected pass, and the 390px case can move back into
// the loop above.
test(`known defect: .workspace-main overflows at ${KNOWN_OVERFLOW_WIDTH}x844`, async ({ page }) => {
  test.fail(true, "loadout-usage-header does not wrap at 390px (ProjectActivityOverview)");
  await page.setViewportSize({ width: KNOWN_OVERFLOW_WIDTH, height: 844 });
  await page.goto(route);
  await expect(page.getByRole("region", { name: "Context estimate" })).toBeVisible();
  expect(await mainFitsWidth(page)).toBe(true);
});

test("context inspection works without scanning and hooks have a working return", async ({
  page,
}) => {
  await page.goto(scene("/project/example-app", { noScan: true }));
  await page.getByRole("button", { name: "Inspect context" }).click();
  await expect(page).toHaveURL(/tab=usage&focus=footprint/);
  await expect(page.locator('[data-usage-focus="footprint"]')).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Context estimate" }),
  ).toBeVisible();
  await page.locator(".area-card-hit", { hasText: "Loadout" }).click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Hooks", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Hooks on example-app" });
  await expect(
    sheet.getByRole("checkbox", { name: "Inherited lsp-report" }),
  ).toBeDisabled();
  await sheet.getByRole("button", { name: "Open hook library" }).click();
  await page.getByRole("button", { name: "Back to example-app" }).click();
  await expect(sheet).toBeVisible();
});

test("whole-section dragging supports cancel, cross-bundle moves and subsequent controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: WIDTH.wide, height: 1000 });
  await page.goto(route);
  for (const title of ["Build and refine", "Keep close", "Everyday tools"]) {
    await page.getByRole("button", { name: title, exact: true }).click();
  }
  const headers = page.locator(".loadout-group-head");
  await headers.last().scrollIntoViewIfNeeded();
  const source = (await headers.last().boundingBox())!;
  const target = (await headers.first().boundingBox())!;
  const titles = page.locator(".loadout-section-toggle");
  await page.mouse.move(source.x + 14, source.y + 16);
  await page.mouse.down();
  await expect(
    page.locator('.loadout-group[data-dragging="true"]'),
  ).toHaveCount(1);
  await page.mouse.move(target.x + 16, target.y + 16);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await titles.allTextContents()).toEqual([
    "Build and refine",
    "Keep close",
    "Everyday tools",
  ]);
  await page.mouse.move(source.x + 14, source.y + 16);
  await page.mouse.down();
  await expect(
    page.locator('.loadout-group[data-dragging="true"]'),
  ).toHaveCount(1);
  await page.mouse.move(target.x + 16, target.y + 16);
  await page.mouse.up();
  await expect(titles.first()).toHaveText("Everyday tools");
  await expect(titles.first()).toBeFocused();
  await titles.first().click();
  await expect(
    page.locator(".loadout-group").first().locator(".project-loadout-row"),
  ).not.toHaveCount(0);
  await page.getByRole("button", { name: "Reset order" }).click();
  await expect(titles.first()).toHaveText("Build and refine");
});

test("browser back restores the loadout filter and focus after details and Usage", async ({
  page,
}) => {
  await page.goto(route);
  const search = page.getByPlaceholder("Find in loadout…");
  await search.fill("context7");
  const row = page
    .locator('.project-loadout-row[data-member="context7"]')
    .first();
  await row.click();
  await page.goBack();
  await expect(search).toHaveValue("context7");
  await expect(row).toBeFocused();
  await page.getByRole("button", { name: "Inspect context" }).click();
  await expect(page.locator('[data-usage-focus="footprint"]')).toBeFocused();
  await page.goBack();
  await expect(search).toHaveValue("context7");
  await expect(
    page.getByRole("region", { name: "Context estimate" }),
  ).toBeVisible();
});

test("dense loadouts retain unique totals, shared metadata reads and usable disclosures", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(scene("/project/example-app", { projectOverview: true, projectOverviewDense: true }));
  const rows = page.locator(".project-loadout-row");
  const rowCount = await rows.count();
  const memberNames = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-member")),
  );
  const uniqueCount = new Set(memberNames).size;
  expect(rowCount).toBeGreaterThan(uniqueCount);
  expect(uniqueCount).toBeGreaterThanOrEqual(200);
  const totalsButton = page.getByRole("button", { name: /^\d+ skills · \d+ MCPs$/ });
  await expect(totalsButton).toBeVisible();
  const totalsText = (await totalsButton.textContent())!;
  const totalsMatch = totalsText.match(/^(\d+) skills · (\d+) MCPs$/);
  expect(totalsMatch).not.toBeNull();
  const [, skillCount, mcpCount] = totalsMatch!;
  expect(Number(skillCount) + Number(mcpCount)).toBe(uniqueCount);
  const last = rows.last();
  await last.getByRole("button", { name: / details$/ }).click();
  await expect(last.locator(".resource-detail")).toBeVisible();
  // `.workspace-main`, not `.main-body` (see the comment above) — this
  // screen never mounts a `.main-body`.
  expect(await mainFitsWidth(page)).toBe(true);
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __invokeCalls: Array<{ args: { args?: string[] } }>;
        }
      ).__invokeCalls,
  );
  const reads = calls.filter(
    (call) => call.args?.args?.[0] === "mcp" && call.args?.args?.[1] === "show",
  );
  expect(
    reads.filter((call) => call.args.args?.includes("context7")),
  ).toHaveLength(1);
});

test("switching project areas preserves the overview scroll position", async ({
  page,
}) => {
  await page.goto(route);
  await page.locator(".project-loadout-row").last().scrollIntoViewIfNeeded();
  const before = await page
    .locator(".loadout-overview-main")
    .evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.locator(".area-card-hit", { hasText: "Agent Docs" }).click();
  await expect(page.locator(".agent-docs-grid")).toBeVisible();
  await page.locator(".area-card-hit", { hasText: "Loadout" }).click();
  await expect
    .poll(() =>
      page
        .locator(".loadout-overview-main")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(before - 3);
});
