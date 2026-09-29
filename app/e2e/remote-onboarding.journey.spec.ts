import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Wide viewport so the right-anchored wizard Sheet + master–detail panes render.
test.use({ viewport: { width: 1440, height: 900 } });

// [transport-aware-onboarding] journeys: onboarding a connector end-to-end
// against the mocked-Tauri dev server (VISUAL_MOCK=1). Exercises the registry-
// driven cards (each card comes from the mocked catalog) and the per-transport
// branch (SSH keeps the host-key/TOFU steps; HTTPS is endpoint + token only,
// https-only validation). Never touches ~/.claude.

type Transport = {
  transport: string;
  steps: number;
  card: string;
  flow: (sheet: Locator, page: Page) => Promise<void>;
};

const TRANSPORTS: Transport[] = [
  {
    transport: "SSH",
    steps: 5,
    card: "Hermes",
    flow: async (sheet) => {
      // Step 2: name + host, then Next.
      await sheet.getByPlaceholder("hermes-main").fill("box-two");
      await sheet.getByPlaceholder("hermes@moon-base").fill("me@box");
      await sheet.getByRole("button", { name: /^Next$/ }).click();
      await expect(sheet.getByText(/step 3 \/ 5/)).toBeVisible();

      // Back works too.
      await sheet.getByRole("button", { name: /^Back$/ }).click();
      await expect(sheet.getByText(/step 2 \/ 5/)).toBeVisible();
    },
  },
  {
    transport: "HTTPS",
    steps: 3,
    card: "Worker Pool",
    flow: async (sheet, page) => {
      // The endpoint+token step shape (no host-key/TOFU controls) is
      // AddRemoteWizard.test.tsx "https connectors show an endpoint step and
      // never a host-key step"; the inline https-only validation (a
      // plain-http endpoint fails closed, fixing the scheme unlocks Next) is
      // AddRemoteWizard.test.tsx "https endpoint validation blocks http://
      // and accepts https://". Both are unit-level and need no browser; this
      // flow only fills valid values and proceeds, keeping the real-browser
      // hand-off and remotes-list check below.
      // The https flow is 3 steps (connector → endpoint+token → health), not 5.
      await expect(sheet.getByText(/step 2 \/ 3/)).toBeVisible();
      await sheet.getByPlaceholder("workers-prod").fill("workers-prod");
      await sheet.getByPlaceholder("paste token").fill("s3cr3t-token");
      await sheet
        .getByPlaceholder("https://workers.example.com")
        .fill("https://workers.example.com");
      await sheet.getByRole("button", { name: /^Next$/ }).click();

      // Step 3: health/summary → register. The mock accepts the add + health probe.
      await expect(sheet.getByText(/step 3 \/ 3/)).toBeVisible();
      await sheet.getByRole("button", { name: /Create remote/i }).click();

      // Hand-off navigates to the new remote's detail page.
      await expect(page).toHaveURL(/#\/remote\/workers-prod/);
      await expect(page.locator(".app-main")).toBeVisible();

      // And it now appears in the remotes list.
      await page.goto("/#/remotes");
      await expect(page.getByText("workers-prod").first()).toBeVisible();
    },
  },
];

for (const row of TRANSPORTS) {
  test(`${row.transport} connector: the Add remote Sheet walks the ${row.steps}-step ${row.transport} flow`, async ({
    page,
  }) => {
    await page.goto("/#/remotes");
    await expect(page.locator(".app-main")).toBeVisible();

    // Scoped to the screen: the navigator's Elsewhere group grew its own
    // "Add remote" row (ElsewhereBody.tsx), so a page-wide role query is
    // ambiguous. Both entry points are intended; only one is under test here.
    await page.getByRole("main").getByRole("button", { name: /Add remote/i }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/modal-right/);
    // Before a card is picked the step list defaults to the SSH (5-step)
    // shape, so the counter always opens at "step 1 / 5" regardless of the
    // row's own transport; it only narrows to row.steps once row.card is
    // selected below.
    await expect(sheet.getByText(/step 1 \/ 5/)).toBeVisible();

    // Step 1: pick the connector card, then Next.
    await sheet.getByText(row.card, { exact: true }).first().click();
    await sheet.getByRole("button", { name: /^Next$/ }).click();

    await row.flow(sheet, page);
  });
}
