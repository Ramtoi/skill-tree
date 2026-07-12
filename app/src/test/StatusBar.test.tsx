import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { StatusBar } from "@/components/StatusBar";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import {
  renderWithProviders,
  primeRegistry,
  makeQueryClient,
  sampleSyncReportEnvelope,
} from "./helpers";

// The update chip + install flow read from `useUpdate` (real hook is an inert
// no-op outside a Tauri runtime). Mock it so tests can drive update state and
// spy on the install path. Defaults to `idle` so unrelated tests see no chip.
const updateHook = vi.hoisted(() => ({
  current: {
    updateInfo: null as { version: string; notes: string | null } | null,
    updateStatus: "idle" as string,
    updateProgress: 0,
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
  },
}));
vi.mock("@/hooks/useUpdate", () => ({
  useUpdate: () => updateHook.current,
}));

/** An envelope where project `alpha` synced ok but the registry fingerprint has
 *  drifted since (stale, B1-02). */
const staleEnvelope: SyncReportEnvelope = {
  report: {
    ...sampleSyncReportEnvelope.report,
    projects: {
      alpha: { ts: "2026-05-21T16:40:00Z", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] },
    },
  },
  registry_current: { sha256: "DRIFTED-SHA", mtime: 1 },
};

/** An envelope where project `alpha`'s last sync recorded errors (`ok:false`). */
const erroredEnvelope: SyncReportEnvelope = {
  report: {
    ...sampleSyncReportEnvelope.report,
    projects: {
      alpha: {
        ts: "2026-05-21T16:40:00Z",
        ok: false,
        errors: [{ stage: "skills", message: "boom" }],
        writes: 0,
        removed: 0,
        affinity_skips: [],
      },
    },
  },
  registry_current: { sha256: "abc123", mtime: 0 },
};

