import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, renderHook, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import { useBackupNow } from "@/hooks/useBackup";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import { ProcessTray } from "@/components/loading/ProcessTray";
import { OverflowMenu } from "@/components/OverflowMenu";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import {
  makeQueryClient,
  primeRegistry,
  renderWithProviders,
  sampleRegistry,
} from "./helpers";

// ─── The behaviour the coherence pass bought ────────────────────────────────
//
// A control that fires a live process must (a) look busy while it runs and
// (b) report itself through the ONE banner — the process tray — no matter
// which surface fired it. Both were broken in ways a user hit:
//
//   · The project header's Sync button had no busy state at all. Clicking it
//     looked like nothing happened, so the natural move was to click again —
//     and the second `hub sync` lost the backend `.lock`, which surfaced as a
//     failure for a run that had in fact succeeded.
//   · A backup push (a git round-trip to GitHub) had a busy button but no
//     card, so navigating away made the work invisible.

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** The suite-wide default `invoke` (installed by `test/setup.ts`'s own
 *  beforeEach, which runs first). Captured so a per-test override can answer
 *  the ONE command it cares about and let every other screen query fall
 *  through — resetting the mock outright left ProjectWorkspace with no
 *  registry and rendering its empty state. */
let fallback: (cmd: string, args?: unknown) => Promise<unknown>;

/** Override one command; everything else keeps the suite defaults. */
function overrideInvoke(
  impl: (cmd: string, args?: unknown) => Promise<unknown> | undefined,
) {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
    const hit = impl(cmd, args);
    return hit === undefined ? fallback(cmd, args) : await hit;
  }) as never);
}

beforeEach(() => {
  for (const p of Processes.list()) Processes.dismiss(p.id);
  useAppStore.setState({ toasts: [], syncStatus: "idle" });
  fallback = vi.mocked(invoke).getMockImplementation() as typeof fallback;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one banner — every live process opens a card", () => {
  it("a registry sync fired from ANY surface opens a process card", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    overrideInvoke((cmd) => {
      if (cmd === "hub_cmd")
        return gate.then(() => ({ success: true, output: "", stdout: "", stderr: "" }));
      if (cmd === "sync_report") return Promise.resolve(null);
      return undefined;
    });

    const { result } = renderHook(() => useRunSync(), { wrapper });
    render(<ProcessTray />);

    let done!: Promise<void>;
    act(() => {
      done = result.current();
    });

    // The card is the banner: it names the work while it is still running.
    expect(await screen.findByText("Registry sync")).toBeInTheDocument();

    await act(async () => {
      release();
      await done;
    });
  });

  it("a backup push opens a card, and a REFUSED publish fails it rather than going green", async () => {
    overrideInvoke((cmd) => {
      // hub reports a refused publish in the PAYLOAD, not by throwing — the
      // exact shape that used to render as a successful backup.
      if (cmd === "backup_now")
        return Promise.resolve({
          ok: false,
          error: "a token was found in the snapshot",
          error_kind: "secret_leak",
          pushed: false,
          committed: false,
          conflict: false,
        });
      return undefined;
    });

    const { result } = renderHook(() => useBackupNow(), { wrapper });
    render(<ProcessTray />);

    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    await waitFor(() => {
      const card = screen.getByText("Backing up").closest(".lds-proc");
      expect(card).toHaveAttribute("data-status", "error");
    });
    expect(
      screen.getByText(/Refused to publish — a token was found/),
    ).toBeInTheDocument();
  });
});

describe("one busy state — the shared sync signal", () => {
  it("`useSyncing` is true only while the sync runs, not while its result lingers", async () => {
    const { result } = renderHook(() => useSyncing(), { wrapper });
    expect(result.current).toBe(false);

    act(() => useAppStore.getState().setSyncStatus("syncing"));
    expect(result.current).toBe(true);

    // "synced" parks in the store for 4s so the StatusBar can show the result.
    // That is a RESULT, not work in flight — a button reading it as busy would
    // stay disabled for four seconds after the work finished.
    act(() => useAppStore.getState().setSyncStatus("synced"));
    expect(result.current).toBe(false);
  });
});

describe("one busy state — menu rows use the same grammar as buttons", () => {
  it("a busy overflow row swaps to a spinner, disables, and exposes aria-busy", async () => {
    const onClick = vi.fn();
    render(
      <OverflowMenu
        items={[{ icon: "refresh", label: "Sync registry", busy: true, onClick }]}
      />,
    );
    await userEvent.click(screen.getByTestId("overflow-trigger"));

    const row = screen.getByRole("menuitem", { name: /Sync registry/ });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("aria-busy", "true");
    expect(row.querySelector(".lds-spinner")).toBeTruthy();

    await userEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("an idle row keeps its icon and stays clickable", async () => {
    const onClick = vi.fn();
    render(
      <OverflowMenu items={[{ icon: "refresh", label: "Sync registry", onClick }]} />,
    );
    await userEvent.click(screen.getByTestId("overflow-trigger"));

    const row = screen.getByRole("menuitem", { name: /Sync registry/ });
    expect(row).not.toBeDisabled();
    expect(row).not.toHaveAttribute("aria-busy");

    await userEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("the project header's Sync button — the defect that started this", () => {
  it("goes busy and refuses a second click while `hub sync` is still writing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let syncCalls = 0;
    overrideInvoke((cmd, args) => {
      if (cmd === "hub_cmd") {
        const argv = (args as { args?: string[] } | undefined)?.args ?? [];
        if (argv[0] === "sync") {
          syncCalls++;
          return gate.then(() => ({ success: true, output: "", stdout: "", stderr: "" }));
        }
        return undefined;
      }
      if (cmd === "sync_report") return Promise.resolve(null);
      return undefined;
    });

    useAppStore.setState({
      harnesses: [
        {
          id: "claude-code",
          label: "Claude Code",
          installed: true,
          on_globally: true,
          used_by_projects: [],
        },
      ],
    });
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    renderWithProviders(
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
      </Routes>,
      { client, initialRoute: "/project/example-app" },
    );

    const sync = await screen.findByRole("button", { name: /^Sync$/ });
    await userEvent.click(sync);

    // The button says so itself — not just the status bar three metres away.
    const busy = await screen.findByRole("button", { name: /Syncing…/ });
    expect(busy).toHaveAttribute("aria-busy", "true");

    // The second click is the one that used to lose the backend .lock and
    // report a failure for a run that had actually succeeded.
    await userEvent.click(busy);
    expect(syncCalls).toBe(1);

    // …and the Sync stat card reports the WORK, not the last verdict. Leaving
    // a green "in sync" up while the button, the status bar and the process
    // card all say "syncing" is four readings of one event, one of them
    // contradicting the other three.
    expect(screen.getByText("syncing…")).toBeInTheDocument();
    expect(screen.queryByText("in sync")).not.toBeInTheDocument();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().syncStatus).not.toBe("syncing"));
  });
});
