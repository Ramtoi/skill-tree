import { test, expect } from "./fixtures";

test("opens a project from the Projects list with Enter and lists its bands", async ({ page }) => {
  await page.goto("/?usageDrilldown=1&usageRich=1#/usage");
  await expect(page.getByRole("button", { name: "moon-base" })).toBeVisible();
  const projectLink = page.getByRole("region", { name: "Projects", exact: true }).getByRole("button", { name: "moon-base" });
  await projectLink.focus();
  await expect(projectLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/usage\/project\/moon-base$/);
  for (const band of ["Outcomes", "Sessions", "Project activity", "Footprint", "Utilization", "Findings"]) {
    await expect(page.locator(`section[aria-label="${band}"]`)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Show all 9 skills" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Show all 9 skills" }).click();
  await expect(page.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
});

test("keeps one padded scroll owner usable at wide and narrow project hosts", async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 600 }, { width: 520, height: 600 }]) {
    await page.setViewportSize(viewport);
    for (const route of ["#/usage/project/moon-base", "#/project/moon-base?tab=usage"]) {
      await page.goto(`/?usageDrilldown=1&usageRich=1${route}`);
      const body = page.locator(".main-body.project-usage-body");
      await expect(body).toBeVisible();
      await expect(page.locator('section[aria-label="Outcomes"]')).toBeVisible();
      const topBoundary = route.startsWith("#/project/") ? ".area-strip" : ".main-header";
      await expect.poll(() => page.locator(topBoundary).evaluate((node) => node.getBoundingClientRect().bottom)).toBeCloseTo(
        await body.evaluate((node) => node.getBoundingClientRect().top), 0,
      );
      const geometry = await body.evaluate((node) => {
        const el = node as HTMLElement;
        const card = el.querySelector(".usage-card") as HTMLElement | null;
        const bodyRect = el.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        return {
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          paddingLeft: getComputedStyle(el).paddingLeft,
          tokenPadding: getComputedStyle(document.documentElement).getPropertyValue("--pad-screen-x").trim(),
          contentInset: cardRect && bodyRect ? cardRect.left - bodyRect.left : 0,
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
      expect(geometry.paddingLeft).toBe(geometry.tokenPadding);
      expect(geometry.contentInset).toBeGreaterThan(0);
      await body.hover();
      await page.mouse.wheel(0, 500);
      await expect.poll(() => body.evaluate((node) => (node as HTMLElement).scrollTop)).toBeGreaterThan(0);
      await body.evaluate((node) => { const el = node as HTMLElement; el.scrollTop = 0; el.focus(); });
      const beforePageDown = await body.evaluate((node) => (node as HTMLElement).scrollTop);
      await body.press("PageDown");
      await expect.poll(() => body.evaluate((node) => (node as HTMLElement).scrollTop)).toBeGreaterThan(beforePageDown);
      await body.press("End");
      await expect.poll(() => body.evaluate((node) => (node as HTMLElement).scrollTop)).toBeGreaterThan(0);
      const findings = page.locator('section[aria-label="Findings"]');
      await expect(findings).toBeVisible();
      const bottomClearance = await body.evaluate((node) => {
        const el = node as HTMLElement;
        return {
          paddingBottom: getComputedStyle(el).paddingBottom,
          scrollPaddingBottom: getComputedStyle(el).scrollPaddingBottom,
          fabSafe: getComputedStyle(document.documentElement).getPropertyValue("--fab-safe").trim(),
        };
      });
      expect(bottomClearance.paddingBottom).toBe(bottomClearance.fabSafe);
      expect(bottomClearance.scrollPaddingBottom).toBe(bottomClearance.fabSafe);
      await expect.poll(() => body.evaluate((node) => {
        const el = node as HTMLElement;
        const card = el.querySelector('section[aria-label="Findings"]');
        if (!card) return false;
        return card.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(el).paddingBottom) + 2;
      })).toBe(true);
    }
  }
});

