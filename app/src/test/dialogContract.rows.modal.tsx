// ─── DIALOGS rows: the 21 `<Modal` users (plan unit A5b) ──────────────────
//
// Split out of `dialogContract.test.tsx` (componentSizeGuard's 1000-line
// ceiling). The scanner, `VIA_PRIMITIVE`, the presence checks and the case
// loop (`runDialogRow`) all stay in `dialogContract.test.tsx`; this file only
// supplies the row table for the direct `<Modal` users, so it needs no
// scanner logic of its own. See that file's header comment for the contract
// each row proves.

import { useState } from "react";
import { expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useAppStore } from "@/store";
import { Modal, ConfirmDialog, Sheet } from "@/components/Modal";
import { AddProjectSheet } from "@/components/AddProjectSheet";
import { SkillPickerModal } from "@/components/companions/SkillPickerModal";
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { FeedbackButton, FeedbackDialog } from "@/components/FeedbackDialog";
import { HarnessManagePopover } from "@/components/harness/HarnessManagePopover";
import { ImportMergeDialog } from "@/components/ImportMergeDialog";
import { McpPermissionSheet } from "@/components/mcp/McpPermissionSheet";
import { SideAttention } from "@/components/nav/SideAttention";
import { PermissionsDoctorPanel } from "@/components/PermissionsDoctorPanel";
import { ProjectRepositoryDialog } from "@/components/ProjectRepositoryDialog";
import { RemoveProjectDialog } from "@/components/RemoveProjectDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { ShortcutCheatsheet } from "@/components/ShortcutCheatsheet";
import { RenameRefsDialog } from "@/components/skillEditor/RenameRefsDialog";
import { AddSourceModal } from "@/screens/sources/AddSourceModal";
import { AddSourceToBundleModal } from "@/screens/sources/AddSourceToBundleModal";
import { BundleFromSourceModal } from "@/screens/sources/BundleFromSourceModal";
import { RenameSourceModal } from "@/screens/sources/RenameSourceModal";
import { UsagePeriodModal } from "@/screens/usage/UsagePeriodModal";

import { renderWithProviders, sampleRegistry } from "./helpers";
import type { UseRenameCascade } from "@/hooks/useRenameCascade";
import type { RenamePlan } from "@/types/renameRefs";
import type { NormalizedPermissions } from "@/types/permissions";
import type { AttentionLine } from "@/lib/navAttention";
import {
  ControlledOpen,
  ControlledMount,
  OpenerButton,
  openViaTrigger,
  newClient,
  withCommands,
  sampleSource,
  type DialogRow,
} from "./dialogContract.helpers";

