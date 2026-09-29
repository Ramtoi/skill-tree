import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ScanButton } from "@/screens/usage/UsageScanAction";
import { UsageScanRecovery } from "@/screens/usage/UsageScanRecovery";
import { useScanSessions } from "@/hooks/useUsageAnalytics";
import type { UsageScanResult } from "@/features/usage/usageAnalyticsTypes";
import { Processes } from "@/store/processes";
import { qk } from "@/lib/queryKeys";
import { makeDeferred, makeQueryClient, renderWithProviders } from "./helpers";

function scanResult(overrides: Partial<UsageScanResult> = {}): UsageScanResult {
  return {
    ok: true,
    rows_written: 8,
    rows_frozen: 2,
    frozen_appended: 0,
    files_scanned: 8,
    files_skipped: 0,
    bytes_read: 2_048,
    sessions_unregistered: 0,
    stopped_on: null,
    errors: [],
    malformed_rows_dropped: 0,
    last_scan_at: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

describe("UsageScanRecovery", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    for (const process of Processes.list()) Processes.dismiss(process.id);
  });

  it("offers one fresh transcript pass, clears after success, and never runs ccusage", async () => {
    let scans = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const command = (args as { args?: string[] } | undefined)?.args ?? [];
      if (command[0] !== "usage" || command[1] !== "scan-sessions") return { success: true, output: "" };
      scans += 1;
      return {
        success: true,
        output: JSON.stringify(scans === 1
          ? scanResult({ ok: false, state: "replan_required", partial: true, scan_id: "scan-1", errors: [{ kind: "reader_unavailable" }] })
          : scanResult()),
      };
    });

    renderWithProviders(
      <>
        <div className="main-header-right"><ScanButton /></div>
        <UsageScanRecovery />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This saved scan cannot continue");
    expect(alert).toHaveTextContent("Previously captured results are still available.");
    expect(alert).not.toHaveTextContent("scan-1");
    expect(alert).not.toHaveTextContent("reader_unavailable");

    const recoveryButton = within(alert).getByRole("button", { name: "Start new scan" });
    recoveryButton.focus();
    await userEvent.click(recoveryButton);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Scan" })).toHaveFocus();

    const scanCalls = vi.mocked(invoke).mock.calls
      .map(([, args]) => (args as { args?: string[] } | undefined)?.args ?? [])
      .filter((command) => command[0] === "usage" && command[1] === "scan-sessions");
    expect(scanCalls).toEqual([
      ["usage", "scan-sessions", "--json"],
      ["usage", "scan-sessions", "--json"],
    ]);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "usage_scan_ccusage")).toBe(false);
  });

  it("keeps a repeated replan actionable", async () => {
    // `toBeEnabled()` alone does not prove the click still runs: a soft
    // disable (Button's `disabledReason` path) leaves the native `disabled`
    // attribute false and only swallows the click in its own handler. Count
    // the actual scan-sessions calls so a click that gets silently eaten
    // still fails this test.
    let scanCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const command = (args as { args?: string[] } | undefined)?.args ?? [];
      if (command[1] !== "scan-sessions") return { success: true, output: "" };
      scanCalls += 1;
      return { success: true, output: JSON.stringify(scanResult({ ok: false, state: "replan_required" })) };
    });

    renderWithProviders(<><ScanButton /><UsageScanRecovery /></>);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("alert");
    expect(scanCalls).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Start new scan" }));
    await waitFor(() => expect(scanCalls).toBe(2));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start new scan" })).toBeEnabled();
  });

  it("keeps the latest result after five minutes and across a route remount", async () => {
    const client = makeQueryClient();
    const result = scanResult({ ok: false, state: "replan_required" });
    const view = renderWithProviders(<UsageScanRecovery />, { client });
    act(() => {
      client.setQueryData(qk.usageScanRecovery(), result);
    });
    await screen.findByRole("alert");

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      view.unmount();
      renderWithProviders(<UsageScanRecovery />, { client });
      expect(screen.getByRole("alert")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a producer-only result with zero recovery observers", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "hub_cmd") {
          return {
            success: true,
            output: JSON.stringify(scanResult({ ok: false, state: "replan_required" })),
          };
        }
        return undefined;
      });
      let produce!: () => Promise<UsageScanResult>;
      function Producer() {
        const mutation = useScanSessions();
        produce = () => mutation.mutateAsync();
        return null;
      }
      const client = makeQueryClient();
      const producer = renderWithProviders(<Producer />, { client });
      await act(async () => {
        await produce();
      });
      producer.unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      });
      renderWithProviders(<UsageScanRecovery />, { client });
      expect(screen.getByRole("alert")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the recovery control focusable while a replacement is pending", async () => {
    const deferred = makeDeferred<{ success: boolean; output: string }>();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "hub_cmd") return deferred.promise;
      return undefined;
    });
    const client = makeQueryClient();
    renderWithProviders(<UsageScanRecovery />, { client });
    act(() => {
      client.setQueryData(qk.usageScanRecovery(), scanResult({ ok: false, state: "replan_required" }));
    });
    const button = await screen.findByRole("button", { name: "Start new scan" });
    button.focus();
    await userEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    expect(button.parentElement).toHaveAttribute("aria-busy", "true");
    deferred.resolve({ success: true, output: JSON.stringify(scanResult()) });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not steal focus after a delayed successful replacement", async () => {
    const deferred = makeDeferred<{ success: boolean; output: string }>();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "hub_cmd") return deferred.promise;
      return undefined;
    });
    const client = makeQueryClient();
    renderWithProviders(
      <>
        <div className="main-header-right"><ScanButton /></div>
        <button type="button">Outside task</button>
        <UsageScanRecovery />
      </>,
      { client },
    );
    act(() => {
      client.setQueryData(qk.usageScanRecovery(), scanResult({ ok: false, state: "replan_required" }));
    });
    const recovery = await screen.findByRole("button", { name: "Start new scan" });
    recovery.focus();
    await userEvent.click(recovery);
    await userEvent.click(screen.getByRole("button", { name: "Outside task" }));
    deferred.resolve({ success: true, output: JSON.stringify(scanResult()) });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Outside task" })).toHaveFocus();
  });

  it("waits for a disabled overview header before restoring owned focus", async () => {
    const deferred = makeDeferred<{ success: boolean; output: string }>();
    let enableHeader!: () => void;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "hub_cmd") return deferred.promise;
      return undefined;
    });
    function DelayedOverview() {
      const [busy, setBusy] = useState(true);
      enableHeader = () => setBusy(false);
      return (
        <>
          <div className="main-header-right"><ScanButton busy={busy} /></div>
          <UsageScanRecovery headerBusy={busy} />
        </>
      );
    }

    const client = makeQueryClient();
    renderWithProviders(<DelayedOverview />, { client });
    act(() => {
      client.setQueryData(qk.usageScanRecovery(), scanResult({ ok: false, state: "replan_required" }));
    });
    const recovery = await screen.findByRole("button", { name: "Start new scan" });
    recovery.focus();
    await userEvent.click(recovery);
    deferred.resolve({ success: true, output: JSON.stringify(scanResult()) });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Scan" })).not.toHaveFocus();

    act(() => enableHeader());
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan" })).toHaveFocus());
  });

  it("restores owned focus when the overview header becomes ready after more than ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const deferred = makeDeferred<{ success: boolean; output: string }>();
      let enableHeader!: () => void;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "hub_cmd") return deferred.promise;
        return undefined;
      });
      function DelayedOverview() {
        const [busy, setBusy] = useState(true);
        enableHeader = () => setBusy(false);
        return (
          <>
            <div className="main-header-right"><ScanButton busy={busy} /></div>
            <UsageScanRecovery headerBusy={busy} />
          </>
        );
      }

      const client = makeQueryClient();
      renderWithProviders(<DelayedOverview />, { client });
      act(() => {
        client.setQueryData(qk.usageScanRecovery(), scanResult({ ok: false, state: "replan_required" }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const recovery = screen.getByRole("button", { name: "Start new scan" });
      recovery.focus();
      act(() => recovery.click());
      await act(async () => {
        deferred.resolve({ success: true, output: JSON.stringify(scanResult()) });
        await deferred.promise;
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.queryByRole("alert")).toBeNull();
      const headerScan = screen.getByRole("button", { name: "Scan" });
      expect(headerScan).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_100);
      });
      expect(headerScan).toBeDisabled();
      expect(headerScan).not.toHaveFocus();

      act(() => enableHeader());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(headerScan).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending restore when the route unmounts", async () => {
    const deferred = makeDeferred<{ success: boolean; output: string }>();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "hub_cmd") return deferred.promise;
      return undefined;
    });
    const client = makeQueryClient();
    const view = renderWithProviders(
      <>
        <div className="main-header-right"><ScanButton /></div>
        <UsageScanRecovery />
      </>,
      { client },
    );
    act(() => {
      client.setQueryData(qk.usageScanRecovery(), scanResult({ ok: false, state: "replan_required" }));
    });
    const recovery = await screen.findByRole("button", { name: "Start new scan" });
    recovery.focus();
    await userEvent.click(recovery);
    view.unmount();
    deferred.resolve({ success: true, output: JSON.stringify(scanResult()) });

    renderWithProviders(
      <div className="main-header-right"><ScanButton /></div>,
      { client },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("button", { name: "Scan" })).not.toHaveFocus();
  });
});
