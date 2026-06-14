import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { makeQueryClient, sampleRegistry } from "./helpers";

// App calls getCurrentWindow() for fullscreen tracking — stub the window API.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

function renderApp() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

/** Override the global invoke mock with a per-command map for this test. */
function mockInvoke(map: Record<string, unknown | (() => unknown)>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd in map) {
      const v = map[cmd];
      return typeof v === "function" ? (v as () => unknown)() : v;
    }
    return undefined;
  });
}

const okPreflight = { ok: true, reason: "none", detail: null, python: "/usr/bin/python3" };

describe("onboarding gate routing", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("shows the runtime-status screen (not the Library) when preflight fails", async () => {
    mockInvoke({
      runtime_preflight: { ok: false, reason: "no-python", detail: null, python: null },
    });
    renderApp();
    expect(await screen.findByText("Python 3 not detected")).toBeInTheDocument();
    // The misleading downstream error must NOT appear.
    expect(screen.queryByText("Library unavailable")).not.toBeInTheDocument();
  });

  it("shows the runtime-status screen when bootstrap_check errors", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: () => {
        throw new Error("Cannot parse bootstrap dry-run JSON");
      },
    });
    renderApp();
    expect(await screen.findByText("Couldn't initialize Skill Tree")).toBeInTheDocument();
    expect(screen.queryByText("Library unavailable")).not.toBeInTheDocument();
  });

  it("renders the BootstrapWizard when healthy but un-bootstrapped", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: {
        needs_bootstrap: true,
        completed_at: null,
        version: 1,
        legacy_detected: [],
        data_home: "/home/test/.skill-hub",
        code_home: "/home/test/code",
        candidates: [],
        conflicts: [],
        blocked: [],
        already_managed: [],
        silent_skip: [],
      },
    });
    renderApp();
    expect(await screen.findByText("Set up Skill Tree")).toBeInTheDocument();
  });

  it("renders the app shell (routes) when healthy and bootstrapped", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: {
        needs_bootstrap: false,
        completed_at: "2026-05-20T18:33:00Z",
        version: 1,
        legacy_detected: [],
        data_home: "/home/test/.skill-hub",
        code_home: "/home/test/code",
        candidates: [],
        conflicts: [],
        blocked: [],
        already_managed: [],
        silent_skip: [],
      },
      read_registry: sampleRegistry,
      harness_list: [],
    });
    renderApp();
    // The main shell renders the SKILL TREE topbar; the wizard/error shells do not.
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText("Python 3 not detected")).not.toBeInTheDocument();
    expect(screen.queryByText("Set up Skill Tree")).not.toBeInTheDocument();
  });
});
