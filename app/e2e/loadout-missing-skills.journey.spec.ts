import { test, expect } from "./fixtures";

test("review missing skills, cancel with keyboard, and equip one chosen skill", async ({ page }) => {
  await page.goto("/?missingSkills=1#/project/moon-base");
  const review = page.getByRole("button", { name: "Review missing skills" });
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Missing skills" });
  const reviewRow = dialog.locator(".missing-skills-row").filter({ has: page.getByRole("checkbox", { name: "Select review-helper", exact: true }) });
  await expect(reviewRow.getByText("~/.skill-hub/skills/rt-android-expert/SKILL.md", { exact: true })).toBeVisible();
  await expect(reviewRow.getByText("~/.skill-hub/skills/brainstorm/SKILL.md", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Equip 0 selected skills" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Select review-helper", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(review).toBeFocused();
  await review.click();
  await expect(dialog.getByRole("checkbox", { name: "Select review-helper", exact: true })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Select review-helper", exact: true }).check();
  await dialog.getByRole("button", { name: "Equip 1 selected skill" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".project-loadout-row").filter({ hasText: "review-helper" })).toBeVisible();
  await review.click();
  await expect(dialog.getByRole("checkbox", { name: "Select review-helper", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Select test-helper", exact: true })).not.toBeChecked();
});
