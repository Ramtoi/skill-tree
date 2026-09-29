import { test, expect } from "./fixtures";
import { gotoReady } from "./helpers";

const SESSION = "eeeeeeee-6666-4666-8666-666666666666";
const CODEX_SESSION = "ffffffff-7777-4777-8777-777777777777";
const CLAUDE_RUN = "a27867c5fd3bd4647578e0c4273ed65f72679dcdc4c426afc0b1f488752ed2fa";

test("opens pinned sessions from the toolbar and returns to Usage with the keyboard", async ({ page }) => {
  await gotoReady(page, "/#/usage");
  const pins = page.getByRole("button", { name: "Pinned sessions", exact: true });
  await pins.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Pinned sessions", exact: true })).toBeVisible();
  const back = page.getByRole("button", { name: "Back to Usage", exact: true });
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/usage$/);
  await expect(pins).toBeVisible();
});

test("returns to Usage when pinned sessions is opened directly", async ({ page }) => {
  await page.goto("/#/usage/pinned");
  await page.getByRole("button", { name: "Back to Usage", exact: true }).click();
  await expect(page).toHaveURL(/#\/usage$/);
  await expect(page.getByRole("button", { name: "Pinned sessions", exact: true })).toBeVisible();
});

test("keeps every timeline lane on one shared time axis at desktop and narrow widths", async ({ page }) => {
  for (const width of [1280, 520]) {
    await test.step(`lanes share one axis at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/#/usage/session/${SESSION}?harness=claude-code`);
      await expect(page.getByTestId("usage-inspection-timeline")).toBeVisible();
      // EVERY track, not just the first pair: each lane is its own grid, so
      // content-sized columns put each track at its own width and start. The
      // fixture's lanes carry near-identical stat text, which is why comparing
      // two of them passed while real sessions (253.2M tok · 4,395 tools next
      // to 5.3M tok · 114 tools) drew a different width per row.
      const tracks = page.locator(".usage-lane-track");
      const boxes = await tracks.evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, width: box.width };
      }));
      expect(boxes.length).toBeGreaterThan(1);
      for (const box of boxes) {
        expect(box.x).toBe(boxes[0].x);
        expect(box.width).toBe(boxes[0].width);
      }
    });

    await test.step(`zoomed axis aligned and scrolls at ${width}px`, async () => {
      const timeline = page.getByTestId("usage-inspection-timeline");
      await expect(timeline).toBeVisible();
      await timeline.getByRole("button", { name: "Zoom in" }).click();
      await timeline.getByRole("button", { name: "Zoom in" }).click();
      const canvas = timeline.locator(".usage-timeline-canvas");
      const track = timeline.locator(".usage-lane-track").first();
      const axis = timeline.locator(".usage-timeline-axis-track");
      const canvasGeometry = await canvas.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      expect(canvasGeometry.scrollWidth).toBeGreaterThan(canvasGeometry.clientWidth);
      const trackBox = await track.boundingBox();
      const axisBox = await axis.boundingBox();
      expect(trackBox).not.toBeNull();
      expect(axisBox).not.toBeNull();
      expect(Math.abs(axisBox!.x - trackBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(axisBox!.width - trackBox!.width)).toBeLessThanOrEqual(1);
      await canvas.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
      const end = await track.locator(".usage-lane-life").first().boundingBox();
      const afterScroll = await track.boundingBox();
      expect(end).not.toBeNull();
      expect(afterScroll).not.toBeNull();
      expect(end!.x + end!.width).toBeLessThanOrEqual(afterScroll!.x + afterScroll!.width + 1);
    });
  }
});

test("filters recorded locations while keeping the shared axis geometry", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto(`/#/usage/session/${CODEX_SESSION}?harness=codex`);
  const timeline = page.getByTestId("usage-inspection-timeline");
  const location = timeline.getByLabel("Filter timeline by recorded location");
  await expect(location.locator("option")).toHaveCount(3);
  await location.selectOption({ index: 1 });
  const track = timeline.locator(".usage-lane-track").first();
  const axis = timeline.locator(".usage-timeline-axis-track");
  const trackBox = await track.boundingBox();
  const axisBox = await axis.boundingBox();
  expect(trackBox).not.toBeNull();
  expect(axisBox).not.toBeNull();
  expect(Math.abs(axisBox!.x - trackBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(axisBox!.width - trackBox!.width)).toBeLessThanOrEqual(1);
});

test("filters captured Tool calls by agent and copies displayed body evidence", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/#/usage/session/${SESSION}?harness=claude-code`);
  const panel = page.getByTestId("usage-inspection-panel");
  await panel.getByRole("radio", { name: "Tool calls" }).click();
  await expect(panel.locator(".usage-tool-group-toggle").first()).toBeVisible();
  await panel.locator("select[aria-label='Filter tool calls by agent']").selectOption(CLAUDE_RUN);
  await panel.locator(".usage-tool-group-toggle").first().click();
  await panel.getByRole("button", { name: /Input: available/ }).first().click();
  await expect(panel.getByRole("region", { name: "Captured body" })).toContainText("git status");
  const body = panel.getByRole("region", { name: "Captured body" });
  const copy = body.getByRole("button", { name: "Copy displayed text" });
  await copy.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await body.locator("pre").textContent());
  await panel.getByRole("button", { name: /Recorded result: available/ }).first().click();
  await expect(panel.getByRole("region", { name: "Captured body" }).locator("pre")).toBeVisible();
  await copy.focus();
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await body.locator("pre").textContent());
});

