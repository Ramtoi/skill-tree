import { test, expect } from "./fixtures";

// Failed-sync surface. The `syncFails` query flag makes the mocked `hub_cmd`
// return a REAL `hub sync` validation failure: ANSI-coloured advisory warnings
// on stdout, the actual error block on stderr, non-zero exit.
//
// The defect this pins: the failure card used to headline the first STDOUT line
// (a warning) with its ANSI escapes intact, offer TWO controls for the same log
// ("Hide log" + "collapse log"), and open onto a log holding nothing but the
// app's own "+0.0s writing .claude / .agents" breadcrumb.
//
// Mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts).
// NEVER touches ~/.claude.

const ESC = String.fromCharCode(27);

test("failed sync: card headlines the real error and opens one log with the real output", async ({
  page,
}) => {
  await page.goto("/?syncFails=1#/project/example-app");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.getByRole("button", { name: "Sync", exact: true }).click();

  const card = page.locator(".lds-proc[data-status='error']");
  await expect(card).toBeVisible();

  // ── Headline: the stderr ERROR, not the stdout warning, and no raw escapes.
  const body = card.locator(".lds-proc-body");
  await expect(body).toContainText("Skill registry validation failed:");
  await expect(body).toContainText("qa-2");
  await expect(body).not.toContainText("design-an-interface");
  expect(await body.textContent()).not.toContain(ESC);
  expect(await body.textContent()).not.toContain("[33m");

  // ── ONE log affordance, before and after opening it.
  const logControls = card.getByRole("button", { name: /log/i });
  await expect(logControls).toHaveCount(1);
  await expect(logControls.first()).toContainText("see log");
  await logControls.first().click();
  await expect(card.getByRole("button", { name: /log/i })).toHaveCount(1);
  await expect(card.getByRole("button", { name: /collapse log/i })).toBeVisible();

  // ── Log: the real hub output — both streams, in order, ANSI-stripped —
  //    alongside (not instead of) the client-side phase breadcrumb.
  const log = card.locator(".lds-proc-log");
  await expect(log).toBeVisible();
  await expect(log).toContainText("writing .claude / .agents");
  await expect(log).toContainText("design-an-interface: missing SKILL.md");
  await expect(log).toContainText("Skill registry validation failed:");
  await expect(log).toContainText("Fix the duplicate/mismatched skill definitions");
  expect(await log.textContent()).not.toContain(ESC);

  // Breadcrumbs keep their elapsed stamp; command output (one buffer at exit)
  // is rendered without a fabricated per-line time.
  await expect(log.locator(".lds-proc-log-line[data-source='app']")).toHaveCount(1);
  const cliLines = log.locator(".lds-proc-log-line[data-source='cli']");
  expect(await cliLines.count()).toBeGreaterThan(2);
  await expect(cliLines.first().locator(".lds-proc-log-ts")).toHaveText("");

  // Retry stays a real action and no longer drags a second log control with it.
  await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
});

// Cut: syncFailureSurface.test.tsx:244 "headlines the ✗ tick of a
// stdout-only failure (hub.py's dominant shape)" holds this. The
// `syncFails=stdout` scene flag's fidelity row is
// `sceneFidelity.test.ts:101`.

test("equip whose auto-sync fails does not headline its own success tick", async ({
  page,
}) => {
  // `cmd_enable` prints "✓ enabled 'x' for 'y'." BEFORE calling `_auto_sync()`
  // (hub.py 7292 → 7294), so a failing auto-sync leaves stdout OPENING with a
  // green success line — with stderr empty. The old first-stdout-line rule
  // reported that success line as the error.
  await page.goto("/?enableFails=1#/project/moon-base");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  const list = page.getByRole("list", { name: "Available skills" });
  await list.locator(".avail-row-wrap").first().focus();
  await page.keyboard.press("e");

  const toast = page.locator(".toast.toast-error").first();
  await expect(toast).toBeVisible();
  await expect(toast.locator(".toast-title")).toHaveText("Couldn't equip skill");
  const bodyText = (await toast.locator(".toast-body").textContent()) ?? "";
  expect(bodyText).toContain("no such project: 'ghost-app'");
  expect(bodyText).not.toContain("✓");
  expect(bodyText).not.toContain("enabled 'design-an-interface'");
  expect(bodyText).not.toContain(ESC);
  // The class name of the thrown error is never shown to the user.
  expect(bodyText).not.toContain("HubCommandError");
});

// Cut: syncFailureSurface.test.tsx:265 "keeps a successful sync quiet — no
// log affordance on the success card" holds this.
