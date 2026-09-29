import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { BackupSettings } from "@/components/settings/BackupSettings";
import type { BackupStatus } from "@/lib/backupContract";
import { renderWithProviders } from "./helpers";

function status(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    enabled: true,
    initialized: true,
    configured: true,
    dir: "~/.skill-hub-backup",
    remote: "git@github.com:me/skill-tree-backup.git",
    repo: "me/skill-tree-backup",
    branch: "main",
    auth: {
      configured: "auto",
      pat_available: false,
      pat_detail: "",
      gh_login: "me",
      gh_active_login: "me",
      gh_account_mismatch: false,
    },
    push_failures: 0,
    last_push_error: null,
    pending_reconcile: false,
    last_commit: { sha: "abc123", ts: "2026-09-16T10:00:00Z", subject: "snapshot" },
    ahead: 0,
    behind: 0,
    drift: "in-sync",
    manifest: null,
    warnings: [],
    ...over,
  };
}

let calls: string[] = [];

function mockBackup(current: BackupStatus | null, save?: (command: string) => unknown) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    calls.push(command);
    if (command === "backup_status") return current;
    if (command === "backup_enable" || command === "backup_disable") {
      return save?.(command);
    }
    return undefined;
  });
}

function renderSettings(onNavigate = vi.fn()) {
  const onPendingChange = vi.fn();
  renderWithProviders(<BackupSettings onNavigate={onNavigate} onPendingChange={onPendingChange} />);
  return { onNavigate, onPendingChange };
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
});

describe("BackupSettings", () => {
  it("distinguishes an unconfigured destination and keeps setup out of Settings", async () => {
    mockBackup(status({ configured: false, initialized: false, last_commit: null }));
    const { onNavigate } = renderSettings();

    expect(await screen.findByText("Backups are not set up.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Automatic backup after sync" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Set up backup" }));
    expect(onNavigate).toHaveBeenCalledWith("/backup");
    expect(calls.filter((command) => ["backup_init", "backup_now", "sync"].includes(command))).toEqual([]);
  });

  it("shows configured but uninitialized backup without offering an enable write", async () => {
    mockBackup(status({ initialized: false, last_commit: null }));
    renderSettings();

    expect(await screen.findByText(/destination is configured/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Automatic backup after sync" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set up backup" })).toBeInTheDocument();
  });

  it("renders a ready destination and changes only the automatic-backup preference", async () => {
    mockBackup(status());
    renderSettings();

    expect(await screen.findByText("me/skill-tree-backup")).toBeInTheDocument();
    expect(screen.getByText("In sync at last check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage backup" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Automatic backup after sync" }));
    await waitFor(() => expect(calls).toContain("backup_disable"));
    expect(calls.filter((command) => ["backup_init", "backup_now", "sync"].includes(command))).toEqual([]);
  });

  it("explains that pushes are paused after a restore", async () => {
    mockBackup(status({ pending_reconcile: true }));
    renderSettings();
    expect(await screen.findByText(/Remote pushes are paused after a restore/i)).toBeInTheDocument();
  });

  it("offers Retry when reading status fails and does not render editable controls", async () => {
    let reads = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "backup_status") {
        reads += 1;
        if (reads === 1) throw new Error("status unavailable");
        return status();
      }
      return undefined;
    });
    renderSettings();

    expect(await screen.findByRole("alert")).toHaveTextContent(/status unavailable/);
    expect(screen.queryByRole("checkbox", { name: "Automatic backup after sync" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("me/skill-tree-backup")).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("keeps a failed preference write retryable without running backup or Sync", async () => {
    let writes = 0;
    mockBackup(status(), () => {
      writes += 1;
      if (writes === 1) throw new Error("permission denied");
      return undefined;
    });
    renderSettings();

    await userEvent.click(await screen.findByRole("checkbox", { name: "Automatic backup after sync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not save backup settings/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(writes).toBe(2));
    expect(screen.queryByText(/Could not save backup settings/)).not.toBeInTheDocument();
    expect(calls.filter((command) => ["backup_init", "backup_now", "sync"].includes(command))).toEqual([]);
  });
});
