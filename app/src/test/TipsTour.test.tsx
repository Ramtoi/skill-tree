import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { TipsTour } from "@/components/TipsTour";
import { useAppStore } from "@/store";
import { TOUR, tipsDone } from "@/lib/tips";
import { makeQueryClient, renderWithProviders, sampleRegistry } from "./helpers";
import type { Registry } from "@/types";

// App calls getCurrentWindow() for fullscreen tracking — stub the window API
// (mirrors OnboardingGate.test.tsx).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

const okPreflight = { ok: true, reason: "none", detail: null, python: "/usr/bin/python3" };
const bootstrapped = {
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
};

const emptyRegistry = {
  version: "1",
  hub_path: "~/skill-hub",
  bootstrap: { completed_at: "2026-05-20T18:33:00Z", version: 1 },
  skills: {},
  projects: {},
  bundles: {},
  sources: {},
} as unknown as Registry;

/** Override the global invoke mock with a per-command map for a full-App test. */
function mockInvoke(map: Record<string, unknown | (() => unknown)>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd in map) {
      const v = map[cmd];
      return typeof v === "function" ? (v as () => unknown)() : v;
    }
    return undefined;
  });
}

function renderApp(client = makeQueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    ),
  };
}

const TITLE_1 = TOUR[0].title;
const TITLE_2 = TOUR[1].title;

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useAppStore.setState({
      tipsOpen: false,
      tipsStep: 0,
      degradedMode: false,
      paletteOpen: false,
      cheatsheetOpen: false,
    });
  });
});

afterEach(() => {
  localStorage.clear();
  act(() => {
    useAppStore.setState({ tipsOpen: false, tipsStep: 0, degradedMode: false });
  });
});

// ── Component: render + navigation ───────────────────────────────────────
describe("TipsTour component", () => {
  it("renders nothing while closed", () => {
    renderWithProviders(<TipsTour />);
    expect(screen.queryByRole("dialog", { name: TITLE_1 })).not.toBeInTheDocument();
  });

  it("shows the first step's title once opened", () => {
    renderWithProviders(<TipsTour />);
    act(() => useAppStore.getState().openTips());
    expect(screen.getByText(TITLE_1)).toBeInTheDocument();
    expect(screen.getByText(`1 / ${TOUR.length}`)).toBeInTheDocument();
  });

  it("navigates forward/back with Next / Back buttons", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TipsTour />);
    act(() => useAppStore.getState().openTips());

    // Back is disabled on the first step.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(TITLE_2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(TITLE_1)).toBeInTheDocument();
  });

  it("navigates with the keyboard (→ / Enter / ←)", () => {
    renderWithProviders(<TipsTour />);
    act(() => useAppStore.getState().openTips());

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(screen.getByText(TITLE_2)).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(screen.getByText(TITLE_1)).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(screen.getByText(TITLE_2)).toBeInTheDocument();
  });

  it("the final step's primary button reads Done and completing persists st:tips:done", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TipsTour />);
    // Jump straight to the last step.
    act(() => {
      useAppStore.getState().openTips();
      useAppStore.setState({ tipsStep: TOUR.length - 1 });
    });
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeInTheDocument();

    await user.click(done);
    expect(useAppStore.getState().tipsOpen).toBe(false);
    expect(tipsDone()).toBe(true);
  });

  it("Skip tour closes and persists st:tips:done", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TipsTour />);
    act(() => useAppStore.getState().openTips());

    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(useAppStore.getState().tipsOpen).toBe(false);
    expect(tipsDone()).toBe(true);
  });

  it("Esc closes the tour and persists done", () => {
    renderWithProviders(<TipsTour />);
    act(() => useAppStore.getState().openTips());

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().tipsOpen).toBe(false);
    expect(tipsDone()).toBe(true);
  });

  it("captures its keys so they never reach bubble-phase global/chord handlers", () => {
    renderWithProviders(<TipsTour />);
    const bubbleSpy = vi.fn();
    // useChords + App's global single-key handler both attach on `window` in the
    // default (bubble) phase. The tour's capture-phase listener must swallow its
    // keys before they get there.
    window.addEventListener("keydown", bubbleSpy);
    try {
      // Closed: keys pass through to the bubble handler.
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(bubbleSpy).toHaveBeenCalledTimes(1);
      bubbleSpy.mockClear();

      // Open: the same key is captured + stopped, advancing the tour and never
      // reaching the bubble handler (so a chord like `g l` can't fire).
      act(() => useAppStore.getState().openTips());
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(useAppStore.getState().tipsStep).toBe(1);
      expect(bubbleSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", bubbleSpy);
    }
  });
});

// ── Auto-start (full App) ─────────────────────────────────────────────────
describe("TipsTour auto-start", () => {
  it("auto-starts once on a fresh install (empty registry, bootstrapped, not seen)", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: emptyRegistry,
      harness_list: [],
    });
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    // The tour opens itself.
    expect(await screen.findByText(TITLE_1)).toBeInTheDocument();
  });

  it("does NOT auto-start when st:tips:done is already set", async () => {
    localStorage.setItem("st:tips:done", "1");
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: emptyRegistry,
      harness_list: [],
    });
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText(TITLE_1)).not.toBeInTheDocument();
  });

  it("does NOT auto-start in degraded mode", async () => {
    act(() => useAppStore.setState({ degradedMode: true }));
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: emptyRegistry,
      harness_list: [],
    });
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText(TITLE_1)).not.toBeInTheDocument();
  });

  it("does NOT auto-start on a populated (existing) install", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: sampleRegistry,
      harness_list: [],
    });
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText(TITLE_1)).not.toBeInTheDocument();
  });
});

// ── Anchors + manual relaunch (full App) ──────────────────────────────────
describe("TipsTour anchors + manual relaunch", () => {
  beforeEach(() => {
    // Populated + already-seen so nothing auto-starts; manual entry only.
    localStorage.setItem("st:tips:done", "1");
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: sampleRegistry,
      harness_list: [],
    });
  });

  it("mounts a [data-tour] anchor for every one of the six steps", async () => {
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    for (const step of TOUR) {
      expect(
        document.querySelector(`[data-tour="${step.id}"]`),
        `missing anchor for step "${step.id}"`,
      ).not.toBeNull();
    }
    // Sanity: all six ids are distinct.
    expect(new Set(TOUR.map((s) => s.id)).size).toBe(TOUR.length);
  });

  it("relaunches from the command palette even though st:tips:done is set", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText(TITLE_1)).not.toBeInTheDocument();

    act(() => useAppStore.getState().openPalette());
    const input = document.querySelector<HTMLInputElement>(".palette input");
    expect(input).not.toBeNull();
    await user.type(input!, "tips tour");
    await user.click(screen.getByText("Show tips tour"));

    expect(await screen.findByText(TITLE_1)).toBeInTheDocument();
  });

  it("relaunches from the shortcut cheatsheet", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    act(() => useAppStore.getState().openCheatsheet());
    await user.click(screen.getByRole("button", { name: "Replay the tips tour" }));

    expect(await screen.findByText(TITLE_1)).toBeInTheDocument();
  });
});
