import { test, expect } from "@playwright/test";

// Backup & restore journey (backup-and-restore §9). Runs against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude,
// ~/.skill-hub, or any real git remote.

test("backup: status → PAT login → back up now → restore preview shows consequences", async ({
  page,
}) => {
  await page.goto("/#/backup");
  await expect(page.getByTestId("backup-screen")).toBeVisible();

  // ── Status: a configured, in-sync repo reports its identity honestly ──
  await expect(page.getByText("git@github.com:me/skill-hub-backup.git")).toBeVisible();
  await expect(page.getByText("snapshot from moon-base")).toBeVisible();
  await expect(page.getByText("in sync with remote").first()).toBeVisible();

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
  await expect(page.getByTestId("restore-danger-zone")).toBeVisible();
  await page.locator("#restore-source").fill("git@github.com:me/skill-hub-backup.git");
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
  await expect(confirmBtn).toBeEnabled();
});

test("restore: an unverified signing key is a consent gate, a bad digest is a refusal", async ({
  page,
}) => {
  // ── TOFU: a signer this machine has never seen (restore.py `unverified-new-key`) ──
  await page.goto("/?restoreUnverified=1#/backup");
  await page.locator("#restore-source").fill("git@github.com:me/skill-hub-backup.git");
  await page.getByTestId("restore-preview-btn").click();
  await expect(page.getByTestId("restore-consequences")).toBeVisible();

  // The CLI's own sentence is shown, key id and all — not a re-worded summary.
  const banner = page.getByTestId("restore-unverified");
  await expect(banner).toHaveAttribute("data-trust-state", "unverified-new-key");
  await expect(banner).toContainText("SHA256:9999ffff8888eeee");

  await page.getByTestId("restore-apply-btn").click();
  const dialog = page.locator(".confirm-dialog");
  const confirmBtn = dialog.getByRole("button", { name: "Restore", exact: true });

  // Every OTHER gate satisfied — the unpinned key alone still holds it shut.
  await dialog.getByLabel("Accept executable state").check();
  await dialog.locator("#restore-confirm-input").fill("RESTORE");
  await expect(confirmBtn).toBeDisabled();
  await expect(page.getByTestId("restore-block-reason")).toContainText("signing key");

  await dialog.getByLabel("Trust and pin this signing key").check();
  await expect(confirmBtn).toBeEnabled();

  // ── Hard refusal: a tampered tree (fatal ⇒ truncated plan, no consent path) ──
  await page.goto("/?restoreTampered=1#/backup");
  await page.locator("#restore-source").fill("git@github.com:me/skill-hub-backup.git");
  await page.getByTestId("restore-preview-btn").click();
  await expect(page.getByTestId("restore-consequences")).toBeVisible();

  await expect(page.getByTestId("restore-integrity-failed")).toBeVisible();
  // No consent path exists for a fatal plan — the dialog must not even open.
  await expect(page.getByTestId("restore-apply-btn")).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("restore-apply-btn").click({ force: true });
  await expect(page.getByLabel("Trust and pin this signing key")).toHaveCount(0);
});

test("backup: a stale backup raises a StatusBar chip that routes to the screen", async ({
  page,
}) => {
  await page.goto("/?backupStale=1#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  const chip = page.getByTestId("backup-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-backup-state", "danger");
  await expect(chip).toContainText("backup stale");

  await chip.click();
  await expect(page.getByTestId("backup-screen")).toBeVisible();
  // The gh-account mismatch recorded in this scene is surfaced too.
  await expect(page.getByTestId("gh-account-mismatch")).toBeVisible();
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
  await expect(chip).toContainText("backup stale");

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

test("restore: editing the source after a preview revokes the plan and its consent", async ({
  page,
}) => {
  await page.goto("/#/backup");

  const source = page.locator("#restore-source");
  await source.fill("git@github.com:me/skill-hub-backup.git");
  await page.getByTestId("restore-preview-btn").click();
  await expect(page.getByTestId("restore-consequences")).toBeVisible();

  // Editing what would be restored invalidates the consequences that were
  // disclosed — there must be nothing left to apply until it is re-previewed.
  await source.fill("git@github.com:me/some-other-snapshot.git");
  await expect(page.getByTestId("restore-consequences")).toHaveCount(0);
  await expect(page.getByTestId("restore-apply-btn")).toHaveCount(0);

  // Same for the mode.
  await page.getByTestId("restore-preview-btn").click();
  await expect(page.getByTestId("restore-apply-btn")).toBeVisible();
  await page.locator("#restore-mode").selectOption("replace");
  await expect(page.getByTestId("restore-apply-btn")).toHaveCount(0);

  // Re-previewing shows the NEW request, with the consent gates re-armed.
  await page.getByTestId("restore-preview-btn").click();
  await expect(page.getByTestId("restore-consequences")).toContainText("some-other-snapshot");
  await page.getByTestId("restore-apply-btn").click();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toContainText("some-other-snapshot");
  await expect(dialog.getByLabel("Accept executable state")).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeDisabled();
});

test("bootstrap: the wizard opens on a choice and the restore branch skips import", async ({
  page,
}) => {
  await page.goto("/?bootstrap=1#/");

  // The first thing shown is a decision, not an import scan.
  await expect(page.getByTestId("bootstrap-choose")).toBeVisible();
  await expect(page.getByText("Importable skills")).toBeHidden();

  await page.getByTestId("choose-restore").click();
  await expect(page.getByTestId("bootstrap-restore-step")).toBeVisible();
  await expect(page.getByText("Importable skills")).toBeHidden();
  await expect(page.getByText(/Restoring skips the import step/)).toBeVisible();

  // Preview discloses before anything is written.
  await page.locator("#bootstrap-restore-source").fill("git@github.com:me/skill-hub-backup.git");
  await page.getByTestId("bootstrap-restore-preview").click();
  await expect(page.getByTestId("restore-consequences")).toBeVisible();

  // The safe mode is the default — `replace` is a data-loss event for anyone
  // whose machine isn't actually empty.
  await expect(page.locator("#bootstrap-restore-mode")).toHaveValue("merge");

  // Apply stays gated until the executable state is explicitly accepted…
  await expect(page.getByTestId("bootstrap-restore-apply")).toBeDisabled();
  await page.getByLabel("Accept executable state").check();

  // …and, because this plan lists losses, until the word is typed as well.
  await expect(page.getByTestId("bootstrap-restore-typed-gate")).toBeVisible();
  await expect(page.getByTestId("bootstrap-restore-apply")).toBeDisabled();
  await page.locator("#bootstrap-restore-confirm-input").fill("RESTORE");
  await expect(page.getByTestId("bootstrap-restore-apply")).toBeEnabled();
});