describe("StatusBar", () => {
  beforeEach(() => {
    updateHook.current = {
      updateInfo: null,
      updateStatus: "idle",
      updateProgress: 0,
      checkForUpdate: vi.fn(),
      installUpdate: vi.fn(),
    };
  });

  it("renders runtime, registry path, counts, version, and palette segments", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    client.setQueryData(["syncReport"], sampleSyncReportEnvelope);
    renderWithProviders(<StatusBar />, { client });

    expect(screen.getByText(/registry · in sync/)).toBeInTheDocument();
    expect(screen.getByText("~/skill-hub")).toBeInTheDocument();
    expect(screen.getByText(/tauri 2.0/)).toBeInTheDocument();
    expect(screen.getByText(/⌘K palette/)).toBeInTheDocument();
  });

  it("shows a neutral 'not synced yet' chip when the report RESOLVED with no report (C2)", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    // A RESOLVED envelope with a null report = a real install that has never
    // synced (distinct from the still-loading case below).
    client.setQueryData(["syncReport"], { report: null, registry_current: null });
    const { container } = renderWithProviders(<StatusBar />, { client });

    expect(screen.getByText(/registry · not synced yet/)).toBeInTheDocument();
    expect(screen.queryByText(/registry · in sync/)).not.toBeInTheDocument();
    const chip = container.querySelector(".sync-chip[data-state='unknown']");
    expect(chip).not.toBeNull();
    // Reuses the existing neutral freshness dot — no filled green claim.
    expect(chip?.querySelector(".fresh-dot[data-state='unknown']")).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='ok']")).toBeNull();
  });

  it("shows a neutral 'checking…' chip (not 'not synced yet') while the report query is pending", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    // No ["syncReport"] data primed → the query is still pending (envelope
    // undefined). Must NOT assert 'not synced yet' — that's a cold-load flash.
    const { container } = renderWithProviders(<StatusBar />, { client });

    expect(screen.getByText(/registry · checking…/)).toBeInTheDocument();
    expect(screen.queryByText(/registry · not synced yet/)).not.toBeInTheDocument();
    const chip = container.querySelector(".sync-chip[data-state='unknown']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".fresh-dot[data-state='unknown']")).not.toBeNull();
  });

  it("still shows the green 'in sync' chip once a sync report exists", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    client.setQueryData(["syncReport"], sampleSyncReportEnvelope);
    const { container } = renderWithProviders(<StatusBar />, { client });

    const chip = container.querySelector(".sync-chip[data-state='ok']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='ok']")).not.toBeNull();
  });

  it("reflects STALE (registry changed) when ≥1 project's fingerprint drifted (B1-02)", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    client.setQueryData(["syncReport"], staleEnvelope);
    const { container } = renderWithProviders(<StatusBar />, { client });

    // Not the "in sync" claim — the chip must own the drift.
    expect(screen.queryByText(/registry · in sync/)).not.toBeInTheDocument();
    expect(screen.getByText(/registry changed — re-sync/)).toBeInTheDocument();
    const chip = container.querySelector(".sync-chip[data-state='stale']");
    expect(chip).not.toBeNull();
    // Stale reuses the neutral pulsing freshness ring, not a filled sync-dot.
    expect(chip?.querySelector(".fresh-dot[data-state='stale']")).not.toBeNull();
    expect(chip?.querySelector(".sync-dot")).toBeNull();
  });

  it("reflects ERROR when a project's last sync recorded errors (B1-02)", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    client.setQueryData(["syncReport"], erroredEnvelope);
    const { container } = renderWithProviders(<StatusBar />, { client });

    expect(screen.queryByText(/registry · in sync/)).not.toBeInTheDocument();
    expect(screen.getByText(/registry · last sync failed/)).toBeInTheDocument();
    const chip = container.querySelector(".sync-chip[data-state='error']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='error']")).not.toBeNull();
  });

  it("preserves the green 'in sync' chip for a fresh envelope (all projects current)", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const freshEnvelope: SyncReportEnvelope = {
      report: {
        ...sampleSyncReportEnvelope.report,
        projects: {
          alpha: { ts: "2026-05-21T16:40:00Z", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] },
        },
      },
      // registry_current matches the recorded registry_sha256 ("abc123").
      registry_current: { sha256: "abc123", mtime: 0 },
    };
    client.setQueryData(["syncReport"], freshEnvelope);
    const { container } = renderWithProviders(<StatusBar />, { client });

    expect(screen.getByText(/registry · in sync/)).toBeInTheDocument();
    const chip = container.querySelector(".sync-chip[data-state='ok']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='ok']")).not.toBeNull();
  });

  it("clicking the update chip opens a ConfirmDialog (NOT window.confirm); confirming installs (B1-03)", async () => {
    const installUpdate = vi.fn();
    updateHook.current = {
      updateInfo: { version: "9.9.9", notes: null },
      updateStatus: "available",
      updateProgress: 0,
      checkForUpdate: vi.fn(),
      installUpdate,
    };
    const confirmSpy = vi.spyOn(window, "confirm");
    const client = makeQueryClient();
    primeRegistry(client);
    client.setQueryData(["syncReport"], sampleSyncReportEnvelope);
    renderWithProviders(<StatusBar />, { client });

    await userEvent.click(screen.getByRole("button", { name: /↑ v9\.9\.9/ }));

    // The app's confirm primitive, not the native blocking dialog.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(installUpdate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Download & restart/i }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    // The dialog closes on confirm.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("clicking the palette segment opens the command palette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<StatusBar />, { client });

    await userEvent.click(screen.getByRole("button", { name: /⌘K palette/ }));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });

  it("the registry chip opens the sync-report drawer with a Sync now action", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ syncStatus: "idle" });
    vi.mocked(invoke).mockClear();
    renderWithProviders(<StatusBar />, { client });

    const chip = screen.getByTitle("Show sync report");
    await userEvent.click(chip);

    // Drawer opens with the honest empty state (no report) + a Sync now button.
    const drawer = document.querySelector(".sync-report-drawer");
    expect(drawer).not.toBeNull();
    const syncNow = screen.getByRole("button", { name: /Sync now/i });
    await userEvent.click(syncNow);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("hub_cmd", { args: ["sync"] }),
    );
  });

  it("the sync chip reflects the syncing state with a non-color dot", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ syncStatus: "syncing" });
    const { container } = renderWithProviders(<StatusBar />, { client });
    const chip = container.querySelector(".sync-chip[data-state='syncing']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='syncing']")).not.toBeNull();
    useAppStore.setState({ syncStatus: "idle" });
  });

  it("flips to error state when python check fails", () => {
    const client = makeQueryClient();
    client.setQueryData(["registry"], {
      version: "1",
      hub_path: "~/skill-hub",
      skills: {},
      projects: {},
      bundles: {},
    });
    client.setQueryData(["python"], { ok: false, reason: "no-python", detail: null, python: null });

    const { container } = renderWithProviders(<StatusBar />, { client });
    expect(screen.getByText(/python 3: not found/)).toBeInTheDocument();
    const errSeg = container.querySelector(".status-segment[data-state='error']");
    expect(errSeg).not.toBeNull();
  });

  it("shows the working segment while a process runs, hiding the idle label", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const id = Processes.start({ title: "Registry sync", body: "writing", kind: "local" });
    try {
      const { container } = renderWithProviders(<StatusBar />, { client });
      expect(container.querySelector(".lds-status-working")).not.toBeNull();
      expect(screen.queryByText(/registry · in sync/)).not.toBeInTheDocument();
    } finally {
      Processes.dismiss(id);
    }
  });

  it("yields to a python error even when a process is running", () => {
    const client = makeQueryClient();
    client.setQueryData(["registry"], {
      version: "1",
      hub_path: "~/skill-hub",
      skills: {},
      projects: {},
      bundles: {},
    });
    client.setQueryData(["python"], { ok: false, reason: "no-python", detail: null, python: null });
    const id = Processes.start({ title: "Registry sync", kind: "local" });
    try {
      const { container } = renderWithProviders(<StatusBar />, { client });
      expect(screen.getByText(/python 3: not found/)).toBeInTheDocument();
      expect(container.querySelector(".lds-status-working")).toBeNull();
    } finally {
      Processes.dismiss(id);
    }
  });
});
