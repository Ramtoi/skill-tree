// ─── DIALOGS rows: the 7 hand-built modal dialogs (plan unit A5b) ─────────
//
// Split out of `dialogContract.test.tsx` (componentSizeGuard's 1000-line
// ceiling). See that file's header comment for the contract each row
// proves, and `dialogContract.rows.modal.tsx` for the sibling table of the
// 21 direct `<Modal` users.
//
// `AgentDocsFixBanner.tsx` holds three separate hand-built dialogs; the
// scanner finds one file, so it gets one row with three variants below.
// None of the seven files here implement a focus trap; most also have no
// Escape handler and no focus restore. Those gaps are recorded per case with
// `known: "reason"` rather than fixed — they are product findings (plan
// section 11), not bugs in this test.

import { expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useAppStore } from "@/store";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { PresetsSheet } from "@/components/PresetsSheet";
import { AgentDocsFixBanner } from "@/components/AgentDocsFixBanner";
import { AdoptionDialog } from "@/components/AdoptionDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { AgentDocModal } from "@/components/agentDocs/AgentDocModal";
import { ApplyToDialog } from "@/components/snippets/ApplyToDialog";

import { renderWithProviders } from "./helpers";
import type { Rule } from "@/types/permissions";
import {
  ControlledOpen,
  ControlledMount,
  OpenerButton,
  openViaTrigger,
  backdropClose,
  newClient,
  withCommands,
  makeInstructionSet,
  SAMPLE_AGENT_DOC_POLICY,
  type DialogRow,
} from "./dialogContract.helpers";

