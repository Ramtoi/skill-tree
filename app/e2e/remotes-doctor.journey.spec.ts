import { test, expect } from "@playwright/test";

// Remotes doctor + lazy-health journey, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). The `remoteDoctor` query flag
// (read by the mock's sceneFlag) makes `remote_doctor` return one DANGER finding
// (host-key mismatch) for hermes-main. NEVER touches ~/.claude.

test("remotes doctor: danger banner surfaces and the detail lists the finding", async ({
  page,
}) => {
  await page.goto("/?remoteDoctor=1#/remotes");
  await expect(page.locator(".remotes-screen")).toBeVisible();

  // The aggregate danger banner renders (one host-key-mismatch finding).
  const banner = page.getByTestId("remote-doctor-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("attention");

  // Open the affected remote via the banner's per-remote link.
  await banner.getByRole("button", { name: "hermes-main" }).click();
  await expect(page.locator(".remote-detail")).toBeVisible();

  // The detail Risks section lists the same finding.
  const risks = page.getByTestId("remote-risks");
  await expect(risks).toBeVisible();
  await expect(risks).toContainText("Host key changed");
});

test("remotes health chip: rests at 'check health', probes only on click", async ({
  page,
}) => {
  await page.goto("/?remoteDoctor=1#/remotes");
  await expect(page.locator(".remotes-screen")).toBeVisible();

  // The per-card health chip does NOT auto-probe on load — it renders an honest
  // resting "check health" button (data-action="check"), never a fake "checking…".
  const chip = page.locator('.remote-health-chip[data-action="check"]').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("check health");

  // Clicking it fires the live probe; the mock reports a reachable box → "reachable".
  await chip.click();
  await expect(
    page.locator(".remote-card").first().locator(".remote-health-chip"),
  ).toContainText("reachable");
});
