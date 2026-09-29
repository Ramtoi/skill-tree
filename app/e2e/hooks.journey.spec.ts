import { test, expect, type Page } from "./fixtures";
import { gotoReady } from "./helpers";

/** How many hooks `seedHooks()` plants in the mock (src/mocks/tauriCore.ts).
 *  One name, so a new seeded hook is a one-line update instead of three
 *  unexplained integers that drifted silently for three releases. */
const SEEDED_HOOKS = 7;

// ux-hooks-surface standing journeys (hooks-surface tasks 5.6), driven against
// the mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). The hook
// mock is STATEFUL: attach/detach/edit/set-settings mutate an in-memory store the
// list + show reads back, and every hook_* IPC call is recorded on
// `window.__hookCalls` so a journey can assert the mutation fired with the right
// args. NEVER touches ~/.claude.

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

// ─── (b) Library rows + built-in read-only editor fields ───────────────────────
// Cut: HookEditor.test.tsx:140 (read-only built-in) and
// HooksScreen.test.tsx:102 (provenance/reach row) hold this behavior.

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
  await expect(page.locator(".hook-row")).toHaveCount(SEEDED_HOOKS);

  await page.getByRole("main").getByRole("button", { name: "New hook" }).click();
  await expect(page).toHaveURL(/#\/hook\/new$/);

  await page.locator('input[aria-label="hook name"]').fill("lint-after-edit");
  await page.locator('textarea[aria-label="command"]').fill("npx eslint --fix");
  await page.getByLabel("event").click();
  await page.getByRole("option", { name: /^PreToolUse\b/ }).click();
  // D2: tools live behind the "Specific tools" mode, not in a wall of checkboxes.
  await page.getByRole("radio", { name: "Specific tools" }).click();
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
  await expect(page.locator(".hook-row")).toHaveCount(SEEDED_HOOKS + 1);
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
  await expect(page.locator(".hook-row")).toHaveCount(SEEDED_HOOKS - 1);
  await expect(page.locator(".hook-row").first()).toContainText("lsp-report");

  const del = (await hookCalls(page)).find((c) => c.cmd === "hook_delete");
  expect(del?.args?.name).toBe("notify-on-stop");
  // `confirm: true` → the CLI's `--yes`; without it the delete is a dry run.
  expect(del?.args?.confirm).toBe(true);
});

// ─── (d) Palette Attach — a GLOBAL pick surfaces the machine-wide consequence ──
// Cut: commandLayerPalette.test.tsx:190 holds "Attach hook… at global scope
// surfaces a machine-wide consequence confirm".

// ─── (e) Palette Detach → undo toast, and Undo re-invokes attach ───────────────
// Cut: commandLayerPalette.test.tsx:143 holds "Detach hook… detaches from an
// attached scope and surfaces an undo toast".

// ─── (f) lsp-report settings: per-language table + honest labels + set-settings ─
// Cut: HookEditor.test.tsx:163 (per-language table edits via
// hook_set_settings) and HookEditor.test.tsx's honest-labels test hold this.

// ─── (g) Capability-gated reach badges — all four verdict states ───────────────
// The library-row half folds into the harness panel test below (step
// "library row reach honors the capability matrix"). The per-event editor
// half duplicated that same test's own coverage.