export const HANDBUILT_ROWS: DialogRow[] = [
  {
    file: "components/NewSkillSheet.tsx",
    name: "NewSkillSheet",
    expectedOpenings: 1,
    variants: [
      {
        name: "NewSkillSheet",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => <NewSkillSheet open={open} onClose={close} />}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "New skill" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "no focus-restore implemented — closing leaves focus on <body>, not the opener",
          trap:
            "no focus trap — only Escape is handled (a window keydown listener); Tab/Shift+Tab at the " +
            "boundary leave the dialog instead of wrapping",
        },
      },
    ],
  },
  {
    file: "components/PresetsSheet.tsx",
    name: "PresetsSheet",
    expectedOpenings: 1,
    variants: [
      {
        name: "PresetsSheet",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <PresetsSheet
                  open={open}
                  scope={{ kind: "global" }}
                  currentRules={[] as Rule[]}
                  onApplyRules={vi.fn()}
                  onClose={close}
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Permission Presets" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "no focus-restore implemented — closing leaves focus on <body>, not the opener",
          trap: "no focus trap implemented — Tab/Shift+Tab at the boundary leave the dialog",
        },
      },
    ],
  },
  {
    file: "components/AgentDocsFixBanner.tsx",
    name: "AgentDocsFixBanner",
    expectedOpenings: 3,
    // Three hand-built dialogs live in this one file (the plan said 6
    // hand-rolled dialogs total; the survey found 7 files, one of which —
    // this one — actually contains three separate dialogs). None of the
    // three has an Escape handler, a focus trap, or focus restoration: all
    // three close only via a backdrop click.
    variants: [
      {
        name: "Fix layout… (plan dialog)",
        render: async () => {
          withCommands({
            agent_docs_fix_plan: () => ({
              strategy: "symlink",
              policy: { requires_claude: true, requires_agent: true, canonical: "AGENTS.md", derived: "CLAUDE.md" },
              steps: [],
              attention: [],
              flagged: [],
            }),
          });
          const client = newClient();
          renderWithProviders(
            <AgentDocsFixBanner
              projectName="example-app"
              projectPath="/Users/dev/example-app"
              policy={SAMPLE_AGENT_DOC_POLICY}
              deviations={[makeInstructionSet({ id: "root", relative_dir: "", verdict: "claude_only" })]}
              anyDirty={false}
              onMutated={vi.fn()}
            />,
            { client },
          );
          const trigger = screen.getByRole("button", { name: "Fix layout…" });
          await userEvent.click(trigger);
          const dialog = await screen.findByRole("dialog", { name: "Fix layout — example-app" });
          return {
            dialog,
            trigger,
            close: backdropClose(dialog),
            assertClosed: () => expect(screen.queryByRole("dialog")).toBeNull(),
          };
        },
        known: {
          escape: "no Escape handler — only the backdrop onClick calls setPlanOpen(false)",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented",
        },
      },
      {
        name: "Compare… (divergent-root dialog)",
        render: async () => {
          withCommands({
            read_agent_doc: (rawArgs) => {
              const a = rawArgs as { relativePath?: string } | undefined;
              return {
                rel: a?.relativePath ?? "",
                absolute_path: `/p/${a?.relativePath ?? ""}`,
                content: "hi",
                size: 2,
                modified_at: null,
                hash: "h",
                is_symlink: false,
                symlink_to: null,
              };
            },
          });
          const client = newClient();
          renderWithProviders(
            <AgentDocsFixBanner
              projectName="example-app"
              projectPath="/Users/dev/example-app"
              policy={SAMPLE_AGENT_DOC_POLICY}
              deviations={[makeInstructionSet({ id: "root", relative_dir: "", verdict: "conflict" })]}
              anyDirty={false}
              onMutated={vi.fn()}
            />,
            { client },
          );
          const trigger = screen.getByRole("button", { name: "Compare…" });
          await userEvent.click(trigger);
          const dialog = await screen.findByRole("dialog", { name: "Divergent root files — example-app" });
          return {
            dialog,
            trigger,
            close: backdropClose(dialog),
            assertClosed: () => expect(screen.queryByRole("dialog")).toBeNull(),
          };
        },
        known: {
          escape: "no Escape handler — only the backdrop onClick calls setCompareOpen(false)",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented",
        },
      },
      {
        name: "Resolve… (pointer-plus-content dialog)",
        render: async () => {
          const client = newClient();
          renderWithProviders(
            <AgentDocsFixBanner
              projectName="example-app"
              projectPath="/Users/dev/example-app"
              policy={SAMPLE_AGENT_DOC_POLICY}
              deviations={[
                makeInstructionSet({ id: "root", relative_dir: "", verdict: "pointer_plus_content" }),
              ]}
              anyDirty={false}
              onMutated={vi.fn()}
            />,
            { client },
          );
          const trigger = screen.getByRole("button", { name: "Resolve…" });
          await userEvent.click(trigger);
          const dialog = await screen.findByRole("dialog", { name: "Move appendix into AGENTS.md" });
          return {
            dialog,
            trigger,
            close: backdropClose(dialog),
            assertClosed: () => expect(screen.queryByRole("dialog")).toBeNull(),
          };
        },
        known: {
          escape: "no Escape handler — only the backdrop onClick calls setAbsorbOpen(false)",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented",
        },
      },
    ],
  },
  {
    file: "components/AdoptionDialog.tsx",
    name: "AdoptionDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "AdoptionDialog",
        render: async () => {
          const onResolved = vi.fn();
          const discovered = {
            "claude-code": [{ pattern: "Bash(npm:*)", kind: "allow" as const, source_file: "~/.claude/settings.json" }],
          };
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={vi.fn()}
              render={(open) => <AdoptionDialog open={open} discovered={discovered} onResolved={onResolved} />}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          // No close path exists to prove — see `known` below.
          return { dialog, trigger, assertClosed: () => expect(onResolved).toHaveBeenCalled() };
        },
        known: {
          escape: "no Escape handler at all — the dialog exposes no close/cancel action, only Skip/Replace/Import",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented (and no close path to restore from)",
        },
      },
    ],
  },
  {
    file: "components/CommandPalette.tsx",
    name: "CommandPalette",
    expectedOpenings: 2,
    variants: [
      {
        name: "CommandPalette",
        render: async () => {
          const client = newClient();
          renderWithProviders(
            <>
              <OpenerButton onOpen={() => useAppStore.getState().openPalette()} />
              <CommandPalette />
            </>,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Command palette" });
          const escapeTarget = within(dialog).getByRole("textbox");
          return {
            dialog,
            trigger,
            escapeTarget,
            assertClosed: () => expect(useAppStore.getState().paletteOpen).toBe(false),
          };
        },
        known: {
          restore:
            "no focus-restore implemented — closing leaves focus on <body>, not the opener",
          trap:
            "only one focusable element (the search input; results are role=\"option\" divs, not tab stops) " +
            "and no Tab handling, so Tab/Shift+Tab leave the dialog instead of staying put",
        },
      },
    ],
  },
  {
    file: "components/agentDocs/AgentDocModal.tsx",
    name: "AgentDocModal",
    expectedOpenings: 1,
    variants: [
      {
        // Rendered directly with its own props (exported, no `open` gate) —
        // its two real call sites in AgentDocsView.tsx (`pendingDiscard`,
        // `conflict`) each need a buffer write race to open, which is the
        // same CodeMirror/real-input barrier as the SkillEditor row above;
        // testing the component directly sidesteps that without losing
        // coverage of AgentDocModal's own (missing) mechanics.
        name: "AgentDocModal",
        render: async () => {
          const onClose = vi.fn();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => (
                <AgentDocModal
                  title="Discard unsaved edits?"
                  onClose={close}
                  actions={
                    <button type="button" onClick={close}>
                      Cancel
                    </button>
                  }
                >
                  <p>Body</p>
                </AgentDocModal>
              )}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Discard unsaved edits?" });
          return {
            dialog,
            trigger,
            close: backdropClose(dialog),
            assertClosed: () => expect(onClose).toHaveBeenCalled(),
          };
        },
        known: {
          escape: "no Escape handler — only the backdrop onClick calls onClose",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented",
        },
      },
    ],
  },
  {
    file: "components/snippets/ApplyToDialog.tsx",
    name: "ApplyToDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "ApplyToDialog",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => (
                <ApplyToDialog snippetName="my-snippet" locations={[]} onClose={close} onApply={vi.fn()} />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Apply my-snippet" });
          return {
            dialog,
            trigger,
            close: backdropClose(dialog),
            assertClosed: () => expect(onClose).toHaveBeenCalled(),
          };
        },
        known: {
          escape: "no Escape handler — only the backdrop onClick calls onClose",
          trap: "no focus trap implemented",
          restore: "no focus-restore implemented",
        },
      },
    ],
  },];
