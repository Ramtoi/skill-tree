import { describe, it, expect, vi, beforeEach } from "vitest";
import { readAppCss } from "./readAppCss";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { useAppStore } from "@/store";
import { makeQueryClient, sampleRegistry, mockCommands } from "./helpers";

// App calls getCurrentWindow() for fullscreen tracking — stub the window API.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

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

/** Override the global invoke mock with a per-command map for this test. */
function mockInvoke(map: Record<string, unknown | (() => unknown)>) {
  mockCommands(map);
}

const okPreflight = { ok: true, reason: "none", detail: null, python: "/usr/bin/python3" };

const css = readAppCss();

const needsBootstrap = {
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
};

describe("onboarding gate routing", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    // degradedMode is a persistent store flag; a prior test that flips it must
    // not leak into the next (each gate test asserts the honest, non-degraded gate).
    useAppStore.setState({ degradedMode: false, bootstrapDeferred: false });
  });

  // finding 2 — "Set up later" on the FIRST decision defers the gate for this
  // session. It must let the routes through WITHOUT claiming the runtime is
  // broken: degraded mode also silences the tips tour and the live connector
  // catalog, which a deferral has not earned.
  it("lets the routes through on 'Set up later' without degrading", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: needsBootstrap,
      read_registry: sampleRegistry,
      harness_list: [],
    });
    renderApp();
    expect(await screen.findByText("Set up Skill Tree")).toBeInTheDocument();

    await userEvent.keyboard("{Control>},{/Control}");
    expect(useAppStore.getState().settingsOpen).toBe(false);
    await userEvent.click(screen.getByTestId("choose-skip"));

    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByTestId("bootstrap-choose")).toBeNull();
    expect(useAppStore.getState().degradedMode).toBe(false);
    expect(useAppStore.getState().bootstrapDeferred).toBe(true);
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

  it("Continue in degraded mode mounts the app shell despite a failed preflight (B2-03)", async () => {
    // The ONLY escape hatch from a broken-Python install. Prior coverage proved
    // the runtime-status screen RENDERS but never clicked the recovery button to
    // prove the flip actually mounts the routes.
    mockInvoke({
      runtime_preflight: { ok: false, reason: "no-python", detail: null, python: null },
      read_registry: sampleRegistry,
      harness_list: [],
    });
    renderApp();

    // The runtime gate is up — no app shell yet.
    expect(await screen.findByText("Python 3 not detected")).toBeInTheDocument();
    expect(screen.queryByText("SKILL TREE")).not.toBeInTheDocument();

    // Click the sole recovery affordance.
    await userEvent.click(
      screen.getByRole("button", { name: "Continue in degraded mode" }),
    );

    // The app shell (topbar + routed Library) is now mounted; the error is gone.
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByText("Python 3 not detected")).not.toBeInTheDocument();
    expect(useAppStore.getState().degradedMode).toBe(true);
  });

  it("keeps ['python'] a Preflight object after a refetch — no boolean clobber from a second consumer", async () => {
    // Regression: StatusBar used a SECOND useQuery(["python"]) whose queryFn was
    // the old check_python (returns a bare boolean). Once the main shell mounted
    // it, a refetch overwrote the Preflight object with `true`, so
    // `preflight?.ok` became `true?.ok` === undefined and the app bounced to the
    // "Python 3 not detected" screen. All consumers must share usePreflight().
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: sampleRegistry,
      harness_list: [],
    });
    const { client } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    // Any consumer refetching the shared query must still yield the OBJECT.
    await client.refetchQueries({ queryKey: ["python"] });
    const data = client.getQueryData(["python"]);
    expect(typeof data).toBe("object");
    expect((data as { ok?: boolean }).ok).toBe(true);

    // …and the app stays on the Library, not bounced to the error screen.
    expect(screen.queryByText("Python 3 not detected")).not.toBeInTheDocument();
  });
});

// F1: both pre-router gates render `.app` with only `<main>` inside — no rail,
// no NavPanel — yet the grid still reserved the 240px sidebar track, pushing
// every gate off-centre (1440) and clipping it mid-word (520). The takeover is
// declared by `data-gate` on the wrapper; the collapse itself is CSS.
describe("gate layout (A1)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ degradedMode: false });
  });

  function appRoot(container: HTMLElement) {
    return container.querySelector(".app");
  }

  it("runtime-error gate marks its wrapper data-gate", async () => {
    mockInvoke({
      runtime_preflight: { ok: false, reason: "no-python", detail: null, python: null },
    });
    const { container } = renderApp();
    expect(await screen.findByText("Python 3 not detected")).toBeInTheDocument();
    expect(appRoot(container)).toHaveAttribute("data-gate", "true");
  });

  it("bootstrap-error gate marks its wrapper data-gate", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: () => {
        throw new Error("Cannot parse bootstrap dry-run JSON");
      },
    });
    const { container } = renderApp();
    expect(await screen.findByText("Couldn't initialize Skill Tree")).toBeInTheDocument();
    expect(appRoot(container)).toHaveAttribute("data-gate", "true");
  });

  it("bootstrap-wizard gate marks its wrapper data-gate", async () => {
    mockInvoke({ runtime_preflight: okPreflight, bootstrap_check: needsBootstrap });
    const { container } = renderApp();
    expect(await screen.findByText("Set up Skill Tree")).toBeInTheDocument();
    expect(appRoot(container)).toHaveAttribute("data-gate", "true");
  });

  it("the routed app shell is NOT a gate (the sidebar column must survive)", async () => {
    mockInvoke({
      runtime_preflight: okPreflight,
      bootstrap_check: bootstrapped,
      read_registry: sampleRegistry,
      harness_list: [],
    });
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(appRoot(container)).not.toHaveAttribute("data-gate");
    // The brand mark rides the title strip over the rail column (it moved out
    // of the rail; IconRail asserts its side of the move).
    expect(
      container.querySelector(".app-topbar .topbar-logo svg"),
    ).toBeInTheDocument();
  });

  it("CSS contract: a gate collapses to one column and puts main in it", () => {
    expect(css).toMatch(
      /\.app\[data-gate="true"\]\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(css).toMatch(
      /\.app\[data-gate="true"\]\s+\.app-main\s*\{[^}]*grid-column:\s*1/,
    );
    // Same specificity as the [data-rail] placement rules, so the gate rules
    // only win by coming later in the file.
    expect(css.indexOf('.app[data-gate="true"] .app-main')).toBeGreaterThan(
      css.indexOf('.app[data-rail="false"] .app-main'),
    );
  });
});
