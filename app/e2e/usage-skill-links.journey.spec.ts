import { test, expect } from "./fixtures";

for (const route of ["/project/moon-base?tab=usage", "/usage/project/moon-base"]) {
  for (const input of ["mouse", "keyboard"]) {
    test(`skill usage opens the editor and returns to ${route} via ${input}`, async ({ page }) => {
      await page.goto(`/?usageRich=1#${route}`);
      await page.getByRole("radio", { name: "7 days", exact: true }).click();
      await page.getByRole("radio", { name: "Codex", exact: true }).click();
      const band = page.getByRole("region", { name: "Utilization" });
      await band.getByRole("button", { name: "Show all 9 skills" }).click();
      await expect(band.getByRole("listitem")).toHaveCount(9);
      await expect(page.getByRole("radio", { name: "Codex", exact: true })).toBeChecked();
      const rows = await band.getByRole("listitem").allTextContents();
      const skill = band.getByRole("link", { name: "deep-research", exact: true });
      if (input === "keyboard") {
        await skill.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(skill).toBeFocused();
        await page.keyboard.press("Enter");
      } else {
        await skill.click();
      }
      await expect(page).toHaveURL(/#\/skill\/deep-research$/);
      await expect(page.locator(".doc-editor-shell")).toBeVisible();
      await page.getByRole("button", { name: "Back to moon-base", exact: true }).click();
      await expect(page).toHaveURL(`/?usageRich=1#${route}`);
      await expect(page.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Codex", exact: true })).toBeChecked();
      await expect(band.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
      expect(await band.getByRole("listitem").allTextContents()).toEqual(rows);
      const scans = await page.evaluate(() => {
        const calls = (window as unknown as { __invokeCalls: { cmd: string; args?: { args?: string[] } }[] }).__invokeCalls;
        return calls.filter(({ cmd, args }) => cmd === "usage_scan_ccusage" || args?.args?.includes("scan-sessions"));
      });
      expect(scans).toEqual([]);
    });
  }
}
