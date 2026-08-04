import { test, expect, type Page } from "@playwright/test";

// First-run tips-tour journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
//
// The mock boots a *populated*, already-bootstrapped registry, so the tour does
// NOT auto-start here — auto-start (fresh-install signal) is covered in the
// vitest suite (TipsTour.test.tsx). This journey exercises the manual relaunch
// path + the full six-step walk with per-step anchor highlighting.

// Step id → visible card title. Mirrors the TOUR array in src/lib/tips.ts.
const STEPS: { id: string; title: string }[] = [
  { id: "palette", title: "Everything is a keystroke away" },
  { id: "add-project", title: "Register a project" },
  { id: "library", title: "Fill your library" },
  { id: "equip", title: "Equip a project" },
  { id: "sync", title: "Sync writes it out" },
  { id: "help", title: "Go faster" },
];

/** Assert the violet ring sits on top of the current step's anchor. */
async function expectRingOnAnchor(page: Page, id: string) {
  const anchor = page.locator(`[data-tour="${id}"]`);
  await expect(anchor).toBeVisible();
  const ring = page.locator(".tips-ring");
  await expect(ring).toBeVisible();
  // The ring is positioned at the anchor's client rect (top/left/width/height),
  // with a short CSS transition between steps — poll until it settles onto the
  // anchor so we don't sample it mid-flight.
  await expect
    .poll(
      async () => {
        const a = await anchor.boundingBox();
        const r = await ring.boundingBox();
        if (!a || !r) return Number.MAX_SAFE_INTEGER;
        return Math.max(Math.abs(r.x - a.x), Math.abs(r.y - a.y));
      },
      { timeout: 2000 },
    )
    .toBeLessThan(3);
}

test("tips tour: relaunch from palette and walk all six steps", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();
  // Nothing auto-starts on the populated mock.
  await expect(page.locator(".tips-card")).toHaveCount(0);

  // Manual relaunch via the command palette.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".palette input");
  await expect(input).toBeVisible();
  await input.fill("tips tour");
  await page.getByText("Show tips tour").click();

  const card = page.locator(".tips-card");
  await expect(card).toBeVisible();

  // Walk every step, asserting the card title + the ring lands on the anchor.
  for (let i = 0; i < STEPS.length; i++) {
    const { id, title } = STEPS[i];
    await expect(card.locator(".tips-title")).toHaveText(title);
    await expect(card.locator(".tips-step-count")).toHaveText(
      `${i + 1} / ${STEPS.length}`,
    );
    await expectRingOnAnchor(page, id);

    if (i < STEPS.length - 1) {
      await page.getByRole("button", { name: "Next" }).click();
    }
  }

  // Final step shows Done; clicking it dismisses the tour.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tips-card")).toHaveCount(0);
});

test("tips tour: Skip tour dismisses the overlay", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette input").fill("tips tour");
  await page.getByText("Show tips tour").click();
  await expect(page.locator(".tips-card")).toBeVisible();

  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.locator(".tips-card")).toHaveCount(0);
});
