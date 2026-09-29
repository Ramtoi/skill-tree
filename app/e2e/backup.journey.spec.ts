import { test, expect, type Locator, type Page } from "./fixtures";

/**
 * The restore ConfirmDialog gates its confirm button on having read to the end
 * of the consequence list. Whether that list overflows at all depends on layout
 * that settles asynchronously (webfont metrics, the plan arriving after mount),
 * so asserting "enabled" without addressing the gate is a race. Scroll the body
 * to the end first: the gate is then deterministically satisfied and the
 * assertion still proves what it means to — that the OTHER gates are met.
 */
async function readToEnd(dialog: Locator) {
  await dialog.locator(".modal-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(dialog.getByTestId("confirm-scroll-gate")).toHaveCount(0);
}

/**
 * Once a backup works, restore is maintenance and lives behind a disclosure —
 * so every restore journey opens it first. That the section is exactly one
 * click from the configured screen is itself part of the contract.
 */
async function openRestore(page: Page) {
  // Every caller navigates to an already-configured backup state (a scene
  // flag or the default mock), where `setupComplete` is true and the
  // disclosure always renders (BackupScreen.tsx).
  const toggle = page.getByTestId("backup-restore-disclosure");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("restore-danger-zone")).toBeVisible();
}

// Backup & restore journey (backup-and-restore §9). Runs against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude,
// ~/.skill-hub, or any real git remote.

test("backup: status → PAT login → back up now → restore preview shows consequences", async ({
  page,
}) => {
  await page.goto("/#/backup");
  await expect(page.getByTestId("backup-screen")).toBeVisible();

  // ── Health leads: a configured, in-sync repo reports its identity honestly ──
  await expect(page.getByTestId("backup-health")).toBeVisible();
  await expect(page.getByText("git@github.com:me/skill-tree-backup.git")).toBeVisible();
  await expect(page.getByText("snapshot from moon-base")).toBeVisible();
  await expect(page.getByText("in sync with remote").first()).toBeVisible();

  // ── Credential management is maintenance: collapsed until asked for ──
  await expect(page.getByTestId("auth-rung-ssh")).toHaveCount(0);
  await page.getByTestId("backup-credential-disclosure").click();

  // ── Auth ladder: every rung present, the push rung marked ──
  await expect(page.getByTestId("auth-rung-ssh")).toBeVisible();
  await expect(page.getByTestId("auth-rung-gh")).toBeVisible();
  await expect(page.getByTestId("auth-rung-pat")).toBeVisible();
  await expect(page.getByText("used for push")).toBeVisible();

  // ── PAT login: masked field, and the token must not survive submission ──
  await page.getByTestId("open-pat-form").click();
  const patField = page.locator("#pat-input");
  await expect(patField).toHaveAttribute("type", "password");

  const TOKEN = "github_pat_11EXAMPLE_notarealtoken";
  await patField.fill(TOKEN);
  await page.getByRole("button", { name: "Store token" }).click();

  await expect(page.getByTestId("pat-form")).toBeHidden();
  // The token appears nowhere in the rendered document.
  await expect(page.locator("body")).not.toContainText(TOKEN);
  await expect(page.locator("body")).not.toContainText("github_pat_11EXAMPLE");

  // ── Back up now: one-way action, reports its result ──
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByTestId("backup-result")).toContainText("pushed to origin/main");

  // ── Restore: preview is a dry run and must disclose the consequences ──
  await openRestore(page);
  await page.locator("#restore-source").fill("git@github.com:me/skill-tree-backup.git");
  await page.getByTestId("restore-preview-btn").click();

  const consequences = page.getByTestId("restore-consequences");
  await expect(consequences).toBeVisible();

  // What this machine LOSES leads the disclosure.
  await expect(page.getByTestId("restore-lost")).toContainText("scratch-app");
  // Hook commands are shown VERBATIM — that is what consent is given to.
  await expect(page.getByTestId("restore-executable")).toContainText(
    "python3 ~/.skill-hub/hooks/lsp_report.py --advisory",
  );
  // A hook whose script is gone is flagged rather than quietly installed.
  await expect(page.getByTestId("restore-executable")).toContainText("script missing");
  // Restored code hub loads ITSELF gets its own group — a Python module this
  // app imports is a different consent from a command it hands to an agent.
  const codeDirs = page.getByTestId("restore-code-dirs");
  await expect(codeDirs).toContainText("hermes");
  await expect(codeDirs).toContainText("overwrites local code");
  // A byte-identical dir installs nothing and must not pad the consent list.
  await expect(codeDirs).not.toContainText("moon-base");
  // Writes landing outside the data home are named individually.
  await expect(page.getByTestId("restore-out-of-home")).toContainText("~/.claude/agents/reviewer.md");
  // Projects that cannot resolve here are called out, not silently kept.
  await expect(page.getByTestId("restore-unresolved")).toContainText("moon-base");
  // What SURVIVES is disclosed too — last, so it never softens the losses.
  await expect(page.getByTestId("restore-retained")).toContainText("3");
  await expect(page.getByTestId("restore-audit-note")).toContainText("append-only ledgers");

  // ── Confirm gate: destructive apply is double-gated ──
  await page.getByTestId("restore-apply-btn").click();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toBeVisible();

  const confirmBtn = dialog.getByRole("button", { name: "Restore" });
  await expect(confirmBtn).toBeDisabled();

  // Consent to the executable state…
  await dialog.getByLabel("Accept executable state").check();
  await expect(confirmBtn).toBeDisabled(); // …still gated on the typed confirmation
  await dialog.locator("#restore-confirm-input").fill("RESTORE");
  await readToEnd(dialog);
  await expect(confirmBtn).toBeEnabled();
});