test("names retained and pruned evidence in the retention scene", async ({ page }) => {
  await page.goto(`/?usagePruned=1#/usage/session/${SESSION}?harness=claude-code`);
  const panel = page.getByTestId("usage-inspection-panel");
  await panel.getByRole("radio", { name: "Tool calls" }).click();

  const shellGroup = panel.getByRole("button", { name: /Runs a shell command/ });
  await expect(shellGroup).toHaveCount(1);
  await shellGroup.click();
  await expect(panel.getByRole("button", { name: /Input: available/ })).toBeEnabled();
  const prunedResult = panel.getByRole("button", { name: /Result pruned/ });
  await expect(prunedResult).toBeDisabled();
  await expect(prunedResult).toContainText("2026");

  const editGroup = panel.getByRole("button", { name: /Updates a file/ });
  await expect(editGroup).toHaveCount(1);
  await editGroup.click();
  const prunedInput = panel.getByRole("button", { name: /Input pruned/ });
  await expect(prunedInput).toBeDisabled();
  await expect(prunedInput).toContainText("2026");

  await panel.getByRole("radio", { name: "Changes" }).click();
  const change = panel.locator(".usage-inspection-change").filter({ hasText: "pruned-demo.txt" });
  await expect(change).toContainText(/Patch pruned/);
  await expect(change).toContainText("2026");
});

test("propagates repository-qualified PR evidence through the inspector picker", async ({ page }) => {
  await page.goto(`/#/usage/session/${CODEX_SESSION}?harness=codex`);
  // Folded from "renders a captured Codex inspection with the shared
  // timeline contract" (same codex route): the shared timeline contract
  // still renders for a captured Codex session, and names its capture
  // evidence.
  await expect(page.getByTestId("usage-inspection-timeline")).toBeVisible();
  expect.soft(await page.getByTestId("usage-inspection-lane").first().textContent()).toContain("Main session");
  await expect.soft(page.getByRole("status", { name: /Capture evidence:/ })).toBeVisible();
  const panel = page.getByTestId("usage-inspection-panel");
  const picker = panel.getByTestId("usage-inspection-pr-picker");
  await picker.locator("summary").click();
  await expect(picker.locator(".usage-pr-link")).toHaveCount(3);
  await expect(picker.locator(".usage-pr-link").filter({ hasText: "acme/demo" }).first()).toBeVisible();
  await expect(picker.locator(".usage-pr-link").filter({ hasText: "acme/other" }).first()).toBeVisible();
});

test("opens the row PR picker without expanding the session or sheet", async ({ page }) => {
  await page.goto("/?inspection=1#/usage");
  const row = page.locator('[data-session-id="ffffffff-7777-4777-8777-777777777777"]');
  await expect(row).toBeVisible();
  const picker = row.locator(".usage-row-pr-picker");
  await picker.locator("summary").click();
  await expect(picker.locator(".usage-pr-link")).toHaveCount(2);
  await expect(page.getByTestId("usage-session-sheet")).toHaveCount(0);
  await expect(row.locator(".resource-detail")).toHaveCount(0);
});

test("pins an agent subtree, reloads the pin destination, and follows its breadcrumb", async ({ page }) => {
  // The generated Codex contract includes a real child run. Remove its
  // fixture-seeded pin first so this journey proves add + reload persistence.
  await page.goto(`/#/usage/pinned`);
  // Folded from "opens the dedicated pins destination and preserves the
  // parent breadcrumb": the fixture-seeded pin names its own session first.
  await expect.soft(page.locator(".usage-pinned-item").first()).toContainText("Main session");
  const seeded = page.locator(".usage-pinned-item").filter({ hasText: "codex" }).filter({ hasText: "agent subtree" }).first();
  await expect(seeded).toBeVisible();
  await seeded.getByRole("button", { name: /Unpin (agent subtree|session)/ }).click();
  await expect(seeded).toHaveCount(0);

  await page.goto(`/#/usage/session/${CODEX_SESSION}?harness=codex`);
  const panel = page.getByTestId("usage-inspection-panel");
  await panel.getByTestId("usage-inspection-lane").filter({ hasText: /agent/i }).click();
  await panel.getByRole("button", { name: /Pin agent subtree/i }).click();
  await page.goto("/#/usage/pinned");
  const added = page.locator(".usage-pinned-item").filter({ hasText: "codex" }).filter({ hasText: "agent subtree" }).first();
  await expect(added).toBeVisible();
  await page.reload();
  const reloaded = page.locator(".usage-pinned-item").filter({ hasText: "codex" }).filter({ hasText: "agent subtree" }).first();
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Agent");
  await expect(reloaded.getByRole("button", { name: "Open parent" })).toBeVisible();
  await reloaded.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("usage-inspection-panel")).toBeVisible();
});

test("keeps a missing Codex inspection honest", async ({ page }) => {
  await page.goto(`/#/usage/session/${SESSION}?harness=codex`);
  await expect(page.getByText(/no captured inspection yet; showing the legacy usage timeline/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Scan/ })).toBeVisible();
});