export const MODAL_ROWS: DialogRow[] = [
  {
    file: "components/AddProjectSheet.tsx",
    name: "AddProjectSheet",
    expectedOpenings: 1,
    variants: [
      {
        name: "AddProjectSheet",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => <AddProjectSheet open={open} onClose={close} />}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Add project" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/companions/SkillPickerModal.tsx",
    name: "SkillPickerModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "SkillPickerModal",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <SkillPickerModal
                  open={open}
                  target={{ kind: "hook", name: "pre-commit" }}
                  onPick={vi.fn()}
                  onClose={close}
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Ship this with a skill…" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/EditProjectPathDialog.tsx",
    name: "EditProjectPathDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "EditProjectPathDialog",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <EditProjectPathDialog
                  open={open}
                  onClose={close}
                  projectName="example-app"
                  currentPath="/Users/dev/example-app"
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Edit path for example-app" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/FeedbackDialog.tsx",
    name: "FeedbackDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "FeedbackDialog",
        render: async () => {
          const client = newClient();
          const context = { screen: "library", tab: "none", appVersion: "0.0.0-test", os: "linux" } as const;
          renderWithProviders(
            <>
              <FeedbackButton context={context} />
              <FeedbackDialog context={context} />
            </>,
            { client },
          );
          const trigger = screen.getByRole("button", { name: "Feedback" });
          await userEvent.click(trigger);
          const dialog = await screen.findByRole("dialog", { name: "Feedback" });
          return {
            dialog,
            trigger,
            assertClosed: () => expect(useAppStore.getState().feedbackOpen).toBe(false),
          };
        },
      },
    ],
  },
  {
    file: "components/harness/HarnessManagePopover.tsx",
    name: "HarnessManagePopover",
    expectedOpenings: 1,
    variants: [
      {
        name: "HarnessManagePopover",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <HarnessManagePopover
                  open={open}
                  projectName="example-app"
                  projectPath="/Users/dev/example-app"
                  globalHarnesses={[]}
                  projectHarnesses={[]}
                  onClose={close}
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/ImportMergeDialog.tsx",
    name: "ImportMergeDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "ImportMergeDialog",
        render: async () => {
          const onClose = vi.fn();
          withCommands({
            permissions_reconcile_candidates: () => ({
              scope_kind: "global",
              project: null,
              merged: [],
              conflicts: [],
              un_importable: [],
            }),
          });
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <ImportMergeDialog open={open} scope={{ kind: "global" }} onClose={close} onApplied={vi.fn()} />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "Modal restores focus only when `open` flips to false; ImportMergeDialog unmounts the Modal instead (`if (!open) return null` ahead of `<Modal open={open}>`), so the restore effect never runs and focus drops to <body>",
        },
      },
    ],
  },
  {
    file: "components/mcp/McpPermissionSheet.tsx",
    name: "McpPermissionSheet",
    expectedOpenings: 1,
    variants: [
      {
        name: "McpPermissionSheet",
        render: async () => {
          const onClose = vi.fn();
          withCommands({
            hub_cmd: (rawArgs) => {
              const a = (rawArgs as { args?: string[] } | undefined)?.args ?? [];
              if (a[0] === "mcp" && a[1] === "catalog") {
                return { success: true, output: JSON.stringify({ tools: [] }) };
              }
              return { success: true, output: "" };
            },
          });
          const draft: NormalizedPermissions = {
            allow: [],
            deny: [],
            ask: [],
            hooks: [],
            sandbox_mode: null,
            approval_policy: null,
            project_trust: null,
            additional_dirs: [],
            extras: {},
            _unmanaged: [],
          };
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <McpPermissionSheet
                  open={open}
                  server="fs-mcp"
                  scope={{ kind: "global" }}
                  draft={draft}
                  onClose={close}
                  onApply={vi.fn().mockResolvedValue(true)}
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Add MCP permissions" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/Modal.tsx",
    name: "Modal (base) / ConfirmDialog (danger preset) / Sheet (preset)",
    expectedOpenings: 3,
    variants: [
      {
        name: "Modal (base)",
        render: async () => {
          const onClose = vi.fn();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <Modal open={open} onClose={close} title="Test modal">
                  <button type="button">First</button>
                  <button type="button">Second</button>
                </Modal>
              )}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Test modal" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
      {
        // Sheet is a thin `side`/`width` preset over Modal (`return <Modal
        // {...rest} side={side} width={width} />`) — proven here so every
        // VIA_PRIMITIVE entry naming "Sheet" points at a variant that
        // actually exercises it, not just an assumption that it inherits
        // Modal's mechanics.
        name: "Sheet (preset)",
        render: async () => {
          const onClose = vi.fn();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <Sheet open={open} onClose={close} title="Test sheet">
                  <button type="button">First</button>
                  <button type="button">Second</button>
                </Sheet>
              )}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Test sheet" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
      {
        name: "ConfirmDialog (tone=danger)",
        confirmGuard: true,
        render: async () => {
          const onClose = vi.fn();
          const onConfirm = vi.fn();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <ConfirmDialog
                  open={open}
                  onClose={close}
                  onConfirm={onConfirm}
                  title="Remove project?"
                  body="This cannot be undone."
                  tone="danger"
                />
              )}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Remove project?" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled(), onConfirm };
        },
      },
    ],
  },
  {
    file: "components/nav/SideAttention.tsx",
    name: "SideAttention",
    expectedOpenings: 1,
    variants: [
      {
        name: "SideAttention",
        render: async () => {
          const line: AttentionLine = {
            key: "projects.failed",
            tone: "error",
            text: "1 project failed to sync",
            explanation: {
              title: "Project sync failed",
              happened: "The last sync reported errors for these projects.",
              impact: "Their agent folders may not match the selected skills.",
              nextStep: "Open a project to inspect its sync errors.",
              affected: [{ id: "example-app", label: "example-app" }],
            },
          };
          renderWithProviders(<SideAttention lines={[line]} groupLabel="projects" />);
          const trigger = screen.getByRole("button", { name: /1 project failed to sync, show details/i });
          await userEvent.click(trigger);
          const dialog = await screen.findByRole("dialog", { name: "Project sync failed" });
          return {
            dialog,
            trigger,
            assertClosed: () => expect(screen.queryByRole("dialog")).toBeNull(),
          };
        },
      },
    ],
  },
  {
    file: "components/PermissionsDoctorPanel.tsx",
    name: "PermissionsDoctorPanel",
    expectedOpenings: 1,
    variants: [
      {
        name: "PermissionsDoctorPanel",
        render: async () => {
          const onClose = vi.fn();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => <PermissionsDoctorPanel open={open} findings={[]} onClose={close} />}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Permissions doctor" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/ProjectRepositoryDialog.tsx",
    name: "ProjectRepositoryDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "ProjectRepositoryDialog",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <ProjectRepositoryDialog open={open} onClose={close} projectName="example-app" mode="manage" />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/RemoveProjectDialog.tsx",
    name: "RemoveProjectDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "RemoveProjectDialog",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledOpen
              onCloseSpy={onClose}
              render={(open, close) => (
                <RemoveProjectDialog open={open} onClose={close} projectName="example-app" />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
      },
    ],
  },
  {
    file: "components/settings/SettingsDialog.tsx",
    name: "SettingsDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "SettingsDialog",
        render: async () => {
          const client = newClient();
          renderWithProviders(
            <>
              <OpenerButton onOpen={() => useAppStore.getState().openSettings()} />
              <SettingsDialog />
            </>,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Settings" });
          return {
            dialog,
            trigger,
            assertClosed: () => expect(useAppStore.getState().settingsOpen).toBe(false),
          };
        },
      },
    ],
  },
  {
    file: "components/ShortcutCheatsheet.tsx",
    name: "ShortcutCheatsheet",
    expectedOpenings: 1,
    variants: [
      {
        name: "ShortcutCheatsheet",
        render: async () => {
          renderWithProviders(
            <>
              <OpenerButton onOpen={() => useAppStore.getState().openCheatsheet()} />
              <ShortcutCheatsheet />
            </>,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
          return {
            dialog,
            trigger,
            assertClosed: () => expect(useAppStore.getState().cheatsheetOpen).toBe(false),
          };
        },
      },
    ],
  },
  {
    file: "components/skillEditor/RenameRefsDialog.tsx",
    name: "RenameRefsDialog",
    expectedOpenings: 1,
    variants: [
      {
        name: "RenameRefsDialog",
        render: async () => {
          const cancelSpy = vi.fn();
          const samplePlan = {
            dry_run: true,
            old: "brainstorm",
            new: "brainstorm-2",
            referrers: { skills: [], snippets: [], agent_docs: [] },
            skipped: [],
            totals: {
              skills: 0,
              snippets: 0,
              agent_docs: 0,
              projects: 0,
              library_refs: 0,
              agent_doc_refs: 0,
              refs: 0,
              skipped: 0,
              files: 0,
            },
          } as unknown as RenamePlan;
          function Harness() {
            const [phase, setPhase] = useState<UseRenameCascade["phase"]>("idle");
            const cascade: UseRenameCascade = {
              phase,
              plan: samplePlan,
              result: null,
              error: null,
              saveError: null,
              agentDocs: false,
              setAgentDocs: vi.fn(),
              step: 1,
              old: "brainstorm",
              next: "brainstorm-2",
              begin: vi.fn(),
              confirm: vi.fn(),
              cancel: () => {
                setPhase("idle");
                cancelSpy();
              },
              dismiss: vi.fn(),
              stay: vi.fn(),
            };
            return (
              <>
                <OpenerButton onOpen={() => setPhase("review")} />
                <RenameRefsDialog cascade={cascade} onOpenSnippet={vi.fn()} />
              </>
            );
          }
          renderWithProviders(<Harness />);
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Rename brainstorm to brainstorm-2?" });
          return { dialog, trigger, assertClosed: () => expect(cancelSpy).toHaveBeenCalled() };
        },
        known: {
          restore:
            "Modal restores focus only when `open` flips to false; RenameRefsDialog unmounts the Modal instead (`if (phase === \"idle\") return null` ahead of `<Modal>`), so the restore effect never runs and focus drops to <body>",
        },
      },
    ],
  },
  {
    file: "screens/SkillEditor.tsx",
    name: "SkillEditor (\"this file changed on disk\" Modal)",
    expectedOpenings: 3,
    variants: [
      {
        // `SkillEditor` itself is not imported — the variant is
        // `unreachable`, so this body never runs; see the reason.
        name: "conflict Modal",
        render: async () => {
          throw new Error("not reached — the variant is unreachable; see the reason");
        },
        unreachable:
          "opening this Modal needs a real CodeMirror edit (dirty the buffer) then a save that loses an " +
          "optimistic-concurrency check (fileBuffers.conflictRel) — TESTS.md §2 lists CodeMirror editing as a " +
          "real-input reason for a journey test, not vitest; jsdom cannot drive it",
      },
    ],
  },
  {
    file: "screens/sources/AddSourceModal.tsx",
    name: "AddSourceModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "AddSourceModal",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => <AddSourceModal onClose={close} registry={sampleRegistry} />}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog", { name: "Add Git source" });
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "two gaps: an `autoFocus` input takes focus during commit, before Modal's opener effect runs, so Modal " +
              "records that input, not the trigger, as the opener; and Modal restores focus only when `open` flips " +
              "to false, while its host (Sources.tsx) unmounts the Modal instead (`{showAdd && <AddSourceModal …/>}` around `<Modal open>`)",
        },
      },
    ],
  },
  {
    file: "screens/sources/AddSourceToBundleModal.tsx",
    name: "AddSourceToBundleModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "AddSourceToBundleModal",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => (
                <AddSourceToBundleModal
                  source={sampleSource()}
                  registry={sampleRegistry}
                  onClose={close}
                  onCreateBundle={vi.fn()}
                />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "Modal restores focus only when `open` flips to false; its host (Sources.tsx) unmounts the Modal instead (`{addToBundleTarget && …}` around `<Modal open>`), so the restore effect never runs and focus drops to <body>",
        },
      },
    ],
  },
  {
    file: "screens/sources/BundleFromSourceModal.tsx",
    name: "BundleFromSourceModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "BundleFromSourceModal",
        render: async () => {
          const onClose = vi.fn();
          const client = newClient();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => (
                <BundleFromSourceModal source={sampleSource()} registry={sampleRegistry} onClose={close} />
              )}
            />,
            { client },
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "two gaps: an `autoFocus` input takes focus during commit, before Modal's opener effect runs, so Modal " +
              "records that input, not the trigger, as the opener; and Modal restores focus only when `open` flips " +
              "to false, while its host (Sources.tsx) unmounts the Modal instead (`{bundleFromTarget && …}` around `<Modal open>`)",
        },
      },
    ],
  },
  {
    file: "screens/sources/RenameSourceModal.tsx",
    name: "RenameSourceModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "RenameSourceModal",
        render: async () => {
          const onClose = vi.fn();
          renderWithProviders(
            <ControlledMount
              onCloseSpy={onClose}
              render={(close) => (
                <RenameSourceModal source={sampleSource()} onClose={close} onSubmit={vi.fn()} />
              )}
            />,
          );
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onClose).toHaveBeenCalled() };
        },
        known: {
          restore:
            "two gaps: an `autoFocus` input takes focus during commit, before Modal's opener effect runs, so Modal " +
              "records that input, not the trigger, as the opener; and Modal restores focus only when `open` flips " +
              "to false, while its host (Sources.tsx) unmounts the Modal instead (`{renameTarget && …}` around `<Modal open>`)",
        },
      },
    ],
  },
  {
    file: "screens/usage/UsagePeriodModal.tsx",
    name: "UsagePeriodModal",
    expectedOpenings: 1,
    variants: [
      {
        name: "UsagePeriodModal",
        render: async () => {
          const onCloseSpy = vi.fn();
          const client = newClient();
          function Harness() {
            const [period, setPeriod] = useState<{ kind: "day"; key: string; since: string; until: string } | null>(
              null,
            );
            return (
              <>
                <OpenerButton
                  onOpen={() => setPeriod({ kind: "day", key: "2026-01-15", since: "2026-01-15", until: "2026-01-15" })}
                />
                <UsagePeriodModal
                  period={period}
                  onPeriodChange={vi.fn()}
                  onClose={() => {
                    setPeriod(null);
                    onCloseSpy();
                  }}
                  firstDay="2026-01-01"
                  lastDay="2026-01-31"
                  daily={[]}
                  sessions={[]}
                  dailyReady
                  dailyError={false}
                  sessionsAvailable
                  scanned
                  harness={null}
                  harnessName="Claude Code"
                  currency="USD"
                  eurRate={1}
                  onInspect={vi.fn()}
                />
              </>
            );
          }
          renderWithProviders(<Harness />, { client });
          const trigger = await openViaTrigger();
          const dialog = await screen.findByRole("dialog");
          return { dialog, trigger, assertClosed: () => expect(onCloseSpy).toHaveBeenCalled() };
        },
      },
    ],
  },];
