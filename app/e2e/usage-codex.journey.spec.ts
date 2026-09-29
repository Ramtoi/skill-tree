import { test, expect } from "./fixtures";

test("groups Codex families while preserving Claude rows and filters", async ({ page }) => {
  await page.goto("/?codexFamilies=1#/usage");
  const sessions = page.getByRole("region", { name: "Sessions" });
  await expect(sessions).toBeVisible();
  await expect(sessions.getByText("Usage identity rollout", { exact: true })).toBeVisible();
  await expect(sessions.getByText("Includes 2 agents", { exact: true })).toBeVisible();
  await expect(sessions.getByText("Orphan agent", { exact: true })).toBeVisible();
  await expect(sessions.getByText("Parent unavailable", { exact: true })).toBeVisible();
  await expect(sessions.getByText("Claude Code", { exact: false }).first()).toBeVisible();

  const search = sessions.getByPlaceholder("Search sessions…");
  await search.fill("Scout");
  await expect(sessions.getByText("No sessions match the selected filters.", { exact: true })).toHaveCount(0);
  await expect(sessions.getByText("Usage identity rollout", { exact: true })).toBeVisible();
  await search.fill("");

  const family = sessions.getByTestId("usage-session-row").filter({ hasText: "Usage identity rollout" });
  await family.getByRole("button", { name: "Show session details" }).click();
  // The expanded row lists no agents of its own; the sheet's timeline does.
  await expect(family.getByRole("region", { name: "Session agents" })).toHaveCount(0);
  await family.getByRole("button", { name: "Inspect session", exact: true }).click();
  const sheet = page.getByTestId("usage-session-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("usage-inspection-lane").first()).toContainText("Main session");
  await sheet.getByTestId("usage-inspection-lane").filter({ hasText: "Agent" }).first().click();
  await expect(page.getByRole("region", { name: "Agent statistics", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Tool calls for this agent" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("usage-session-sheet")).toHaveCount(0);
  await expect(search).toHaveValue("");
});

for (const width of [1440, 760]) {
  test(`long session labels preserve metadata and inspection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?codexFamilies=1&longSessionTitles=1#/usage");
    const row = page.getByTestId("usage-session-row").filter({ hasText: "$plan-it Support invocation modes" });
    await expect(row).toBeVisible();
    const label = row.locator(".usage-session-title");
    await expect(label).toHaveAttribute("title", (await label.textContent())!);
    const nameBox = await label.boundingBox();
    const metaBox = await row.locator(".usage-session-meta").boundingBox();
    const activity = row.locator(":scope > .resource-line > .resource-desc");
    await expect(activity).toBeVisible();
    expect(metaBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
    expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await row.getByRole("button", { name: "Show session details" }).click();
    await expect(row.getByRole("button", { name: "Timeline", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "Inspect session", exact: true }).click();
    await expect(page.getByTestId("usage-session-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("usage-session-sheet")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Hide session details" })).toBeVisible();
  });
}
