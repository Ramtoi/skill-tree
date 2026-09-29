import { test, expect } from "./fixtures";

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

  // (a) Per-control pending feedback. EquipPicker REPLACES the row's toggle
  //     with a labelled spinner for the duration of its own mutation, so the
  //     control cannot be double-fired at all — a stronger guarantee than the
  //     disabled-in-place checkbox this once asserted. Assert it BEFORE any
  //     checkbox state: the checkbox does not exist while the row is pending,
  //     so a `toBeChecked()` here would simply wait out the whole op and then
  //     read the settled row.
  await expect(page.getByRole("status", { name: "Updating example-app" })).toBeVisible();

  // (d) The global StatusBar busy indicator appears during the op.
  await expect(page.locator(".ipc-busy")).toBeVisible();

  // (b) The UI is NOT frozen while the command runs: Escape dismisses the picker
  //     and the command palette opens on keyboard input, all mid-op.
  await page.keyboard.press("Escape"); // closes the equip picker
  await page.keyboard.press("ControlOrMeta+k"); // opens the palette
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".ipc-busy")).toBeVisible(); // op still pending
  await page.keyboard.press("Escape"); // close palette; equip keeps running

  // (c) The latency knob also delays the before/after footprint reads and
  // post-write refresh. Allow that full chain to finish before expecting its toast.
  await expect(page.locator(".toast-title")).toContainText(
    "Equipped deep-research on example-app",
    { timeout: DELAY * 10 },
  );

  // (d, cont.) The busy indicator clears after all in-flight work settles.
  await expect(page.locator(".ipc-busy")).toBeHidden();

  // The equip actually landed: the picker never actually dismissed while
  // the op was pending (Escape is a no-op on the busy control, same as
  // the Global-switch busy case elsewhere), so its checkbox is still on
  // screen — read its settled state directly (equip-connections.journey.
  // spec.ts's cut "row picker toggles a project on").
  await expect(box).toBeChecked();
});

test("bundle removal stays visible while pending, then removes the chip and supports Undo", async ({ page }) => {
  await page.goto("/#/project/moon-base");
  const chip = page.locator(".ws-band-overview .bundle-chip", { hasText: "android" });
  await expect(chip).toBeVisible();
  await page.evaluate((ms) => {
    (window as unknown as { __IPC_DELAY_MS?: number }).__IPC_DELAY_MS = ms;
  }, DELAY);
  await chip.getByRole("button", { name: "Remove", exact: true }).click();
  await page.mouse.move(0, 0);
  const removing = chip.getByRole("button", { name: "Removing…", exact: true });
  await expect(removing).toBeVisible();
  await expect(removing).toHaveAttribute("aria-busy", "true");
  await expect(removing).toBeDisabled();
  await expect(removing).toHaveCSS("opacity", "1");
  await expect(chip).toHaveCount(0, { timeout: DELAY * 10 });
  const toast = page.locator(".toast", { hasText: "Removed android from moon-base" });
  await expect(toast).toBeVisible({ timeout: DELAY * 10 });
  await page.evaluate(() => {
    (window as unknown as { __IPC_DELAY_MS?: number }).__IPC_DELAY_MS = 0;
  });
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(chip).toBeVisible();
  await expect(chip.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
});
