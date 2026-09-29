import { test, expect, type Page } from "./fixtures";

type InvokeCall = { cmd: string; args: unknown };

const route = "/?usageRich=1#/project/moon-base";
const reviewRoute = `${route}?tab=loadout&review=footprint-skill-brainstorm%3Aalpha`;

async function calls(page: Page): Promise<InvokeCall[]> {
  return page.evaluate(() => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls);
}

// The Loadout's missing-references banner also offers an `Equip N` button and
// sits before the Available list in DOM order, so an equip click is always
// scoped to the Available panel.
function availableEquip(page: Page) {
  return page.locator('[aria-label="Available skills"]').getByRole("button", { name: /^Equip / }).first();
}

// The ledger is never reset: every count below is over the page's whole life
// since `goto`, which is exactly the claim ("no scan before Refresh", "one read
// per visible row") the journey makes.

test.describe("usage guidance loop", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route);
    await expect(page.locator(".area-strip")).toBeVisible();
    await page.getByRole("button", { name: "Add skills", exact: true }).click();
  });

  test("prospective cost reads only visible Available rows", async ({ page }) => {
    await expect(page.locator(".avail-cost").first()).toHaveText(/~\d+ tokens/);
    const visibleRows = await page.getByRole("list", { name: "Available skills" }).getByRole("listitem").filter({ visible: true }).count();
    const readCount = async () => (await calls(page)).filter((entry) => entry.cmd === "read_skill_document").length;
    await expect.poll(readCount).toBe(visibleRows);
    const reads = (await calls(page)).filter((entry) => entry.cmd === "read_skill_document");
    expect(reads).toHaveLength(visibleRows);
  });

  test("equipping emits one capped success toast with Undo", async ({ page }) => {
    await expect(page.locator(".avail-cost").first()).toHaveText(/~\d+ tokens/);
    await availableEquip(page).click();
    const toast = page.locator(".toast");
    await expect(toast).toHaveCount(1);
    // The mock footprint carries one effective harness, so the body is one
    // cost row and no remainder; the three-row cap is pinned in
    // useProjectLoadoutFeedback.test.tsx with three in-test harnesses.
    await expect(toast.locator(".toast-body")).toContainText(/adds ~\d+ tokens to every claude-code session/);
    await expect(toast.locator(".toast-body")).not.toContainText("more");
    await expect(toast.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  });

  test("publishes a signed delta on Usage and its navigator card", async ({ page }) => {
    await availableEquip(page).click();
    await expect(page.locator('.area-card[data-area="usage"]')).toContainText(/[+−]\d+ loadout tokens/);
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    await expect(page).toHaveURL(/tab=usage/);
    await expect(page.locator(".usage-loadout-delta")).toContainText(/[+−]\d+ tokens since last loadout change/);
  });

  test("shows sessions and one changed loadout marker", async ({ page }) => {
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    await expect(page.locator('section[aria-label="Outcomes"]')).toBeVisible();
    await expect(page.locator('.chart-col').first()).toBeVisible();
    await expect(page.locator(".chart-col-marker")).toHaveCount(1);
  });

  test("opens Why in observation, numbers, moves order without IPC", async ({ page }) => {
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    const finding = page.locator(".usage-finding-card").first();
    const before = (await calls(page)).filter((entry) => entry.cmd === "hub_cmd").length;
    await finding.locator("summary", { hasText: "Why" }).click();
    await expect(finding.locator(".disclosure-content")).toBeVisible();
    await expect(finding.locator(".usage-finding-observation")).toContainText("is");
    await expect(finding.locator(".usage-finding-evidence")).toContainText("claude-code");
    await expect(finding.locator(".usage-finding-moves")).toContainText("Review");
    const order = await finding.evaluate((node) => {
      const positions = [".usage-finding-observation", ".usage-finding-evidence", ".usage-finding-moves"]
        .map((selector) => (node.querySelector(selector) as Element | null)?.getBoundingClientRect().top ?? -1);
      return positions;
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    const after = (await calls(page)).filter((entry) => entry.cmd === "hub_cmd").length;
    expect(after).toBe(before);
  });

  test("Review emphasizes the target area and clears when leaving it", async ({ page }) => {
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    // The second fixture finding (brainstorm) names a card; the first is
    // area-level only, so it would never show `.project-loadout-row[data-reviewed="true"]`.
    await page.locator(".usage-finding-card").nth(1).getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/review=footprint-skill-brainstorm%3Aalpha/);
    await expect(page.locator(".review-area-emphasis")).toBeVisible();
    await expect(page.locator(".project-loadout-row[data-reviewed]")).toBeVisible();
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    await page.locator('.area-card[data-area="loadout"] .area-card-hit').click();
    await expect(page.locator(".review-area-emphasis")).toHaveCount(0);
    await expect(page.locator(".project-loadout-row[data-reviewed]")).toHaveCount(0);
  });

  test("does not scan until Loadout Refresh, then scans once", async ({ page }) => {
    const before = (await calls(page)).filter((entry) => entry.cmd === "hub_cmd" && Array.isArray((entry.args as { args?: unknown }).args) && ((entry.args as { args: string[] }).args)[0] === "usage" && ((entry.args as { args: string[] }).args)[1] === "scan-sessions");
    expect(before).toHaveLength(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(async () => (await calls(page)).filter((entry) => entry.cmd === "hub_cmd" && Array.isArray((entry.args as { args?: unknown }).args) && ((entry.args as { args: string[] }).args)[1] === "scan-sessions").length).toBe(1);
  });

  test("keeps review, trend, and toast rows inside a 520px layout", async ({ page }) => {
    const fits = (selector: string) =>
      page.locator(selector).first().evaluate((node) => node.scrollWidth <= node.clientWidth);
    // Review emphasis at 520px, reached by URL so no wide-only control is needed.
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto(reviewRoute);
    await expect(page.locator(".review-area-emphasis")).toBeVisible();
    expect(await fits(".review-area-emphasis")).toBe(true);
    // The Available panel only renders at desktop widths: equip there, then
    // shrink the viewport. The toast lives in the store, so it survives the
    // resize (a `goto` would reload the page and drop it).
    await page.setViewportSize({ width: 1440, height: 900 });
    await availableEquip(page).click();
    await expect(page.locator(".toast")).toHaveCount(1);
    await page.setViewportSize({ width: 520, height: 900 });
    await expect(page.locator(".toast")).toHaveCount(1);
    for (const selector of [".toast-body", ".toast-action"]) {
      expect(await fits(selector)).toBe(true);
    }
    await page.locator('.area-card[data-area="usage"] .area-card-hit').click();
    await expect(page.locator(".usage-project-activity")).toBeVisible();
    expect(await fits(".usage-project-activity")).toBe(true);
  });
});

test("reduced motion removes the disclosure transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${route}?tab=usage`);
  await page.locator(".usage-finding-card").first().locator("summary", { hasText: "Why" }).click();
  await expect(page.locator(".disclosure-content").first()).toBeVisible();
  await expect(page.locator(".disclosure-content").first()).toHaveCSS("transition-duration", "0s");
});
