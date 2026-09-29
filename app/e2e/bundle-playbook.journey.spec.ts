import { test, expect, type Page, type Locator } from "./fixtures";

test("arranges a bundle, keeps membership, and undoes a move after another edit", async ({ page }) => {
  await page.goto("/?bundlePlaybook=1#/bundle/android");
  const core = page.getByRole("region", { name: "Build and refine", exact: true });
  const companions = page.getByRole("region", { name: "Keep close", exact: true });
  await expect(core.locator(".skill-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Grid view", exact: true })).toHaveCount(0);

  const movingRow = page.locator('.playbook-skill[data-skill-name="rt-android-expert"] .lib-nav-row');
  await movingRow.focus();
  await movingRow.press("Alt+m");
  await page.getByRole("combobox", { name: "Section for rt-android-expert" }).click();
  await page.getByRole("option", { name: "Keep close", exact: true }).click();
  await expect(companions.locator(".skill-row")).toHaveCount(3);
  await expect(movingRow).toBeFocused();
  const moveToast = page.locator(".toast", { hasText: "Moved rt-android-expert" });
  await moveToast.hover();
  await page.getByRole("textbox", { name: "Guidance for Keep close" }).fill("Companions for every project.");
  await page.getByRole("textbox", { name: "Guidance for Keep close" }).press("Enter");
  await moveToast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(core.locator(".skill-row")).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Guidance for Keep close" })).toHaveValue("Companions for every project.");
  await expect(page.locator(".bundle-playbook .skill-row")).toHaveCount(4);

  // Revisit through the navigator, keeping the mock backend alive.
  await page.locator(".app-side .side-item-main", { hasText: "openspec" }).first().click();
  await page.locator(".app-side .side-item-main", { hasText: "android" }).first().click();
  await expect(page.getByRole("textbox", { name: "Guidance for Keep close" })).toHaveValue("Companions for every project.");
});