test("harness panel: toggling a harness narrows affinity and the row's reach updates", async ({
  page,
}) => {
  await test.step("library row reach honors the capability matrix", async () => {
    // ?hookCapsVaried=1 → claude-code supported, codex feature_off, opencode
    // unsupported, pi not_installed.
    await page.goto("/?hookCapsVaried=1#/hooks");
    const reach = page
      .locator(".hook-row", { hasText: "lsp-report" })
      .locator(".hook-row-reach");

    await expect.soft(reach.locator('[aria-label="Claude Code: supported"]')).toBeVisible();
    await expect.soft(reach.locator('[aria-label="Codex: feature_off"]')).toBeVisible();
    await expect.soft(reach.locator('[aria-label="opencode: unsupported"]')).toBeVisible();
    // not_installed is omitted entirely — no false reach claim for pi.
    await expect.soft(reach.locator('[aria-label*="Pi"]')).toHaveCount(0);

    // The neutral verdicts expose their reason via the tooltip (title).
    await expect
      .soft(reach.locator('[aria-label="Codex: feature_off"]'))
      .toHaveAttribute("title", /hooks feature is off/);
    await expect
      .soft(reach.locator('[aria-label="opencode: unsupported"]'))
      .toHaveAttribute("title", /off by default/);
  });

  await test.step("harness panel: toggling a harness narrows affinity and the row's reach updates", async () => {
    await page.goto("/?hookCapsVaried=1#/hook/format-on-write");
    const panel = page.locator(".hook-harness-panel");
    await expect(panel).toBeVisible();
    // The explanatory sentence rides on the section head's `title` (idle
    // information, never a paragraph in the body — side panel language rule 9).
    const head = page.locator('[data-testid="side-section-harnesses"]');

    // This hook has no affinity → empty means ALL, and the copy says so. Rows
    // are `MultiSelectList` options — the accessible name also carries the
    // reach status word, so anchor with a regex rather than match it exactly.
    await expect(head).toHaveAttribute("title", /Runs on every effective harness/);
    await expect(
      panel.getByRole("option", { name: /^Claude Code\b/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("option", { name: /^Codex\b/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Reach is per-verdict on the SAME row as the toggle.
    await expect(panel.locator('[aria-label="Claude Code: supported"]')).toHaveText(
      "will fire",
    );
    await expect(panel.locator('[aria-label="Codex: feature_off"]')).toHaveText("hooks off");

    // Turning codex off must materialise the survivors, never leave empty (= all).
    await panel.getByRole("option", { name: /^Codex\b/ }).click();
    await expect(head).toHaveAttribute("title", /Narrowed/);
    // Affinity now wins over the probe: an excluded harness never "will fire".
    await expect(panel.locator('[aria-label="Codex: excluded"]')).toHaveText("excluded");
    await expect(page.getByText("UNSAVED")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("UNSAVED")).toHaveCount(0);

    const edit = (await hookCalls(page)).find((c) => c.cmd === "hook_edit");
    expect(edit?.args?.harnesses).not.toContain("codex");
    expect(edit?.args?.harnesses).toContain("claude-code");

    // D1 folded the editor's per-event reach INTO the harness panel, one row
    // per harness — the retired standalone reach line is really gone (not
    // just restyled).
    await expect.soft(page.locator(".hook-event-reach")).toHaveCount(0);
  });
});

// ─── (h) Project hooks card reflects attach state honestly ─────────────────────
// Cut: the "project hooks sheet detaches locally…" test below already checks
// "Inherited lsp-report" is disabled; a soft `toBeChecked()` was added there
// for this reason.

// ─── (i) Create a MANAGED-SCRIPT hook end to end (hook-editor-redesign D3) ─────

test("create a managed-script hook: stub seeds, body ships with hook_new, library flags it", async ({
  page,
}) => {
  await page.goto("/#/hook/new");
  await expect(page.locator(".hook-editor")).toBeVisible();

  await page.locator('input[aria-label="hook name"]').fill("fmt-py");
  await page.getByRole("radio", { name: "Managed script" }).click();

  // An empty script file would silently no-op at the first event, so the mode
  // seeds a runnable stub — and the stub follows the interpreter.
  const body = page.locator(".hook-script-body .cm-content");
  await expect(body).toContainText("#!/usr/bin/env bash");
  await page.getByLabel("script interpreter").click();
  await page.getByRole("option", { name: "python3" }).click();
  await expect(body).toContainText("#!/usr/bin/env python3");
  await page.locator('input[aria-label="script args"]').fill("--check");

  // Write a real script over the stub.
  await body.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("import sys\nprint('formatted')\n");
  await expect(page.getByText("UNSAVED")).toBeVisible();

  // The live summary describes what is about to be saved.
  await expect(page.getByLabel("hook summary")).toContainText("runs a managed script");

  await page.getByRole("button", { name: "Create hook" }).click();
  await expect(page).toHaveURL(/#\/hook\/fmt-py$/);
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  const created = (await hookCalls(page)).find((c) => c.cmd === "hook_new");
  expect(created?.args?.name).toBe("fmt-py");
  expect(created?.args?.scriptSource).toBe("managed");
  expect(created?.args?.scriptInterpreter).toBe("python3");
  expect(created?.args?.scriptArgs).toBe("--check");
  expect(String(created?.args?.scriptBody)).toContain("print('formatted')");
  // A script hook must never also carry a command.
  expect(created?.args?.command).toBeNull();

  // The library shows it as a script hook, not an indistinguishable command row.
  await page.locator(".header-back").click();
  await expect(
    page.locator(".hook-row", { hasText: "fmt-py" }).locator(".hook-action-tag"),
  ).toHaveText("script:managed");

  // Folded from the cut "managed script: switching to a shell command…"
  // test: after a save clears the script (hook_edit's stateful mock), the
  // library row's script tag disappears. Nothing else covers this — it
  // crosses screens through the stateful mock (HookActionEditor's vitest
  // tests only see one screen at a time).
  await test.step("switching away from a managed script clears the library's script tag", async () => {
    await page.locator(".hook-row", { hasText: "fmt-py" }).click();
    await page.getByRole("radio", { name: "Shell command" }).click();
    await page.locator('textarea[aria-label="command"]').fill("echo replaced");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const dialog = page.locator(".confirm-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete script and save" }).click();
    await expect(page.getByText("UNSAVED")).toHaveCount(0);

    await page.goto("/#/hooks");
    await expect(
      page.locator(".hook-row", { hasText: "fmt-py" }).locator(".hook-action-tag"),
    ).toHaveCount(0);
  });
});

// ─── (j) Managed-script edit loop: ⌘S lands the body in ONE action (D6) ────────

test("managed script: editing the body and ⌘S saves the definition and the body together", async ({
  page,
}) => {
  await page.goto("/#/hook/format-on-write");
  const body = page.locator(".hook-script-body .cm-content");
  await expect(body).toContainText("prettier --write");
  // The real on-disk path is shown — this is what a mode switch would delete.
  await expect(page.locator(".hook-script-managed")).toContainText(
    "/.skill-hub/hooks/format-on-write/script.sh",
  );
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  await body.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("#!/usr/bin/env bash\necho EDITED\n");
  // Script dirtiness feeds the SAME pill — no separate save dance.
  await expect(page.getByText("UNSAVED")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  const calls = await hookCalls(page);
  expect(calls.some((c) => c.cmd === "hook_edit")).toBe(true);
  const saved = calls.find((c) => c.cmd === "hook_script_save");
  expect(saved, "the body save fires as part of the same ⌘S").toBeTruthy();
  expect(String(saved?.args?.body)).toContain("echo EDITED");

  // Re-opening reads back the saved body (the write actually landed).
  await page.goto("/#/hooks");
  await page.locator(".hook-row", { hasText: "format-on-write" }).click();
  await expect(page.locator(".hook-script-body .cm-content")).toContainText("echo EDITED");
});

// ─── (k) Switching away from a managed script is gated by a naming confirm ─────
// Cut: HookActionEditor.test.tsx:410 (confirm names the file) and :458
// (CLEAR sentinel) hold this. The stateful-mock library-tag-disappears tail
// folds into the "create a managed-script hook…" test above.

// ─── (l) Tool picker journey: filter → select → save (D2) ─────────────────────

test("tools picker: a collapsed group is reachable by typing, and the pick round-trips", async ({
  page,
}) => {
  await page.goto("/#/hook/notify-on-stop");
  await expect(page.locator(".hook-editor")).toBeVisible();

  // This hook matches all tools, so the picker starts closed entirely.
  await expect(page.getByRole("radio", { name: "All tools" })).toBeChecked();
  await expect(page.locator(".tool-picker")).toHaveCount(0);

  await page.getByRole("radio", { name: "Specific tools" }).click();
  const picker = page.locator(".tool-picker");
  await expect(picker).toBeVisible();
  // Common is open; a Files-group token is collapsed out of sight…
  await expect(
    picker.getByRole("checkbox", { name: "Edit", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("checkbox", { name: "NotebookEdit", exact: true }),
  ).toHaveCount(0);
  // …but typing finds it (a collapse must never be a hiding place).
  await picker.getByPlaceholder("Filter tools…").fill("notebookedit");
  await picker.getByRole("checkbox", { name: "NotebookEdit", exact: true }).check();

  // The selection surfaces as a removable chip even while the filter hides the row.
  await picker.getByPlaceholder("Filter tools…").fill("zzz");
  await expect(picker.getByRole("button", { name: "Remove NotebookEdit" })).toBeVisible();
  await expect(picker.getByText(/No tool matches/)).toBeVisible();

  // The summary line tracks the choice live.
  await expect(page.getByLabel("hook summary")).toContainText("NotebookEdit");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  const edit = (await hookCalls(page)).find((c) => c.cmd === "hook_edit");
  expect(edit?.args?.tools).toEqual(["NotebookEdit"]);
  // Switching modes clears the other representation, so no stale matcher wins.
  expect(edit?.args?.matcher).toBe("");

  // And the library row reflects it.
  await page.locator(".header-back").click();
  await expect(
    page.locator(".hook-row", { hasText: "notify-on-stop" }).locator(".hook-tools"),
  ).toContainText("NotebookEdit");
});

// ─── (m) Harness panel: one row carries the toggle AND the reach verdict (D1) ──
// Moved up into a `test.step`-merged test near (g) above, which also holds
// the folded library-row reach check.

// ─── (n) Per-event reach recomputes with NO fetch (D6) ────────────────────────

test("harness panel: changing the event instantly downgrades a harness that lacks it", async ({
  page,
}) => {
  // format-on-write has NO affinity, so every harness is targeted and the only
  // thing that can downgrade a row is the event itself.
  await page.goto("/#/hook/format-on-write");
  const panel = page.locator(".hook-harness-panel");
  await expect(panel).toBeVisible();
  // Let the managed-script fetch settle so it can't be mistaken for a reach probe.
  await expect(page.locator(".hook-script-body .cm-content")).toContainText("prettier");

  const before = (await hookCalls(page)).length;
  await page.getByLabel("event").click();
  await page.getByRole("option", { name: /^SessionEnd\b/ }).click();

  // SessionEnd is claude-only — codex must stop claiming reach for it.
  await expect(panel.locator('[aria-label="Codex: event unsupported"]')).toHaveText(
    "event unsupported",
  );
  await expect(panel.locator('[aria-label="Claude Code: supported"]')).toHaveText(
    "will fire",
  );
  // Pure client derivation from the cached probe: no extra IPC, no spinner.
  expect((await hookCalls(page)).length).toBe(before);
});

// ─── (o) `/` inside the script editor types, it does not jump to the filter ────

test("managed script: typing `/` in the body stays in the editor (no hotkey hijack)", async ({
  page,
}) => {
  // format-on-write matches specific tools, so the tool picker's filter IS on
  // screen — i.e. `focusScreenSearch()` has somewhere to land. CodeMirror types
  // into a contenteditable div, not a <textarea>, so a tag-name-only guard let
  // the global `/` hotkey yank focus mid-keystroke and swallow the character.
  await page.goto("/#/hook/format-on-write");
  const body = page.locator(".hook-script-body .cm-content");
  await expect(body).toContainText("prettier");
  await expect(page.locator(".tool-picker")).toBeVisible();

  await body.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("#!/usr/bin/env bash\n");

  // The slash landed in the script…
  await expect(body).toContainText("#!/usr/bin/env bash");
  // …and the tool filter never stole focus (it is still empty and unfocused).
  await expect(page.locator(".tool-picker-search input")).toHaveValue("");
  await expect(page.locator(".tool-picker-search input")).not.toBeFocused();
});

// ─── (p) A hook that BECOMES managed gets a seeded script, never a missing one ─

test("switching a command hook to a managed script leaves a real body, not a 'missing on disk' state", async ({
  page,
}) => {
  await page.goto("/#/hook/notify-on-stop");
  await expect(page.locator(".hook-editor")).toBeVisible();

  await page.getByRole("radio", { name: "Managed script" }).click();
  // The stub is seeded client-side so a brand-new script is never an empty file.
  await expect(page.locator(".hook-script-body .cm-content")).toContainText(
    "#!/usr/bin/env bash",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("UNSAVED")).toHaveCount(0);

  // Re-open: the body must come back off "disk". A managed hook is never
  // bodyless — the editor seeds a stub and ⌘S lands it, and the CLI seeds one
  // itself on the switch (`ensure_managed_script`) — so the "missing on disk"
  // warning must not appear here. (Mock-side parity with the CLI's own seeding
  // is pinned in src/test/hookMockFidelity.test.ts.)
  await page.goto("/#/hooks");
  await page.locator(".hook-row", { hasText: "notify-on-stop" }).click();
  await expect(page.locator(".hook-script-body .cm-content")).toContainText(
    "#!/usr/bin/env bash",
  );
  await expect(page.locator(".hook-script-warn")).toHaveCount(0);
  // The absolute path comes from the backend, so it is shown for real.
  await expect(page.locator(".hook-script-managed")).toContainText(
    "/.skill-hub/hooks/notify-on-stop/script.sh",
  );
});


test("project hooks sheet detaches locally, preserves inheritance and supports Undo and keyboard return", async ({ page }) => {
  await gotoReady(page, "/#/project/example-app");
  const trigger = page.getByRole("button", { name: "Manage hooks", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Hooks on example-app" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("checkbox", { name: "Inherited lsp-report" })).toBeDisabled();
  // Folded from the cut "project hooks card reflects attach state honestly"
  // test: the inherited hook still reads as attached (checked), not as off.
  await expect.soft(sheet.getByRole("checkbox", { name: "Inherited lsp-report" })).toBeChecked();
  await sheet.getByRole("checkbox", { name: "Detach notify-on-stop", exact: true }).uncheck();
  await expect(sheet.getByRole("checkbox", { name: "Attach notify-on-stop", exact: true })).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await trigger.click();
  await expect(sheet.getByRole("checkbox", { name: "Detach notify-on-stop", exact: true })).toBeChecked();
  await page.setViewportSize({ width: 520, height: 900 });
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await sheet.getByRole("button", { name: "Open hook library" }).click();
  await expect(page).toHaveURL(/#\/hooks$/);
  await page.getByRole("button", { name: "Back to example-app" }).click();
  await expect(sheet).toBeVisible();
});
