// ─── The dialog contract harness (plan unit A5b) ──────────────────────────
//
// Scans `app/src/**/*.tsx` (outside `test/` and `mocks/`) for dialog surfaces
// and requires each to be accounted for, either with its own DIALOGS row or
// with a VIA_PRIMITIVE allowlist entry:
//
//   1. Every file that renders `<Modal` — the shared primitive in
//      `components/Modal.tsx` (portal + backdrop + focus trap + Esc/backdrop
//      close + restore-focus-on-close) — needs a DIALOGS row. Rows for these
//      live in `dialogContract.rows.modal.tsx` (21 files).
//   2. Every file that hand-rolls its own dialog — a JSX element carrying
//      BOTH `role="dialog"` AND `aria-modal="true"` on the same tag — also
//      needs a DIALOGS row. Rows for these live in
//      `dialogContract.rows.handbuilt.tsx` (7 files; `AgentDocsFixBanner`
//      holds three).
//   3. Every file that renders `<ConfirmDialog` or `<Sheet` — both thin
//      presets built on `<Modal` (see `components/Modal.tsx`) — needs EITHER
//      a DIALOGS row (already required by 1 or 2 above, e.g.
//      `screens/SkillEditor.tsx` renders both `<Modal` and `<ConfirmDialog`)
//      OR an entry in VIA_PRIMITIVE below, naming the primitive and noting
//      that the primitive's own row (`components/Modal.tsx`, in
//      `dialogContract.rows.modal.tsx`) already covers Escape, trap and
//      restore for it. A file with neither fails by name.
//
// Excluded on purpose: `role="dialog"` WITHOUT `aria-modal="true"` —
// TipsTour, SyncReportDrawer, `snippets/AddSnippetPopover` and every
// `Popover.tsx` consumer. These are anchored, non-modal popovers (no
// backdrop, no page takeover); they don't owe this contract. The tag-scoped
// regex below excludes them structurally — it only fires when both
// attributes sit on the same opening tag.
//
// Every dialog-rendering tag opening in a file is also COUNTED (`<Modal`,
// `<ConfirmDialog`, `<Sheet`, and hand-built `aria-modal` tags, summed), and
// every DIALOGS row and VIA_PRIMITIVE entry must state that file's expected
// total. A second dialog quietly added to an already-covered file changes
// the count and fails the check below, instead of going unnoticed the way a
// pure presence check would.
//
// Each row's three (or four) cases:
//   - Escape closes the dialog: the close callback fires, or the dialog
//     leaves the DOM.
//   - Focus is trapped: Tab from the last focusable lands on the first;
//     Shift+Tab from the first lands on the last.
//   - Focus returns to the trigger after close. Every row opens its dialog
//     from a real, focused trigger (its host's own button, or the helpers'
//     `OpenerButton`); a row whose trigger is `<body>` fails, since Modal
//     records `<body>` as the opener of a dialog mounted already open and
//     "focus returns to <body>" passes with the restore line deleted.
//   - ConfirmDialog with a destructive action only: Escape must not also
//     fire the confirm callback.
//
// A case that fails today is a product finding, not something this file
// fixes: it is marked with `known: "reason"`, which runs it as `it.fails`
// with the reason baked into the test title. A product fix makes the case
// pass, `it.fails` turns red, and the stale entry has to go. A variant that
// cannot be opened in vitest at all is `unreachable` and is skipped. Every
// `known` case is listed in the unit's return.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useAppStore } from "@/store";
import type { DialogRow } from "./dialogContract.helpers";
import { MODAL_ROWS } from "./dialogContract.rows.modal";
import { HANDBUILT_ROWS } from "./dialogContract.rows.handbuilt";

// ─── Scanner ───────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "src");
const EXCLUDE_DIRS = new Set(["test", "mocks"]);

function walkTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      out.push(...walkTsxFiles(p));
    } else if (entry.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

/** Counts `<TagName` openings, requiring the next character to be
 *  whitespace, `/` or `>` — so `Omit<ModalProps, …>` (a real occurrence in
 *  `components/Modal.tsx`) never counts as a `<Modal` JSX usage, only an
 *  actual opening tag does. */
function countTagOpenings(content: string, tagName: string): number {
  const re = new RegExp(`<${tagName}(?=[\\s/>])`, "g");
  return (content.match(re) ?? []).length;
}

/** `role="dialog"` and `aria-modal="true"` on the SAME opening tag, either
 *  attribute order. `[^>]*` matches newlines (JS char classes aren't `.`),
 *  so multi-line JSX tags (AgentDocsFixBanner's three) still match; the
 *  trailing `[^>]*>` keeps the scan inside one tag, so it never bridges two
 *  separate elements. */
const MODAL_DIALOG_TAG_RE =
  /<[^>]*\brole="dialog"[^>]*\baria-modal="true"[^>]*>|<[^>]*\baria-modal="true"[^>]*\brole="dialog"[^>]*>/;

function countHandBuiltDialogTags(content: string): number {
  const re = new RegExp(MODAL_DIALOG_TAG_RE.source, "g");
  return (content.match(re) ?? []).length;
}

function scanModalUsers(): Set<string> {
  const hits = new Set<string>();
  for (const file of walkTsxFiles(SRC)) {
    if (countTagOpenings(readFileSync(file, "utf-8"), "Modal") > 0) {
      hits.add(relative(SRC, file));
    }
  }
  return hits;
}

function scanHandRolledDialogs(): Set<string> {
  const hits = new Set<string>();
  for (const file of walkTsxFiles(SRC)) {
    if (countHandBuiltDialogTags(readFileSync(file, "utf-8")) > 0) {
      hits.add(relative(SRC, file));
    }
  }
  return hits;
}

/** Files rendering `<ConfirmDialog` or `<Sheet` — the two `Modal`-built
 *  presets (`components/Modal.tsx`). */
function scanConfirmDialogOrSheetUsers(): Set<string> {
  const hits = new Set<string>();
  for (const file of walkTsxFiles(SRC)) {
    const content = readFileSync(file, "utf-8");
    if (countTagOpenings(content, "ConfirmDialog") > 0 || countTagOpenings(content, "Sheet") > 0) {
      hits.add(relative(SRC, file));
    }
  }
  return hits;
}

/** Every file's total dialog-opening count: `<Modal` + `<ConfirmDialog` +
 *  `<Sheet` + hand-built `aria-modal` tags. Only files with at least one
 *  opening are included. */
function scanDialogOpeningCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walkTsxFiles(SRC)) {
    const content = readFileSync(file, "utf-8");
    const total =
      countTagOpenings(content, "Modal") +
      countTagOpenings(content, "ConfirmDialog") +
      countTagOpenings(content, "Sheet") +
      countHandBuiltDialogTags(content);
    if (total > 0) counts.set(relative(SRC, file), total);
  }
  return counts;
}

const MODAL_USER_FILES = scanModalUsers();
const HAND_ROLLED_FILES = scanHandRolledDialogs();
// `components/Modal.tsx` defines the primitive itself (both `role="dialog"`
// and `aria-modal="true"` live on its own tag), so the hand-rolled scan
// finds it too. It's already covered by the `<Modal` scan above — its row
// below tests the base `Modal` plus the `ConfirmDialog` preset it also
// defines — so it isn't a second, hand-rolled row.
HAND_ROLLED_FILES.delete(join("components", "Modal.tsx"));

const ALL_DIALOG_FILES = new Set<string>([...MODAL_USER_FILES, ...HAND_ROLLED_FILES]);
const CONFIRM_OR_SHEET_FILES = scanConfirmDialogOrSheetUsers();
const DIALOG_OPENING_COUNTS = scanDialogOpeningCounts();

const DIALOGS: DialogRow[] = [...MODAL_ROWS, ...HANDBUILT_ROWS];

// ─── VIA_PRIMITIVE: files that only use ConfirmDialog/Sheet, no own row ────
//
// Each of these renders `<ConfirmDialog` and/or `<Sheet` but nothing else
// this harness tracks (no `<Modal`, no hand-built dialog) — Escape, the
// focus trap and focus restore are all `Modal`'s own mechanics, already
// proven by the `components/Modal.tsx` row in `dialogContract.rows.modal.tsx`.
// `expectedOpenings` is the file's total `<ConfirmDialog`/`<Sheet` tag count,
// checked against the live scan below.

