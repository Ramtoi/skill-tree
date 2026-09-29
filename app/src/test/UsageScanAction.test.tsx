import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { ScanButton } from "@/screens/usage/UsageScanAction";
import { Processes } from "@/store/processes";
import { renderWithProviders } from "./helpers";
import type { UsageScanResult } from "@/features/usage/usageAnalyticsTypes";

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

/** `result` may be a plain payload (resolves immediately) or a thunk
 *  returning a promise (so a test can hold the scan open and resolve it on
 *  its own schedule, to observe the in-flight busy state). */
function mockScan(result: UsageScanResult | (() => Promise<UsageScanResult>)) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "hub_cmd") {
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "scan-sessions") {
        const payload = typeof result === "function" ? await result() : result;
        return { success: true, output: JSON.stringify(payload) };
      }
      return { success: true, output: "" };
    }
    return undefined;
  });
}

describe("ScanButton / useScanBusy / useLastScanResult", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    // Clear leftover process cards a previous test in this file left running
    // or settled — `Processes` is a module-level Zustand store, shared
    // across every test in this file.
    for (const p of Processes.list()) Processes.dismiss(p.id);
  });

  it("fires the scan mutation on click", async () => {
    mockScan(scanResult());
    renderWithProviders(<ScanButton />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));

    await waitFor(() => {
      const calls = vi
        .mocked(invoke)
        .mock.calls.filter(
          ([cmd, args]) =>
            cmd === "hub_cmd" &&
            ((args as { args?: string[] } | undefined)?.args ?? [])[1] === "scan-sessions",
        );
      expect(calls).toHaveLength(1);
    });
  });

  it("supports a custom label (the empty state's `Scan now`, a `Try again`)", () => {
    mockScan(scanResult());
    renderWithProviders(<ScanButton variant="primary">Scan now</ScanButton>);
    expect(screen.getByRole("button", { name: "Scan now" })).toBeInTheDocument();
  });

  it("awaits before before starting the transcript scan", async () => {
    const order: string[] = [];
    let releaseBefore: (() => void) | undefined;
    const before = () => {
      order.push("before-start");
      return new Promise<void>((resolve) => {
        releaseBefore = () => {
          order.push("before-end");
          resolve();
        };
      });
    };
    mockScan(scanResult());
    renderWithProviders(<ScanButton before={before} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(order).toEqual(["before-start"]));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("hub_cmd", expect.anything());
    releaseBefore?.();
    await waitFor(() => expect(order).toEqual(["before-start", "before-end"]));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "hub_cmd")).toBe(true));
  });

  it("still starts the transcript scan when before rejects", async () => {
    mockScan(scanResult());
    renderWithProviders(<ScanButton before={async () => { throw new Error("ccusage failed"); }} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "hub_cmd")).toBe(true);
    });
  });

  it("two rendered instances agree about busy, through the shared process-store target (G5)", async () => {
    let resolveScan: (value: UsageScanResult) => void = () => {};
    mockScan(
      () =>
        new Promise<UsageScanResult>((resolve) => {
          resolveScan = resolve;
        }),
    );
    renderWithProviders(
      <>
        <div data-testid="one">
          <ScanButton />
        </div>
        <div data-testid="two">
          <ScanButton />
        </div>
      </>,
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Scan" })[0]);

    await waitFor(() => {
      const [first, second] = screen.getAllByRole("button", { name: "Scan" });
      expect(first).toHaveAttribute("aria-busy", "true");
      expect(second).toHaveAttribute("aria-busy", "true");
    });

    resolveScan(scanResult());

    await waitFor(() => {
      const [first, second] = screen.getAllByRole("button", { name: "Scan" });
      expect(first).not.toHaveAttribute("aria-busy");
      expect(second).not.toHaveAttribute("aria-busy");
    });
  });

  it("fails the process card, naming stopped_on, on a soft {ok: false} result — rows already written are not lost", async () => {
    mockScan(
      scanResult({
        ok: false,
        stopped_on: "2026-09-05.jsonl",
        errors: [{ file: "2026-09-05.jsonl", kind: "parse_error" }],
        rows_written: 4,
      }),
    );
    renderWithProviders(<ScanButton />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));

    await waitFor(() => {
      const failed = Processes.list().find((p) => p.status === "error");
      expect(failed?.body).toContain("2026-09-05.jsonl");
      expect(typeof failed?.retry).toBe("function");
    });
  });

  it("classifies an explicit replan result without exposing a retry", async () => {
    mockScan(
      scanResult({
        ok: false,
        state: "replan_required",
        partial: true,
        scan_id: "scan-1",
        errors: [{ kind: "reader_unavailable", file: "/private/transcript.jsonl" }],
      }),
    );
    renderWithProviders(<ScanButton />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));

    await waitFor(() => {
      const failed = Processes.list().find((p) => p.status === "error");
      expect(failed?.body).toBe(
        "This saved scan cannot continue. A reader required by this scan is unavailable or incompatible. Previously captured results are still available.",
      );
      expect(failed?.retry).toBeNull();
      expect(failed?.body).not.toContain("/private/");
    });
  });

  it("guards two synchronous callers with the shared process target", async () => {
    let release!: (result: UsageScanResult) => void;
    mockScan(() => new Promise<UsageScanResult>((resolve) => { release = resolve; }));
    renderWithProviders(<ScanButton />);
    const button = screen.getByRole("button", { name: "Scan" });

    button.click();
    button.click();

    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls.filter(
        ([cmd, args]) => cmd === "hub_cmd" && ((args as { args?: string[] } | undefined)?.args ?? [])[1] === "scan-sessions",
      );
      expect(calls).toHaveLength(1);
    });
    release(scanResult());
  });
});
