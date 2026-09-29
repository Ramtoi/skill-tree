// ─── Shared render plumbing for the dialog contract harness (A5b) ─────────
//
// Split out of `dialogContract.test.tsx` (componentSizeGuard's 1000-line
// ceiling) so the row tables in `dialogContract.rows.modal.tsx` and
// `dialogContract.rows.handbuilt.tsx` have somewhere to import from without
// a circular import back to the test file itself, which owns the scanner
// and the case loop (`runDialogRow`).

import { useState, type ReactElement } from "react";
import { vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { makeQueryClient, primeRegistry, sampleRegistry, sampleSourceList } from "./helpers";
import type { Registry, SourceView } from "@/types";
import type { AgentDocInstructionSet, AgentDocPolicyInfo } from "@/types/agentDocs";

// ─── Row/case shapes ────────────────────────────────────────────────────────

export interface RenderedDialog {
  /** The open dialog's root element (`role="dialog"`). */
  dialog: HTMLElement;
  /** Where to fire the Escape keydown. Defaults to `dialog` — override only
   *  when the row's own handler lives on one descendant (CommandPalette's
   *  search input, not its dialog root). */
  escapeTarget?: HTMLElement;
  /** Proves the dialog actually closed: the close callback fired, the
   *  store's open flag flipped, or the dialog left the DOM. */
  assertClosed: () => void;
  /** Where focus must land after close: a real, focused element that opened
   *  the dialog. Required — a row that mounts its dialog already open makes
   *  Modal record `<body>` as the opener, and "focus returns to <body>" passes
   *  even with the restore line deleted. Use `ControlledOpen`/`ControlledMount`
   *  plus `openViaTrigger()`, or `OpenerButton` for store-driven dialogs. */
  trigger: HTMLElement;
  /** Closes the dialog without Escape (a backdrop click). Set only on rows
   *  whose Escape is `known` broken, so the restore case judges restore on
   *  its own instead of failing at the close step. */
  close?: () => Promise<void>;
  /** ConfirmDialog-with-a-destructive-action rows only. */
  onConfirm?: ReturnType<typeof vi.fn>;
}

export interface DialogVariant {
  /** Sub-case name — most rows have exactly one; AgentDocsFixBanner has
   *  three hand-built dialogs in the one file the scanner finds, so its row
   *  carries three variants under one table entry. */
  name: string;
  render: () => Promise<RenderedDialog>;
  /** Set on the ConfirmDialog(tone=danger) variant only. */
  confirmGuard?: boolean;
  /** Cases whose assertion FAILS today (a product finding). Each runs as
   *  `it.fails`, so a product fix turns it red and forces the entry out. */
  known?: { escape?: string; trap?: string; restore?: string; confirmGuard?: string };
  /** The dialog cannot be opened in vitest at all; every case is skipped
   *  with this reason. `render` is never called. */
  unreachable?: string;
}

export interface DialogRow {
  /** Path relative to `src/`, exactly as the scanner reports it. */
  file: string;
  name: string;
  /** Total `<Modal` + `<ConfirmDialog` + `<Sheet` + hand-built-`aria-modal`
   *  tag openings the scanner counts in `file` — checked against the live
   *  scan in `dialogContract.test.tsx`, so a second dialog quietly added to
   *  this file (or one removed) fails here instead of going unnoticed. */
  expectedOpenings: number;
  variants: DialogVariant[];
}

// ─── Controlled-render helpers ─────────────────────────────────────────────

const OPENER_LABEL = "Open dialog (contract trigger)";

/** A real button that opens the dialog, the way every host does it. Rendered
 *  beside the dialog so the opener Modal records is this button, not
 *  `<body>`. */
export function OpenerButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}>
      {OPENER_LABEL}
    </button>
  );
}

/** Clicks (and so focuses) the row's `OpenerButton`, and returns it as the
 *  trigger focus must return to. */
export async function openViaTrigger(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: OPENER_LABEL });
  await userEvent.click(trigger);
  return trigger;
}

