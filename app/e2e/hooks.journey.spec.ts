import { test, expect, type Page } from "@playwright/test";

// ux-hooks-surface standing journeys (hooks-surface tasks 5.6), driven against
// the mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). The hook
// mock is STATEFUL: attach/detach/edit/set-settings mutate an in-memory store the
// list + show reads back, and every hook_* IPC call is recorded on
// `window.__hookCalls` so a journey can assert the mutation fired with the right
// args. NEVER touches ~/.claude.

/** Move DOM focus off any auto-focused input so window chords are live. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The recorded hook_* IPC calls (mock scaffolding). */
async function hookCalls(
  page: Page,
): Promise<Array<{ cmd: string; args?: Record<string, unknown> }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __hookCalls?: unknown[] }).__hookCalls as Array<{
        cmd: string;
        args?: Record<string, unknown>;
      }> ?? [],
  );
}

// ─── (a) Navigation: rail click AND the `g k` chord both land on /hooks ────────

test("hooks nav: rail item and g k chord both open the library", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();
  await page.locator('[title="Hooks"]').first().click();
  await expect(page).toHaveURL(/#\/hooks$/);
  await expect(page.locator(".hooks-list")).toBeVisible();

  // The chord fires from Sources (no auto-focused search there).
  await page.goto("/#/sources");
  await expect(page.locator(".app-main")).toBeVisible();
  await blur(page);
  await page.keyboard.press("g");
  await page.keyboard.press("k");
  await expect(page).toHaveURL(/#\/hooks$/);
});

// ─── (b) Library rows + built-in read-only editor fields ───────────────────────

test("library lists builtin + user; built-in command/event are read-only in the DOM", async ({
  page,
}) => {
  await page.goto("/#/hooks");
  await expect(page.locator(".hook-row")).toHaveCount(2);

  const lspRow = page.locator(".hook-row", { hasText: "lsp-report" });
  await expect(lspRow.locator(".hook-provenance")).toHaveText("builtin");
  await expect(
    page.locator(".hook-row", { hasText: "notify-on-stop" }).locator(".hook-provenance"),
  ).toHaveText("user");

  // Open the built-in — command + event are ACTUALLY read-only/disabled, not
  // merely rendered.
  await lspRow.click();
  await expect(page).toHaveURL(/#\/hook\/lsp-report$/);
  await expect(page.locator('textarea[aria-label="command"]')).toHaveJSProperty(
    "readOnly",
    true,
  );
  await expect(page.locator('select[aria-label="event"]')).toBeDisabled();
  // The built-in note explains WHY (honest affordance).
  await expect(page.locator(".hook-builtin-note")).toBeVisible();
});

// ─── (c) Edit a user hook's command + ⌘S save → ipc fires with expected args ───

test("user hook: edit command + ⌘S saves via ipc with the edited command", async ({
  page,
}) => {
  await page.goto("/#/hook/notify-on-stop");
  await expect(page.locator(".hook-editor")).toBeVisible();

  const cmd = page.locator('textarea[aria-label="command"]');
  await expect(cmd).toHaveValue("say done");
  await cmd.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" --loud");
  await expect(page.getByText("UNSAVED")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  const edit = (await hookCalls(page)).find(
    (c) => c.cmd === "hook_edit" && c.args?.name === "notify-on-stop",
  );
  expect(edit, "hook_edit should have fired via lib/ipc").toBeTruthy();
  expect(String(edit?.args?.command)).toContain("--loud");
});

// ─── (c2) Create a hook end-to-end: /hooks → /hook/new → form → library row ────

test("create a hook: the new definition lands in the library", async ({ page }) => {
  await page.goto("/#/hooks");
  await expect(page.locator(".hook-row")).toHaveCount(2);

  await page.getByRole("button", { name: "New hook" }).click();
  await expect(page).toHaveURL(/#\/hook\/new$/);

  await page.locator('input[aria-label="hook name"]').fill("lint-after-edit");
  await page.locator('textarea[aria-label="command"]').fill("npx eslint --fix");
  await page.locator('select[aria-label="event"]').selectOption("PreToolUse");
  await page.getByRole("checkbox", { name: "Bash", exact: true }).check();
  await expect(page.getByText("UNSAVED")).toBeVisible();

  await page.getByRole("button", { name: "Create hook" }).click();

  // The post-create redirect lands on the created hook's own editor route.
  await expect(page).toHaveURL(/#\/hook\/lint-after-edit$/);
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  const created = (await hookCalls(page)).find((c) => c.cmd === "hook_new");
  expect(created, "hook_new should have fired via lib/ipc").toBeTruthy();
  expect(created?.args?.name).toBe("lint-after-edit");
  expect(created?.args?.event).toBe("PreToolUse");
  expect(String(created?.args?.command)).toContain("eslint");
  expect(created?.args?.tools).toEqual(["Bash"]);

  // Going back to the library shows the new row — the list actually refreshed
  // after the mutation (the integration seam unit tests can't see).
  await page.locator(".header-back").click();
  await expect(page).toHaveURL(/#\/hooks$/);
  await expect(page.locator(".hook-row")).toHaveCount(3);
  const newRow = page.locator(".hook-row", { hasText: "lint-after-edit" });
  await expect(newRow.locator(".hook-provenance")).toHaveText("user");
  await expect(newRow.locator(".hook-event")).toHaveText("PreToolUse");
});

// ─── (c3) Delete a user hook: blast radius → confirm → library shrinks ─────────

test("delete a user hook: the confirm names its scopes and the library shrinks", async ({
  page,
}) => {
  await page.goto("/#/hook/notify-on-stop");
  await expect(page.locator(".hook-editor")).toBeVisible();

  await page.getByRole("button", { name: "Delete this hook" }).click();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toBeVisible();
  // Blast radius: notify-on-stop is attached to example-app in the seed store.
  await expect(dialog.locator(".hook-delete-scopes")).toContainText(
    "project: example-app",
  );
  // Nothing is destroyed until the user confirms.
  expect((await hookCalls(page)).some((c) => c.cmd === "hook_delete")).toBe(false);

  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  // Back to the library, one row lighter, with the built-in untouched.
  await expect(page).toHaveURL(/#\/hooks$/);
  await expect(page.locator(".hook-row")).toHaveCount(1);
  await expect(page.locator(".hook-row")).toContainText("lsp-report");

  const del = (await hookCalls(page)).find((c) => c.cmd === "hook_delete");
  expect(del?.args?.name).toBe("notify-on-stop");
  // `confirm: true` → the CLI's `--yes`; without it the delete is a dry run.
  expect(del?.args?.confirm).toBe(true);
});

// ─── (d) Palette Attach — a GLOBAL pick surfaces the machine-wide consequence ──

test("palette Attach hook: global scope surfaces the machine-wide consequence line", async ({
  page,
}) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".palette input");
  await expect(input).toBeVisible();
  await input.fill("Attach hook");
  await page.getByText("Attach hook…").click();
  await expect(page.locator(".palette-crumbs")).toContainText("Attach hook");

  // notify-on-stop is NOT global yet → picking Global gates on the consequence.
  await page.locator(".palette-item", { hasText: "notify-on-stop" }).first().click();
  await page.locator(".palette-item", { hasText: "Global" }).first().click();

  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "fire in all sessions of that harness on this machine",
  );
  await expect(dialog).toContainText("every directory");
  await dialog.getByRole("button", { name: "Attach globally" }).click();

  // Only after confirming does the attach run (undoable success toast).
  await expect(page.getByText(/Attached notify-on-stop/)).toBeVisible();
  const attach = (await hookCalls(page)).find(
    (c) => c.cmd === "hook_attach" && c.args?.global === true,
  );
  expect(attach, "global attach only fires after confirm").toBeTruthy();
});

// ─── (e) Palette Detach → undo toast, and Undo re-invokes attach ───────────────

test("palette Detach hook: undo toast appears and Undo re-attaches", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".palette input");
  await input.fill("Detach hook");
  await page.getByText("Detach hook…").click();

  // notify-on-stop is attached to example-app in the seed store.
  await page.locator(".palette-item", { hasText: "notify-on-stop" }).first().click();
  await page.locator(".palette-item", { hasText: "example-app" }).first().click();

  await expect(page.getByText(/Detached notify-on-stop/)).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await undo.click();

  // The undo re-invokes attach on the same project scope.
  await expect
    .poll(async () =>
      (await hookCalls(page)).some(
        (c) => c.cmd === "hook_attach" && c.args?.project === "example-app",
      ),
    )
    .toBe(true);
});

// ─── (f) lsp-report settings: per-language table + honest labels + set-settings ─

test("lsp-report settings: language table renders, mode labels are honest, edit invokes set-settings", async ({
  page,
}) => {
  await page.goto("/#/hook/lsp-report");
  await expect(page.locator(".hook-editor")).toBeVisible();

  const table = page.locator(".lsp-lang-table");
  await expect(table).toBeVisible();
  for (const lang of ["python", "go", "typescript", "rust"]) {
    await expect(
      table.locator("td.text-mono", { hasText: new RegExp(`^${lang}$`) }),
    ).toBeVisible();
  }

  // Honest mode labels — a PostToolUse report NEVER claims blocking prevents the
  // edit (the edit already happened).
  const pyMode = table.locator('select[aria-label="python mode"]');
  await expect(pyMode.locator("option")).toHaveText([
    "report",
    "interrupt (agent must address)",
  ]);
  await expect(table).not.toContainText(/prevent|blocked the edit/i);

  // Global defaults are read-only for a built-in → override at a project scope.
  await expect(table.getByRole("checkbox", { name: "python enabled" })).toBeDisabled();
  await page.locator('select[aria-label="settings scope"]').selectOption("example-app");

  const tsToggle = table.getByRole("checkbox", { name: "typescript enabled" });
  await expect(tsToggle).not.toBeChecked();
  await tsToggle.click();
  await table.locator('select[aria-label="typescript mode"]').selectOption("blocking");

  const setCalls = (await hookCalls(page)).filter(
    (c) => c.cmd === "hook_set_settings",
  );
  expect(setCalls.length).toBeGreaterThan(0);
  expect(
    setCalls.some((c) => {
      const s = c.args?.settings as
        | { languages?: Record<string, unknown> }
        | undefined;
      return c.args?.project === "example-app" && !!s?.languages?.typescript;
    }),
    "an lsp-report language edit scoped to the project",
  ).toBeTruthy();
});

// ─── (g) Capability-gated reach badges — all four verdict states ───────────────

test("reach badges honor the capability matrix (supported/feature_off/unsupported; not_installed omitted)", async ({
  page,
}) => {
  // ?hookCapsVaried=1 → claude-code supported, codex feature_off, opencode
  // unsupported, pi not_installed.
  await page.goto("/?hookCapsVaried=1#/hooks");
  const reach = page
    .locator(".hook-row", { hasText: "lsp-report" })
    .locator(".hook-row-reach");

  await expect(reach.locator('[aria-label="Claude Code: supported"]')).toBeVisible();
  await expect(reach.locator('[aria-label="Codex: feature_off"]')).toBeVisible();
  await expect(reach.locator('[aria-label="opencode: unsupported"]')).toBeVisible();
  // not_installed is omitted entirely — no false reach claim for pi.
  await expect(reach.locator('[aria-label*="Pi"]')).toHaveCount(0);

  // The neutral verdicts expose their reason via the tooltip (title).
  await expect(reach.locator('[aria-label="Codex: feature_off"]')).toHaveAttribute(
    "title",
    /hooks feature is off/,
  );
  await expect(reach.locator('[aria-label="opencode: unsupported"]')).toHaveAttribute(
    "title",
    /off by default/,
  );

  // The editor's per-event reach mirrors the same matrix.
  await page.goto("/?hookCapsVaried=1#/hook/lsp-report");
  const evReach = page.locator(".hook-event-reach");
  await expect(evReach.locator('[aria-label="Claude Code: supported"]')).toBeVisible();
  await expect(evReach.locator('[aria-label="Codex: feature_off"]')).toBeVisible();
});

// ─── (h) Project hooks card reflects attach state honestly ─────────────────────

test("project hooks card reflects attach state honestly (no false 'it's working' claim)", async ({
  page,
}) => {
  await page.goto("/?hookCapsVaried=1#/project/moon-base");
  const card = page.locator(".project-hooks-card");
  await expect(card).toBeVisible();

  // notify-on-stop is attached to example-app, NOT moon-base → its toggle reads
  // OFF here; the card does not claim it's active on this project.
  await expect(card.getByRole("checkbox", { name: /notify-on-stop/ })).not.toBeChecked();

  // lsp-report is attached globally → the honest "global" tag shows.
  await expect(
    card.locator(".project-hook-row", { hasText: "lsp-report" }).getByText("global"),
  ).toBeVisible();

  // Reach/unreachable honesty lives on /hooks — the card links there rather than
  // asserting the hook "works" on an unsupported harness.
  await expect(card.getByRole("button", { name: /Manage hooks/ })).toBeVisible();
});