test("keeps the 90-day project activity chart inside a narrow host", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 600 });
  await page.goto("/?usageDrilldown=1&usageRich=1#/usage/project/moon-base");
  await page.getByRole("radio", { name: "90 days" }).click();
  await expect(page.getByRole("radio", { name: "90 days" })).toBeChecked();
  await expect(page.locator('[aria-label="Project activity"]')).toBeVisible();
  await expect(page.locator('[aria-label="Project activity"]')).toContainText("by week");
  const body = page.locator(".project-usage-body");
  expect(await body.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("pins the shelf and filters sessions by harness", async ({ page }) => {
  await page.goto("/?usageDrilldown=1&usageRich=1#/usage/project/moon-base");
  const body = page.locator(".project-usage-body");
  const shelf = page.locator(".usage-project-controls");
  await body.evaluate((node) => { (node as HTMLElement).scrollTop = 900; });
  await expect.poll(() => shelf.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(await body.evaluate((node) => node.getBoundingClientRect().top), 0);
  await page.getByRole("radio", { name: "Codex" }).click();
  await expect(page.getByTestId("usage-session-row").first()).toContainText("Codex");
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expect(page).toHaveURL(/#\/usage$/);
});

test("project sessions share summary, details and inspection, then return to project Usage", async ({ page }) => {
  await page.goto("/?usageRich=1&projectSessions=1#/project/moon-base?tab=usage");
  const rows = page.getByTestId("usage-session-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Unify the Usage session list");
  await expect(rows.nth(1)).toContainText("Review project navigation");
  await rows.nth(0).getByRole("button", { name: /session details/ }).click();
  await expect(rows.nth(0).getByLabel("Token composition for this session")).toBeVisible();
  await rows.nth(0).getByRole("button", { name: "Inspect session", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Unify the Usage session list" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  await rows.nth(1).getByRole("button", { name: /session details/ }).click();
  await expect(rows.nth(1)).toContainText("current loadout assumed");
  await expect(rows.nth(1)).toContainText("Steering turns");
  await expect(rows.nth(0).getByRole("button", { name: "Timeline", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/project\/moon-base\?tab=usage$/);
  await expect(rows.nth(0)).toContainText("Unify the Usage session list");
});


test("project cost bars share a scale at wide and narrow widths", async ({ page }) => {
  for (const width of [1440, 520]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?usageDrilldown=1&usageUnregistered=1#/usage");
    const card = page.getByRole("region", { name: "Projects", exact: true });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText("Unregistered", { exact: true })).toBeVisible();
    const tracks = await card.locator(".hbar-track").evaluateAll((nodes) =>
      nodes.map((node) => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })),
    );
    expect(tracks.length).toBeGreaterThan(1);
    for (const track of tracks) {
      expect(track.left).toBeCloseTo(tracks[0].left, 0);
      expect(track.right).toBeCloseTo(tracks[0].right, 0);
    }
    expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
});

// Folded from usage-project-picker.journey.spec.ts (merged into this file,
// D1): the picker round trip covers the return-trip steps the drilldown
// list's Enter test above no longer repeats.
test("opens, searches, and hands off the project window", async ({ page }) => {
  await page.goto("/?pickerMany=1#/usage");
  // The picker hands the overview range over as the project window: 7 days here.
  await page.getByRole("radio", { name: "7 days" }).click();
  const trigger = page.getByRole("button", { name: "Open project" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const search = page.getByRole("searchbox", { name: "Search projects" });
  await expect(search).toBeFocused();
  await search.fill("long-project");
  await search.press("Enter");
  await expect(page).toHaveURL(/#\/usage\/project\/a-long-project-name-for-search$/);
  await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
  // The handoff is consumed once: a session round trip keeps the window the
  // user landed with, and after they change it, back/forward keeps the change.
  await page.getByTestId("usage-session-row").first().click();
  await page.getByRole("button", { name: "Inspect session", exact: true }).click();
  await expect(page).toHaveURL(/#\/usage\/session\//);
  await page.getByRole("button", { name: "Back to a-long-project-name-for-search", exact: true }).click();
  await expect(page).toHaveURL(/#\/usage\/project\/a-long-project-name-for-search$/);
  await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
  await page.getByRole("radio", { name: "30 days" }).click();
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/#\/usage\/project\/a-long-project-name-for-search$/);
  await expect(page.getByRole("radio", { name: "30 days" })).toBeChecked();
  await page.getByRole("button", { name: "Back to Usage", exact: true }).click();
  await expect(page).toHaveURL(/#\/usage$/);
});

test("keeps the picker trigger named at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 700 });
  await page.goto("/?pickerMany=1#/usage");
  await expect(page.getByRole("button", { name: "Open project" })).toBeVisible();
});