/** Wraps a controlled `{ open, onClose }` dialog in REAL state, so closing it
 *  actually flips `open` to false — matching how its real host renders it.
 *  Spying `onClose` alone would leave the dialog mounted forever, which would
 *  make "focus returns after close" pass without the dialog ever having
 *  closed. Starts CLOSED behind an `OpenerButton`; call `openViaTrigger()`. */
export function ControlledOpen({
  render,
  onCloseSpy,
}: {
  render: (open: boolean, onClose: () => void) => ReactElement;
  onCloseSpy: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <OpenerButton onOpen={() => setOpen(true)} />
      {render(open, () => {
        setOpen(false);
        onCloseSpy();
      })}
    </>
  );
}

/** Same idea for a dialog with no `open` prop at all — its real host mounts
 *  it conditionally instead, so closing it UNMOUNTS it. Starts unmounted
 *  behind an `OpenerButton`; call `openViaTrigger()`. */
export function ControlledMount({
  render,
  onCloseSpy,
}: {
  render: (onClose: () => void) => ReactElement | null;
  onCloseSpy: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <OpenerButton onOpen={() => setMounted(true)} />
      {mounted
        ? render(() => {
            setMounted(false);
            onCloseSpy();
          })
        : null}
    </>
  );
}

/** Closes a hand-built dialog by clicking its backdrop (the dialog's
 *  `role="presentation"` parent) — for `RenderedDialog.close`. */
export function backdropClose(dialog: HTMLElement): () => Promise<void> {
  return async () => {
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("dialog has no backdrop parent");
    await userEvent.click(backdrop);
  };
}

export function newClient(registry: Registry = sampleRegistry) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return client;
}

/** Installs command overrides that chain to whatever `setup.ts`'s
 *  `beforeEach` already installed (its per-command defaults), the same
 *  pattern `helpers.tsx`'s `mockSyncReport` uses — `vi.mocked(invoke)`
 *  directly. `mockCommands`/`hang`/`fail` landed in `helpers.tsx` with unit
 *  A5a after these rows were written; left as-is rather than churning every
 *  row for a mechanically equivalent helper. */
export function withCommands(handlers: Record<string, (args: unknown) => unknown>) {
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) =>
    cmd in handlers
      ? Promise.resolve(handlers[cmd](args))
      : prev
        ? prev(cmd as never, args as never)
        : Promise.resolve(undefined)) as never);
}

// ─── Fixture builders shared by more than one row ──────────────────────────

/** Minimal `AgentDocInstructionSet`, in the shape `AgentDocsView.test.tsx`'s
 *  own `makeSet` uses — an `as` cast over a deliberately partial object,
 *  since these rows only exercise the fields `bannerCopy`/the trigger
 *  condition read. */
export function makeInstructionSet(
  overrides: Partial<AgentDocInstructionSet> & { id: string; relative_dir: string },
): AgentDocInstructionSet {
  return {
    display_path: overrides.relative_dir || "root",
    full_path_title: `/p/${overrides.relative_dir}`,
    label: overrides.relative_dir || "Project Instructions",
    label_source: "path",
    verdict: "canonical",
    flags: [],
    formats: {
      CLAUDE: {
        format: "CLAUDE",
        rel: "CLAUDE.md",
        exists: false,
        file: null,
        is_symlink: false,
        target_kind: "missing",
        required_by_harnesses: ["claude-code"],
        warnings: [],
        title: null,
      },
      AGENT: {
        format: "AGENT",
        rel: "AGENTS.md",
        exists: false,
        file: null,
        is_symlink: false,
        target_kind: "missing",
        required_by_harnesses: ["codex"],
        warnings: [],
        title: null,
      },
    },
    legacy: [],
    appendix: null,
    required_formats: ["CLAUDE", "AGENT"],
    warnings: [],
    ...overrides,
  } as AgentDocInstructionSet;
}

export const SAMPLE_AGENT_DOC_POLICY: AgentDocPolicyInfo = {
  requires_claude: true,
  requires_agent: true,
  strategy: "symlink",
  canonical: "AGENTS.md",
  derived: "CLAUDE.md",
};

export function sampleSource(): SourceView {
  return sampleSourceList.sources[2] as unknown as SourceView; // "org-skills"
}
