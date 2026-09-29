import { test, expect } from "./fixtures";

test("grouped loadout keeps idle explanations and explicit refresh", async ({ page }) => {
  await page.goto("/?usageIdle=1&scanHangs=1#/project/moon-base");
  await expect(page.getByRole("region", { name: "Observed activity" })).toBeVisible();
  // Idle evidence is a secondary detail, not a repeated empty-history message.
  const row = page.locator('.project-loadout-row[data-member="deep-research"]');
  await row.getByRole("button", { name: "Show deep-research details" }).click();
  const trigger = row.getByRole("button", { name: "Explain idle skill" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const explanation = page.locator(".idle-explanation");
  await expect(explanation).toContainText("counts invocations, not influence");
  await explanation.getByRole("button", { name: "Unequip", exact: true }).click();
  await expect(row.getByTestId("skill-card-unequip")).toBeFocused();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Scanning transcripts", { exact: true })).toBeVisible();
  await page.locator('.area-card-hit', { hasText: "Usage" }).click();
  await expect(page.locator(".usage-project-area")).toBeVisible();
});
for (const width of [1000, 1440]) {
  test(`group metadata stays within the row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?usageRich=1#/project/moon-base");
    const rows = page.locator('.project-loadout-row');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      await row.scrollIntoViewIfNeeded();
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
  });
}
