import { test, expect } from "./fixtures";

for (const exit of ["skip", "connect", "escape"] as const) {
  test(`Add project opens its workspace after repository offer ${exit}`, async ({ page }) => {
    await page.goto("/?settingsPickFolder=1#/?addProject=1");
    const add = page.getByRole("dialog", { name: "Add project", exact: true });
    await add.getByRole("button", { name: "Browse…" }).click();
    await expect(add.getByLabel("Project name")).toHaveValue("new-settings-project");
    await add.getByRole("button", { name: "Add project", exact: true }).click();
    const offer = page.getByRole("dialog", { name: "Connect repository for new-settings-project" });
    await expect(offer).toBeVisible();
    await expect(page).not.toHaveURL(/#\/project\//);
    if (exit === "connect") {
      await offer.getByRole("button", { name: "Detect repository", exact: true }).click();
      await offer.getByRole("button", { name: "Connect repository", exact: true }).click();
    } else if (exit === "escape") {
      // Modal moves focus on the next frame. Visibility alone does not mean
      // keyboard events are routed into the new dialog yet.
      await expect(offer.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
    } else {
      await offer.getByRole("button", { name: "Skip for now" }).click();
    }
    await expect(page).toHaveURL(/#\/project\/new-settings-project$/);
    await expect(page.getByRole("navigation", { name: "Project areas" })).toBeVisible();
    await expect(offer).not.toBeVisible();
  });
}

test("cancelling Add project stays in Library", async ({ page }) => {
  await page.goto("/?settingsPickFolder=1#/?addProject=1");
  const add = page.getByRole("dialog", { name: "Add project", exact: true });
  await add.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(add).not.toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});