/**
 * The chip must survive the narrow-width status-bar cull.
 *
 * `.app-status` drops its title-carrying segments at ≤680px to protect the
 * right-hand cluster; the backup chip carries a title too, so it was silently
 * culled — a fail-OPEN backup that is also fail-SILENT below a window width.
 * This runs with real CSS at the visual harness's narrowest frame (520px).
 */
test("backup: the StatusBar chip survives at 520px", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/?backupStale=1#/");

  const chip = page.getByTestId("backup-chip");
  await expect(chip).toBeVisible();
  await expect.soft(chip).toHaveAttribute("data-backup-state", "danger");
  await expect(chip).toContainText("backup failing");

  // Visible, not merely present-and-clipped to nothing.
  const box = await chip.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(40);

  // The status bar itself must not have been pushed into a horizontal scroll to
  // make room — the chip is exempt from clipping, the low-signal segments go.
  const overflow = await page.evaluate(() => {
    const bar = document.querySelector(".app-status") as HTMLElement | null;
    return bar ? bar.scrollWidth - bar.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // Still routes.
  await chip.click();
  await expect(page.getByTestId("backup-screen")).toBeVisible();
  // The gh-account mismatch recorded in this scene is surfaced too — the
  // credential section opens ITSELF when there is something wrong in it, so a
  // real problem is never hidden behind progressive disclosure.
  await expect.soft(page.getByTestId("gh-account-mismatch")).toBeVisible();
});

test("backup: pending reconcile blocks pushes until acknowledged, then clears", async ({
  page,
}) => {
  await page.goto("/?backupPending=1#/backup");

  const banner = page.getByTestId("pending-reconcile-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("commit but not");
  await expect(page.getByTestId("backup-chip")).toHaveAttribute("data-backup-state", "warn");

  // Acknowledging must actually acknowledge: the mock only clears
  // `pending_reconcile` when `--acknowledge-restore` reaches the CLI, so a
  // button that merely ran a backup would leave both the banner and the chip up.
  await page.getByTestId("acknowledge-restore").click();

  await expect(banner).toBeHidden();
  await expect(page.getByTestId("backup-chip")).toHaveCount(0);
  await expect(page.getByTestId("backup-result")).toBeVisible();
});

/**
 * The layout half of the two blockers, against real CSS.
 *
 * The error card used to float 80px down the page inside its own centred
 * 540px frame — a ~150px void above it that only exists with the stylesheet
 * applied, so it can only be pinned here. The other reasons this test used to
 * carry (never painting green, no repeated failure count) now live in
 * BackupScreen.test.tsx and BackupJourney.test.tsx, which reach the same
 * component without the layout engine this geometry needs.
 */
test("backup: a failing backup never paints itself green", async ({ page }) => {
  await page.goto("/?backupStale=1#/backup");
  await expect(page.getByTestId("backup-health")).toBeVisible();

  // The error card owns the single primary and sits at the TOP of the flow.
  const card = page.locator(".error-card");
  await expect(card).toBeVisible();

  const cardBox = (await card.boundingBox())!;
  const healthBox = (await page.getByTestId("backup-health").boundingBox())!;
  expect(cardBox.y).toBeLessThan(healthBox.y);
  const header = (await page.locator(".main-header").boundingBox())!;
  expect(cardBox.y - (header.y + header.height)).toBeLessThan(60);
});

/**
 * At 480px the header strips every button label, so the screen's one primary
 * collapsed to a bare ⚡ glyph — while the card directly beneath it read "then
 * use **Acknowledge & back up** above", naming a control that no longer carried
 * a name. Width-dependent, so this is the only place it can be pinned.
 */
test("backup: the primary action stays labelled and reachable at 520px", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/?backupPending=1#/backup");
  await expect(page.getByTestId("pending-reconcile-banner")).toBeVisible();

  const compact = page.getByTestId("acknowledge-restore-compact");
  await expect(compact).toBeVisible();
  await expect(compact).toContainText("Acknowledge & back up");

  // Exactly ONE control offers this action — the header's mute glyph stands
  // down rather than sitting beside the labelled twin as a nameless duplicate.
  await expect(page.getByTestId("acknowledge-restore")).toHaveCount(0);
  await expect(page.locator(".btn-primary")).toHaveCount(1);

  // Full-width, so it reads as the screen's action rather than a stray chip.
  const box = (await compact.boundingBox())!;
  expect(box.width).toBeGreaterThan(300);

  // Widening hands the action back to the header, live, without a reload — the
  // twin must not linger as a second copy once the header can carry a word.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("acknowledge-restore")).toBeVisible();
  await expect(page.getByTestId("acknowledge-restore-compact")).toHaveCount(0);

  // And the compact one is the real action, not a decorative stand-in: the mock
  // only clears `pending_reconcile` for a run that carried --acknowledge-restore.
  await page.setViewportSize({ width: 520, height: 900 });
  await expect(compact).toBeVisible();
  await compact.click();
  await expect(page.getByTestId("pending-reconcile-banner")).toBeHidden();
});

/**
 * `pending_reconcile` is transitional, not a severity — amber in this system
 * means provenance/risk only. The same one state used to render in two colour
 * channels at once: amber callout + amber StatusBar string, next to a neutral
 * hollow-ring header chip and Cloud-copy row. The rings were right.
 */
test("backup: a paused push is neutral, not amber", async ({ page }) => {
  await page.goto("/?backupPending=1#/backup");
  const banner = page.getByTestId("pending-reconcile-banner");
  await expect(banner).toBeVisible();

  const amber = await page.evaluate(() => {
    const read = (sel: string, prop: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el).getPropertyValue(prop) : "";
    };
    const ambient = getComputedStyle(document.documentElement)
      .getPropertyValue("--amber")
      .trim();
    return {
      ambient,
      bannerBorder: read(".backup-banner", "border-top-color"),
      bannerHead: read(".backup-banner-head", "color"),
      chip: read(".backup-chip", "color"),
    };
  });

  // Resolve --amber through the browser so this compares painted colours, not
  // the token spelling.
  const amberRgb = await page.evaluate((raw) => {
    const probe = document.createElement("span");
    probe.style.color = raw;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, amber.ambient);

  expect(amber.bannerBorder).not.toBe(amberRgb);
  expect(amber.bannerHead).not.toBe(amberRgb);
  expect(amber.chip).not.toBe(amberRgb);

  // The ⚠ glyph stays — the emphasis moves to weight, it does not disappear.
  await expect(banner.locator("svg").first()).toBeVisible();

  // The ring instances (header chip + Cloud-copy row) were already correct —
  // `backupHealth` maps a paused push to the `unknown` freshness state — and
  // must stay that way.
  await expect(page.locator('.fresh-badge[data-state="unknown"]').first()).toBeVisible();
});

/**
 * Executable-state consent, against real layout.
 *
 * The dialog enumerates hook commands, the connector and MCP source this app
 * will IMPORT AND EXECUTE, and the files replaced outside the library — then
 * clipped that list mid-item at the scroll edge with `⚠ Restore` sitting live
 * underneath and the typed-RESTORE field itself below the fold. Approving what
 * you have not seen is not consent.
 *
 * Only reproducible with the stylesheet applied (jsdom reports every scroll
 * metric as zero), so it is pinned here.
 */
test("restore: the confirm cannot be given before the list has been read", async ({ page }) => {
  await page.goto("/#/backup");
  await openRestore(page);
  await page.fill("#restore-source", "git@github.com:me/skill-tree-backup.git");
  await page.getByTestId("restore-preview-btn").click();
  await page.getByTestId("restore-apply-btn").click();

  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toBeVisible();
  const body = dialog.locator(".modal-body");

  // Precondition: this plan genuinely overflows. Without that the gate is a
  // no-op and the rest of the test would pass for the wrong reason.
  const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 2);
  expect(overflows).toBe(true);

  const confirm = page.getByRole("button", { name: /Restore$/ });
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("confirm-scroll-gate")).toBeVisible();

  // Clicking it while gated does nothing at all.
  await confirm.click({ force: true });
  await expect(dialog).toBeVisible();

  // Reading to the end releases the SCROLL gate — and only that one. The typed
  // word and the executable-state tick are still owed, so the button stays
  // inert; the gates are independent, not a chain where the last one wins.
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByTestId("confirm-scroll-gate")).toHaveCount(0);
  await expect(confirm).toBeDisabled();

  // Reaching the end means reaching the CONSENT: the typed-RESTORE field and
  // the executable-state tick both used to sit below the fold under a live
  // confirm. They are what the bottom of this dialog actually holds.
  await expect(page.locator("#restore-confirm-input")).toBeInViewport();
  await expect(dialog.getByLabel(/Accept executable state/i)).toBeInViewport();

  // …and the highest-stakes group is inside the dialog, not only on the page
  // behind it — it was the group the scroll edge used to cut in half.
  await expect(dialog.getByTestId("restore-code-dirs")).toHaveCount(1);
  await expect(dialog.getByTestId("restore-out-of-home")).toHaveCount(1);
});