interface ViaPrimitiveEntry {
  file: string;
  /** Which Modal-built preset(s) this file renders. */
  primitive: "ConfirmDialog" | "Sheet" | "ConfirmDialog, Sheet";
  note: string;
  expectedOpenings: number;
}

/** Names the exact row and variant (both in `dialogContract.rows.modal.tsx`)
 *  that proves Escape, the focus trap and focus restore for `primitive` —
 *  so a reader doesn't have to trust "Modal's own mechanics" on faith, they
 *  can go look at the variant that actually renders it. */
function viaModalRowNote(primitive: ViaPrimitiveEntry["primitive"]): string {
  const variant =
    primitive === "ConfirmDialog"
      ? `the "ConfirmDialog (tone=danger)" variant`
      : primitive === "Sheet"
        ? `the "Sheet (preset)" variant`
        : `the "ConfirmDialog (tone=danger)" and "Sheet (preset)" variants`;
  return (
    `Escape, the focus trap and focus restore for ${primitive} are Modal's own mechanics, proven by ` +
    `components/Modal.tsx's row (dialogContract.rows.modal.tsx), ${variant}.`
  );
}

const VIA_PRIMITIVE: ViaPrimitiveEntry[] = (
  [
  { file: "components/AgentDocsView.tsx", primitive: "ConfirmDialog", expectedOpenings: 1 },
  {
    file: "components/backup/RestoreDangerZone.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  {
    file: "components/companions/CompanionConsequenceDialog.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  {
    file: "components/companions/CompanionsEditSheet.tsx",
    primitive: "ConfirmDialog, Sheet",
    expectedOpenings: 2,
  },
  { file: "components/DisableDialog.tsx", primitive: "ConfirmDialog", expectedOpenings: 1 },
  {
    file: "components/ImportSkillDialog.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  { file: "components/mcp/McpCapabilitySheet.tsx", primitive: "Sheet", expectedOpenings: 1 },
  { file: "components/mcp/McpCompareSheet.tsx", primitive: "Sheet", expectedOpenings: 1 },
  { file: "components/NewBundleSheet.tsx", primitive: "Sheet", expectedOpenings: 1 },
  {
    file: "components/permissions/PermissionsOverlays.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 2,
  },
  {
    file: "components/recovery/RecoveryAttachPicker.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  {
    file: "components/recovery/RecoveryRepositoryPicker.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  { file: "components/remotes/AddRemoteWizard.tsx", primitive: "Sheet", expectedOpenings: 1 },
  {
    file: "components/remotes/HeadlessMachineWizard.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  {
    file: "components/remotes/RemoteDetail.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 2,
  },
  {
    file: "components/skillFiles/AddSkillFileSheet.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  {
    file: "components/snippets/AppliedLocationsPanel.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  {
    file: "components/snippets/AppliedSnippetsStrip.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  {
    file: "components/snippets/SnippetCreateForm.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  { file: "components/StatusBar.tsx", primitive: "ConfirmDialog", expectedOpenings: 1 },
  {
    file: "components/subagents/NewSubagentSheet.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  { file: "screens/HarnessDocEditor.tsx", primitive: "ConfirmDialog", expectedOpenings: 3 },
  { file: "screens/HookEditor.tsx", primitive: "ConfirmDialog", expectedOpenings: 2 },
  { file: "screens/library/BundleLens.tsx", primitive: "ConfirmDialog", expectedOpenings: 2 },
  {
    file: "screens/project/MissingSkillsReview.tsx",
    primitive: "ConfirmDialog",
    expectedOpenings: 1,
  },
  {
    file: "screens/project/ProjectHooksSheet.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  { file: "screens/SkillAgentEditor.tsx", primitive: "ConfirmDialog", expectedOpenings: 1 },
  { file: "screens/SnippetEditor.tsx", primitive: "ConfirmDialog", expectedOpenings: 2 },
  { file: "screens/Sources.tsx", primitive: "ConfirmDialog", expectedOpenings: 2 },
  { file: "screens/SubagentEditor.tsx", primitive: "ConfirmDialog", expectedOpenings: 1 },
  {
    file: "screens/usage/UsageSessionSheet.tsx",
    primitive: "Sheet",
    expectedOpenings: 1,
  },
  ] as Omit<ViaPrimitiveEntry, "note">[]
).map((entry) => ({ ...entry, note: viaModalRowNote(entry.primitive) }));

// ─── Shared render/close/trap plumbing (the case loop) ─────────────────────

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute("aria-hidden") !== "true" && !el.closest("[hidden]"),
  );
}

function pressEscape(target: HTMLElement) {
  fireEvent.keyDown(target, { key: "Escape", code: "Escape" });
}

/** Waits until the dialog's focusable set stops changing (two equal reads in
 *  a row). Several rows load async data (a harness list, a removal preview)
 *  that adds MORE focusable rows after the dialog first appears — grabbing
 *  "the last focusable element" before that settles picks a stale element,
 *  so the trap test's own Tab lands on the real (later) last element instead
 *  of wrapping, which looks exactly like a missing trap but isn't one. */
async function waitForStableFocusable(container: HTMLElement): Promise<HTMLElement[]> {
  let previous = -1;
  await waitFor(() => {
    const current = focusableWithin(container).length;
    if (current === 0 || current !== previous) {
      previous = current;
      throw new Error("focusable set still changing");
    }
  });
  return focusableWithin(container);
}

/** `it` for a passing case; `it.fails` for a `known` one, so a product fix
 *  that makes it pass turns the case red; `it.skip` for an unreachable
 *  variant. */
function caseRunner(variant: DialogRow["variants"][number], known: string | undefined) {
  if (variant.unreachable) return it.skip;
  return known ? it.fails : it;
}

function caseTitle(title: string, variant: DialogRow["variants"][number], known: string | undefined) {
  if (variant.unreachable) return `${title} (unreachable: ${variant.unreachable})`;
  return known ? `${title} (known: ${known})` : title;
}

function runDialogRow(row: DialogRow) {
  describe(`${row.name} — ${row.file}`, () => {
    for (const variant of row.variants) {
      describe(row.variants.length > 1 ? variant.name : "contract", () => {
        const escKnown = variant.known?.escape;
        caseRunner(variant, escKnown)(caseTitle("Escape closes the dialog", variant, escKnown), async () => {
          const { dialog, escapeTarget, assertClosed } = await variant.render();
          pressEscape(escapeTarget ?? dialog);
          await waitFor(() => assertClosed());
        });

        const trapKnown = variant.known?.trap;
        caseRunner(variant, trapKnown)(caseTitle("focus is trapped inside", variant, trapKnown), async () => {
          const { dialog } = await variant.render();
          const focusable = await waitForStableFocusable(dialog);
          expect(focusable.length, "no focusable element inside the dialog").toBeGreaterThan(0);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const user = userEvent.setup();
          last.focus();
          await user.tab();
          expect(document.activeElement, "Tab from the last focusable should land on the first").toBe(first);
          first.focus();
          await user.tab({ shift: true });
          expect(document.activeElement, "Shift+Tab from the first focusable should land on the last").toBe(last);
        });

        const restoreKnown = variant.known?.restore;
        caseRunner(variant, restoreKnown)(
          caseTitle("focus returns to the trigger after close", variant, restoreKnown),
          async () => {
            const { dialog, escapeTarget, trigger, close, assertClosed } = await variant.render();
            // A `<body>` trigger proves nothing: it is what Modal records when
            // the dialog mounts already open, restore line or not.
            expect(trigger, "row must open its dialog from a real trigger, not <body>").not.toBe(document.body);
            expect(dialog.contains(trigger), "the trigger must sit outside the dialog").toBe(false);
            // Focus must be inside the dialog before it closes, or "focus is on
            // the trigger" is simply where it never left.
            if (!dialog.contains(document.activeElement)) (focusableWithin(dialog)[0] ?? dialog).focus();
            expect(dialog.contains(document.activeElement), "focus did not move into the dialog").toBe(true);
            if (close) await close();
            else pressEscape(escapeTarget ?? dialog);
            await waitFor(() => assertClosed());
            await waitFor(() => expect(document.activeElement).toBe(trigger));
          },
        );

        if (variant.confirmGuard) {
          const guardKnown = variant.known?.confirmGuard;
          caseRunner(variant, guardKnown)(
            caseTitle("Escape does not fire the confirm callback", variant, guardKnown),
            async () => {
              const { dialog, escapeTarget, onConfirm } = await variant.render();
              expect(onConfirm, "row is missing its onConfirm spy").toBeTruthy();
              pressEscape(escapeTarget ?? dialog);
              await waitFor(() => expect(vi.mocked(onConfirm!)).not.toHaveBeenCalled());
            },
          );
        }
      });
    }
  });
}

// ─── The presence and count checks ─────────────────────────────────────────

describe("dialog surface scan", () => {
  it("has exactly one DIALOGS row for every <Modal user and hand-rolled modal dialog", () => {
    const covered = new Set(DIALOGS.map((d) => d.file));
    const missing = [...ALL_DIALOG_FILES].filter((f) => !covered.has(f)).sort();
    const extra = [...covered].filter((f) => !ALL_DIALOG_FILES.has(f)).sort();
    expect(missing, `no DIALOGS row for: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `DIALOGS row for a file the scan didn't find: ${extra.join(", ")}`).toEqual([]);
    expect(DIALOGS.length).toBe(ALL_DIALOG_FILES.size);
  });

  it("matches the survey the plan recorded (21 `<Modal` users, 7 hand-rolled files — the plan said 6)", () => {
    expect(MODAL_USER_FILES.size).toBe(21);
    // `components/Modal.tsx` is removed before this point (it's the base, not
    // a hand-rolled dialog) — 8 raw hits minus that one is 7.
    expect(HAND_ROLLED_FILES.size).toBe(7);
  });

  it("every file rendering <ConfirmDialog or <Sheet appears in DIALOGS or in VIA_PRIMITIVE", () => {
    const covered = new Set<string>([...DIALOGS.map((d) => d.file), ...VIA_PRIMITIVE.map((v) => v.file)]);
    const missing = [...CONFIRM_OR_SHEET_FILES].filter((f) => !covered.has(f)).sort();
    expect(missing, `no DIALOGS row and no VIA_PRIMITIVE entry for: ${missing.join(", ")}`).toEqual([]);
  });

  it("no VIA_PRIMITIVE entry is stale", () => {
    const dialogsFiles = new Set(DIALOGS.map((d) => d.file));
    // Stale two ways: the file already got its own DIALOGS row (the
    // allowlist entry is now redundant), or it no longer renders
    // ConfirmDialog/Sheet at all (the allowlist entry has nothing left to
    // allow).
    const redundant = VIA_PRIMITIVE.filter((v) => dialogsFiles.has(v.file)).map((v) => `${v.file} (has its own DIALOGS row)`);
    const dead = VIA_PRIMITIVE.filter((v) => !CONFIRM_OR_SHEET_FILES.has(v.file)).map(
      (v) => `${v.file} (renders neither ConfirmDialog nor Sheet anymore)`,
    );
    expect([...redundant, ...dead]).toEqual([]);
    const files = VIA_PRIMITIVE.map((v) => v.file);
    expect(new Set(files).size, "duplicate VIA_PRIMITIVE entry").toBe(files.length);
  });

  it("every DIALOGS row and VIA_PRIMITIVE entry states the file's actual dialog-opening count", () => {
    const offenders: string[] = [];
    for (const row of DIALOGS) {
      const actual = DIALOG_OPENING_COUNTS.get(row.file) ?? 0;
      if (row.expectedOpenings !== actual) {
        offenders.push(`${row.file}: row says ${row.expectedOpenings}, scan found ${actual}`);
      }
    }
    for (const entry of VIA_PRIMITIVE) {
      const actual = DIALOG_OPENING_COUNTS.get(entry.file) ?? 0;
      if (entry.expectedOpenings !== actual) {
        offenders.push(`${entry.file}: VIA_PRIMITIVE says ${entry.expectedOpenings}, scan found ${actual}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─── Run every row ──────────────────────────────────────────────────────────

beforeEach(() => {
  useAppStore.setState({
    settingsOpen: false,
    cheatsheetOpen: false,
    tipsOpen: false,
    paletteOpen: false,
    paletteInitialVerb: null,
    feedbackOpen: false,
    feedbackMessage: "",
    feedbackContext: null,
    feedbackPhase: "draft",
    feedbackResult: null,
    feedbackRetryAt: 0,
  });
});

for (const row of DIALOGS) runDialogRow(row);
