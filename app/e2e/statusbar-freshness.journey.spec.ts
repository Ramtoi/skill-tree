import { test, expect } from "@playwright/test";

// StatusBar freshness chip (B1-02): when the live registry fingerprint differs
// from the one recorded at the last sync, the aggregate chip must read "registry
// changed — re-sync" — never "in sync". The `staleReport` query flag serves a
// stale-only sync envelope (no error project). Mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.

test("statusbar chip reads stale when the registry drifted since last sync", async ({
  page,
}) => {
  await page.goto("/?staleReport=1#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  const chip = page.locator(".sync-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-state", "stale");
  await expect(chip).toContainText("registry changed — re-sync");
  await expect(chip).not.toContainText("in sync");
});