/**
 * The reported first-use failure, end to end.
 *
 * A user with working credentials opened /backup and found three dense status
 * cards, a greyed "create repo" line, and no way to begin. The screen now opens
 * on a numbered journey whose live stage is the one thing left to do.
 */
/**
 * The first screen a new user ever sees was ~65% empty black: content pinned to
 * the top-left of a 1250px viewport with everything below y≈440 void — the
 * round-1 "floating in a dead void" complaint recurring at the front door. And
 * `Start setup →` outranked `Choose a snapshot →` 7.1:1 to 4.6:1, quietly
 * answering an either/or the app has no way to answer.
 */
test("bootstrap: the fork is centred and its two options read equally", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?bootstrap=1#/");
  const choose = page.getByTestId("bootstrap-choose");
  await expect(choose).toBeVisible();

  // Vertically centred: the void above and below the content match, rather than
  // all of it pooling at the bottom.
  const frame = (await choose.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, vh: window.innerHeight };
  }))!;
  const above = frame.top;
  const below = frame.vh - frame.bottom;
  expect(Math.abs(above - below)).toBeLessThan(80);
  // …and it does not simply fill the screen instead — it is a capped card.
  expect(await choose.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(720);

  // Equal link weight: the violet border alone marks the default.
  const ctas = await page.evaluate(() => {
    const read = (id: string) => {
      const card = document.querySelector(`[data-testid="${id}"]`)!;
      const cta = card.lastElementChild as HTMLElement;
      return getComputedStyle(cta).color;
    };
    return { fresh: read("choose-fresh"), restore: read("choose-restore") };
  });
  expect(ctas.fresh).toBe(ctas.restore);
});

