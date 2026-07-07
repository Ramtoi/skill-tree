import { test, expect } from "@playwright/test";

// ui-responsiveness M4/M5 standing journey. Drives the real frontend against the
// mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts) with the IPC
// latency knob turned on AFTER boot, so an equip click stays pending long enough
// to observe: (a) per-control pending feedback, (b) the UI staying interactive
// during the op, (c) a completion toast, (d) the StatusBar busy indicator
// appearing during and clearing after. NEVER touches ~/.claude.

const DELAY = 1500;

test("an in-flight equip shows pending feedback, stays interactive, and settles", async ({
  page,
}) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  // Boot happens at zero latency; only now do we slow every command down so the
  // pending states are observable. `ipcDelayMs()` reads this on each invoke.
  await page.evaluate((ms) => {
    (window as unknown as { __IPC_DELAY_MS?: number }).__IPC_DELAY_MS = ms;
  }, DELAY);

  // deep-research is off on example-app in the mock registry — open its picker.
  const row = page.locator(".resource-row", { hasText: "deep-research" }).first();
  await row.hover();
  await row.getByTitle("Equip on…").click();

  const box = page.getByRole("checkbox", {
    name: "Equip deep-research example-app",
  });
  await expect(box).not.toBeChecked();
  await box.click();

  // (a) Per-control pending feedback: the toggle flips on optimistically AND
  //     disables while its own mutation is in flight.
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();

  // (d) The global StatusBar busy indicator appears during the op.
  await expect(page.locator(".ipc-busy")).toBeVisible();

  // (b) The UI is NOT frozen while the command runs: Escape dismisses the picker
  //     and the command palette opens on keyboard input, all mid-op.
  await page.keyboard.press("Escape"); // closes the equip picker
  await page.keyboard.press("ControlOrMeta+k"); // opens the palette
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".ipc-busy")).toBeVisible(); // op still pending
  await page.keyboard.press("Escape"); // close palette; equip keeps running

  // (c) Completion feedback: the success toast appears once the command settles.
  await expect(page.locator(".toast-title")).toContainText(
    "Equipped deep-research on example-app",
  );

  // (d, cont.) The busy indicator clears after all in-flight work settles.
  await expect(page.locator(".ipc-busy")).toBeHidden();
});