test("drags skills into an empty freely named section and can delete it without removing members", async ({ page }) => {
  await page.goto("/#/bundle/android");
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByRole("button", { name: "Rename section: New section", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Section", exact: true });
  await name.fill("My utilities");
  await name.press("Enter");
  const target = page.getByRole("region", { name: "My utilities", exact: true });
  await holdMove(page, page.locator('.playbook-skill[data-skill-name="android-compose-ui"] .resource-name'), target.locator(".playbook-drop-end"));
  await expect(target.locator(".skill-row")).toHaveCount(1);
  await target.hover();
  await page.getByRole("button", { name: "Delete section My utilities; keep its skills", exact: true }).click();
  await expect(target.locator(".skill-row")).toHaveCount(1);
  await expect(target.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await target.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await expect(target.locator(".playbook-delete-trigger")).toBeFocused();
  await target.locator(".playbook-delete-trigger").click();
  await target.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(target.locator(".skill-row")).toHaveCount(1);
  await target.locator(".playbook-delete-trigger").click();
  await expect(target).toContainText("1 skill moves to Unsectioned.");
  await target.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(target).toHaveCount(0);
  await expect(page.locator(".bundle-playbook .skill-row")).toHaveCount(4);
});

test("keyboard navigation follows playbook order, including MCP rows", async ({ page }) => {
  await page.goto("/?bundlePlaybook=1#/bundle/android");
  const rows = page.locator(".bundle-playbook .lib-nav-row");
  await expect(rows).toHaveCount(4);
  await rows.first().focus();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/skill\/git-committer-mcp/);
});


async function holdMove(page: Page, source: Locator, target: Locator, cancel = false) {
  const start = await source.boundingBox();
  if (!start) throw new Error("Missing move source");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await expect(page.locator(".bundle-playbook")).toHaveAttribute("data-dragging", "true");
  await expect(page.locator(".resource-disclosure").first()).toHaveCSS("cursor", "pointer");
  const end = await target.boundingBox();
  if (!end) throw new Error("Missing move target");
  await page.mouse.move(end.x + end.width / 2, end.y + 2, { steps: 8 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".bundle-playbook")).not.toHaveAttribute("data-dragging");
}

test("hold moves preserve click, control activation and Escape cancellation", async ({ page }) => {
  await page.goto("/?bundlePlaybook=1#/bundle/android");
  const row = page.locator('.playbook-skill[data-skill-name="rt-android-expert"]');
  const target = page.getByRole("region", { name: "Keep close", exact: true });
  await expect(page.locator(".playbook-handle")).toHaveCount(0);
  const disclosure = row.locator(".resource-disclosure");
  const box = (await disclosure.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Deliberately exceed pickup time while pressing a control.
  await page.waitForTimeout(350);
  await expect(page.locator(".bundle-playbook")).not.toHaveAttribute("data-dragging");
  await page.mouse.up();
  await expect(row.locator(".skill-row-detail")).toContainText("Use for");
  await expect(row.locator(".skill-row-detail")).toContainText("Produces");
  await expect(row.locator(".skill-row-detail")).not.toContainText("In bundles");
  await disclosure.click();
  await holdMove(page, row.locator(".resource-name"), target.locator(".playbook-drop-end"), true);
  await expect(target.locator(".skill-row")).toHaveCount(2);
  await expect(page).toHaveURL(/#\/bundle\/android/);
  await holdMove(page, row.locator(".resource-name"), target.locator(".playbook-drop-end"));
  await expect(target.locator(".skill-row")).toHaveCount(3);
  await expect(page).toHaveURL(/#\/bundle\/android/);
  await page.locator(".toast", { hasText: "Moved rt-android-expert" }).getByRole("button", { name: "Undo" }).click();
  await expect(target.locator(".skill-row")).toHaveCount(2);
  await row.locator(".resource-name").click();
  await expect(page).toHaveURL(/#\/skill\/rt-android-expert/);
});

test("section headings move by holding their background, and keyboard shortcuts reorder rows", async ({ page }) => {
  await page.goto("/?bundlePlaybook=1#/bundle/android");
  const core = page.getByRole("region", { name: "Build and refine", exact: true });
  const companion = page.getByRole("region", { name: "Keep close", exact: true });
  await holdMove(page, companion.locator(".playbook-section-heading"), core.locator(".playbook-section-heading"));
  await expect(page.locator(".playbook-section").first()).toHaveAttribute("data-section-id", "companions");
  const row = core.locator('.playbook-skill[data-skill-name="rt-android-expert"] .lib-nav-row');
  await row.focus();
  await row.press("Alt+ArrowDown");
  await expect(core.locator(".playbook-skill").last()).toHaveAttribute("data-skill-name", "rt-android-expert");
  await expect(row).toBeFocused();
});


for (const width of [1440, 768, 520]) {
  test.describe(`bundle-playbook alignment @ ${width}px`, () => {
    test("skill hover, expanded statistics and section delete stay aligned", async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/?bundlePlaybook=1#/bundle/android");
      const row = page.locator('.playbook-skill[data-skill-name="android-jetpack-compose-material3-theming-helper"] .skill-row');
      const section = page.getByRole("region", { name: "Build and refine", exact: true });

      await test.step("skill hover and expanded statistics", async () => {
        await page.mouse.move(0, 0);
        const before = await row.locator(".resource-line").boundingBox();
        await row.hover();
        const after = await row.locator(".resource-line").boundingBox();
        expect.soft(after).toEqual(before);
        await expect(row).toHaveCSS("cursor", "grab");
        await expect(row.locator(".resource-disclosure")).toHaveCSS("cursor", "pointer");
        expect.soft(await row.locator(".resource-actions").evaluate((node) => getComputedStyle(node).transitionDuration)).not.toBe("0s");
        await row.locator(".resource-disclosure").click();
        await expect(row.locator(".skill-detail-stats")).toContainText("Equipped projects");
        await expect(row.locator(".skill-detail-stats")).toContainText("Referenced by");
        await expect(row.locator(".resource-desc")).toBeVisible();
        const name = (await row.locator(".resource-name").boundingBox())!;
        const detail = (await row.locator(".skill-row-detail").boundingBox())!;
        expect.soft(Math.abs(name.x - detail.x)).toBeLessThan(1);
        expect.soft(name.width).toBeGreaterThan(140);
        expect.soft(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        const band = page.locator(".main-subheader");
        await expect(band).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeVisible();
        expect.soft(await band.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        const bounds = (await band.boundingBox())!;
        const input = (await page.locator(".bundle-desc-input").boundingBox())!;
        expect.soft(input.x - bounds.x).toBeGreaterThanOrEqual(12);
      });

      await test.step("section delete confirmation stays inline; empty sections delete directly", async () => {
        await section.locator(".playbook-section-heading").hover();
        await section.locator(".playbook-delete-trigger").click();
        await expect(section.locator(".playbook-delete-confirm")).toContainText("2 skills move to Unsectioned.");
        await expect(section.locator(".skill-row")).toHaveCount(2);
        expect.soft(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect.soft(await section.locator(".playbook-delete-confirm").evaluate((node) => getComputedStyle(node).animationName)).toBe("playbook-confirm-in");
      });

      // Both reduced-motion checks together, at the end: the hovered row's
      // detail stays open and the delete confirm stays open until here.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(row.locator(".resource-actions")).toHaveCSS("transition-duration", "0s");
      await expect(section.locator(".playbook-delete-confirm")).toHaveCSS("animation-name", "playbook-confirm-fade");

      await section.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Add section", exact: true }).click();
      const empty = page.getByRole("region", { name: "New section", exact: true });
      await empty.hover();
      await empty.locator(".playbook-delete-trigger").click();
      await expect(empty).toHaveCount(0);
    });
  });
}
