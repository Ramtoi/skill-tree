import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

beforeEach(() => useAppStore.setState({ degradedMode: false, settingsOpen: true, settingsCategory: "worktrees" }));

it("retains a worktree draft across categories and discards it locally", async () => {
  renderWithProviders(<SettingsDialog />);
  const user = userEvent.setup();
  const access = await screen.findByRole("checkbox", { name: "Enable agent access for new projects" });
  await user.click(access);
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.click(screen.getByRole("button", { name: /^Worktrees/ }));
  expect(await screen.findByRole("checkbox", { name: "Enable agent access for new projects" })).toBeChecked();
  await user.keyboard("{Escape}");
  expect(screen.getByText("Discard unsaved settings?")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(useAppStore.getState().settingsOpen).toBe(false);
  expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "hub_cmd" &&
    (args as { args: string[] }).args[2] === "set")).toBe(false);

  // The dialog component stays mounted while closed; a kept worktreeDraft
  // would otherwise survive to the next open, reopened directly (not just
  // rendered once), and re-check the discarded field.
  await act(async () => { useAppStore.setState({ settingsOpen: true }); });
  expect(await screen.findByRole("checkbox", { name: "Enable agent access for new projects" })).not.toBeChecked();
});

it("saves the backup inclusion choice with defaults without starting backup or Sync", async () => {
  renderWithProviders(<SettingsDialog />);
  const user = userEvent.setup();
  const toggle = await screen.findByRole("checkbox", { name: "Include worktree defaults in backups" });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  const save = screen.getByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await screen.findByText(/Defaults saved for future projects/);
  const calls = vi.mocked(invoke).mock.calls;
  const write = calls.find(([cmd, args]) => cmd === "hub_cmd" && (args as { args: string[] }).args[2] === "set");
  expect(JSON.parse((write![1] as { args: string[] }).args[4]).include_in_backup).toBe(true);
  expect(calls.some(([cmd, args]) => ["backup_now", "backup_enable", "backup_init", "sync"].includes(cmd) ||
    cmd === "hub_cmd" && (args as { args: string[] }).args[0] === "sync")).toBe(false);
});

it("keeps a failed worktree write available for retry", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let failed = false;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "hub_cmd" && (args as { args: string[] }).args[2] === "set" && !failed) {
      failed = true;
      throw new Error("write unavailable");
    }
    return fallback(cmd, args);
  });
  renderWithProviders(<SettingsDialog />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox", { name: "Include worktree defaults in backups" }));
  const save = screen.getByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await screen.findByText(/write unavailable/);
  expect(screen.getByRole("checkbox", { name: "Include worktree defaults in backups" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Retry save defaults" }));
  await screen.findByText(/Defaults saved for future projects/);
});

it("keeps a pending write alive while another category stays readable", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "hub_cmd" && (args as { args: string[] }).args[2] === "set") {
      await new Promise<void>((resolve) => { finish = resolve; });
    }
    return fallback(cmd, args);
  });
  renderWithProviders(<SettingsDialog />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox", { name: "Include worktree defaults in backups" }));
  const save = screen.getByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Saving Worktrees settings");
  expect(screen.getByRole("checkbox", { name: "Show navigator" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: /^Worktrees/ }));
  expect(screen.getByRole("checkbox", { name: "Include worktree defaults in backups" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.keyboard("{Escape}");
  expect(useAppStore.getState().settingsOpen).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Show navigator" })).toBeEnabled());
  await user.keyboard("{Escape}");
  expect(useAppStore.getState().settingsOpen).toBe(false);
});