test("backup: a fresh machine is walked through credential → repo → first snapshot", async ({
  page,
}) => {
  await page.goto("/?backupUnconfigured=1#/backup");
  await expect(page.getByTestId("backup-journey")).toBeVisible();

  // The credential is already satisfied, so the LIVE stage is the repository —
  // and it is a real field with a real primary, not a status row.
  await expect(page.getByTestId("backup-stage-credential")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("backup-stage-repository")).toHaveAttribute(
    "data-state",
    "current",
  );
  await expect(page.getByTestId("backup-repo-input")).toBeVisible();

  // Exactly one violet primary exists at a time.
  await expect(page.locator("button.btn-primary")).toHaveCount(1);

  await page.getByTestId("backup-repo-input").fill("me/skill-tree-backup");
  await page.getByTestId("backup-init").click();

  // Configuring does NOT end the journey — the third stage becomes live, and
  // the single primary moves onto it.
  await expect(page.getByTestId("backup-stage-first-backup")).toHaveAttribute(
    "data-state",
    "current",
  );
  await expect(page.getByTestId("backup-first-run")).toBeVisible();
  await expect(page.locator("button.btn-primary")).toHaveCount(1);

  await page.getByTestId("backup-first-run").click();

  // Success says what was captured, then the screen becomes the health view.
  await expect(page.getByTestId("backup-health")).toBeVisible();
  await expect(page.getByTestId("backup-journey")).toHaveCount(0);
});

test("bootstrap: preview keeps losses visible and lets the user expand command details", async ({ page }) => {
  await page.goto("/?bootstrap=1#/");

  // The first thing shown is a decision, not an import scan.
  await expect(page.getByTestId("bootstrap-choose")).toBeVisible();
  await expect(page.getByText("Importable skills")).toBeHidden();

  await page.getByTestId("choose-restore").click();
  await expect(page.getByTestId("bootstrap-restore-step")).toBeVisible();
  await expect(page.getByText("Importable skills")).toBeHidden();

  await page.locator("#bootstrap-restore-source").fill("https://github.com/me/skill-tree-backup.git");
  await page.getByTestId("bootstrap-restore-preview").click();
  await expect(page.getByTestId("restore-lost").getByText("scratch-app")).toBeVisible();

  // The safe mode is the default — `replace` is a data-loss event for anyone
  // whose machine isn't actually empty.
  const modes = page.getByTestId("bootstrap-restore-mode");
  await expect.soft(modes.getByRole("radio").first()).toBeChecked();

  // Apply stays gated until the executable state is explicitly accepted…
  await expect.soft(page.getByTestId("bootstrap-restore-apply")).toBeDisabled();
  await page.getByLabel("Accept executable state").check();

  // …and, because this plan lists losses, until the word is typed as well.
  await expect.soft(page.getByTestId("bootstrap-restore-typed-gate")).toBeVisible();
  await expect.soft(page.getByTestId("bootstrap-restore-apply")).toBeDisabled();
  await page.locator("#bootstrap-restore-confirm-input").fill("RESTORE");
  await expect.soft(page.getByTestId("bootstrap-restore-apply")).toBeEnabled();

  const commands = page.getByTestId("restore-executable");
  await expect(commands.locator("summary")).toBeVisible();
  await expect(commands.locator("ul")).toBeHidden();
  await commands.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(commands.locator("ul")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(commands.locator("ul")).toBeHidden();
  await expect(page.getByLabel("Accept executable state")).toBeVisible();
});
