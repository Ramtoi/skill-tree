import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { useAppStore } from "@/store";
import { TWEAK_DEFAULTS, readTweaks } from "@/lib/tweaks";
import { makeQueryClient, sampleRegistry } from "./helpers";
import { readAppCss } from "./readAppCss";

// A4 — the narrow off-canvas navigator, ungated from the icon rail.
//
// The drawer used to exist only while `data-rail="true"`: hiding the rail (a
// preference about the RAIL) left a 240px panel docked in a 520px window and no
// way to dismiss it. These tests pin the ungated behaviour plus its escape
// hatch — a fixed handle that renders whenever narrow leaves no other chrome.

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

const css = readAppCss();

const okPreflight = {
  ok: true,
  reason: "none",
  detail: null,
  python: "/usr/bin/python3",
};
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

const realMatchMedia = window.matchMedia;

/** Drive the narrow breakpoint the shell listens to. */
function setNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes("max-width: 820px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
}

function renderApp() {
  const client = makeQueryClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "runtime_preflight") return okPreflight;
    if (cmd === "bootstrap_check") return bootstrapped;
    if (cmd === "read_registry") return sampleRegistry;
    if (cmd === "harness_list") return [];
    return undefined;
  });
  useAppStore.setState({
    degradedMode: false,
    settingsOpen: false,
    recentlyVisited: [],
    tweaks: { ...TWEAK_DEFAULTS },
  });
  setNarrow(false);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

// ─── The tweak ───────────────────────────────────────────────────────────────

describe("showNav tweak", () => {
  it("defaults to on", () => {
    expect(TWEAK_DEFAULTS.showNav).toBe(true);
    expect(readTweaks().showNav).toBe(true);
  });

  it("hydrates an older stored blob without the key", () => {
    localStorage.setItem(
      "skill-tree:tweaks",
      JSON.stringify({ density: "cozy", showRail: false }),
    );
    const t = readTweaks();
    expect(t.showNav).toBe(true);
    expect(t.showRail).toBe(false);
    expect(t.density).toBe("cozy");
  });

  it("is applied to the shell as data-nav", async () => {
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(container.querySelector(".app")).toHaveAttribute("data-nav", "true");

    act(() => useAppStore.getState().setTweak("showNav", false));
    expect(container.querySelector(".app")).toHaveAttribute("data-nav", "false");
  });

  it("has a Settings toggle of its own", async () => {
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Settings"));
    const toggle = screen.getByLabelText("Show navigator");
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(useAppStore.getState().tweaks.showNav).toBe(false);
  });
});

// ─── Closed drawer is inert ──────────────────────────────────────────────────

describe("narrow drawer", () => {
  it("a closed drawer is inert; opening it clears that", async () => {
    setNarrow(true);
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    const aside = container.querySelector(".app-side")!;
    expect(aside).toHaveAttribute("inert");
    expect(container.querySelector(".app")).toHaveAttribute(
      "data-nav-open",
      "false",
    );

    await userEvent.click(screen.getByTitle("Toggle navigation"));
    expect(container.querySelector(".app")).toHaveAttribute(
      "data-nav-open",
      "true",
    );
    expect(container.querySelector(".app-side")).not.toHaveAttribute("inert");
  });

  // FOCUS CONTAINMENT (finding 6). `inert` on the closed panel is only half of
  // it: while the drawer is open over a scrim, Tab used to walk straight past
  // it into the content behind, and closing it stranded focus on a row that had
  // just gone inert.
  it("makes the main column inert for exactly as long as the drawer is open", async () => {
    setNarrow(true);
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    const main = container.querySelector(".app-main")!;
    expect(main).not.toHaveAttribute("inert");

    await userEvent.click(screen.getByTitle("Toggle navigation"));
    expect(container.querySelector(".app-main")).toHaveAttribute("inert");
    // The rail keeps the toggle reachable — it must NOT go inert with it.
    expect(container.querySelector(".app-rail")).not.toHaveAttribute("inert");

    await userEvent.click(screen.getByTitle("Toggle navigation"));
    expect(container.querySelector(".app-main")).not.toHaveAttribute("inert");
  });

  it("never inerts the main column while the panel is docked", async () => {
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(container.querySelector(".app-main")).not.toHaveAttribute("inert");
  });

  it("returns focus to the opener when a drawer that held focus closes", async () => {
    setNarrow(true);
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    const toggle = screen.getByTitle("Toggle navigation");
    await userEvent.click(toggle);

    // Put focus somewhere inside the open drawer, the way Tab would.
    const row = container.querySelector<HTMLElement>(".app-side .side-item-main")!;
    act(() => row.focus());
    expect(document.activeElement).toBe(row);

    await userEvent.keyboard("{Escape}");
    expect(container.querySelector(".app")).toHaveAttribute(
      "data-nav-open",
      "false",
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves focus alone when it was never inside the drawer", async () => {
    setNarrow(true);
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    const toggle = screen.getByTitle("Toggle navigation");
    await userEvent.click(toggle);
    const elsewhere = screen.getByTitle("Library");
    act(() => elsewhere.focus());

    await userEvent.keyboard("{Escape}");
    expect(container.querySelector(".app")).toHaveAttribute(
      "data-nav-open",
      "false",
    );
    expect(document.activeElement).toBe(elsewhere);
  });

  it("a docked panel at full width is never inert", async () => {
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(container.querySelector(".app-side")).not.toHaveAttribute("inert");
  });

  it("the scrim appears with the drawer even when the rail is hidden", async () => {
    setNarrow(true);
    useAppStore.setState({ tweaks: { ...TWEAK_DEFAULTS, showRail: false } });
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(container.querySelector(".app-nav-scrim")).toBeNull();

    await userEvent.click(screen.getByLabelText("Open navigator"));
    expect(container.querySelector(".app-nav-scrim")).not.toBeNull();
  });
});

// ─── The handle (escape hatch) ───────────────────────────────────────────────

describe("nav handle", () => {
  it("appears only when narrow leaves no rail to toggle from", async () => {
    useAppStore.setState({ tweaks: { ...TWEAK_DEFAULTS, showRail: false } });
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    // Wide + no rail: the panel is docked, nothing to open.
    expect(screen.queryByLabelText("Open navigator")).toBeNull();
  });

  it("is absent while the rail is on screen (the rail owns the toggle)", async () => {
    setNarrow(true);
    renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open navigator")).toBeNull();
    expect(screen.getByTitle("Toggle navigation")).toBeInTheDocument();
  });

  it("renders at narrow with the rail hidden, and opens the drawer", async () => {
    setNarrow(true);
    useAppStore.setState({ tweaks: { ...TWEAK_DEFAULTS, showRail: false } });
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    const handle = screen.getByLabelText("Open navigator");
    expect(handle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(handle);
    expect(container.querySelector(".app")).toHaveAttribute(
      "data-nav-open",
      "true",
    );
    expect(container.querySelector(".app-side")).not.toHaveAttribute("inert");
  });

  it("STILL renders with the navigator switched off — no unrecoverable state", async () => {
    setNarrow(true);
    useAppStore.setState({
      tweaks: { ...TWEAK_DEFAULTS, showRail: false, showNav: false },
    });
    const { container } = renderApp();
    expect(await screen.findByText("SKILL TREE")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Open navigator"));
    // The panel is still mounted at narrow (it is a drawer, not a column), so
    // the handle actually gives navigation back.
    expect(container.querySelector(".app-side")).not.toHaveAttribute("inert");
    expect(container.querySelector(".app-nav-scrim")).not.toBeNull();
  });
});

// ─── CSS contract ────────────────────────────────────────────────────────────

describe("narrow CSS contract", () => {
  it("the drawer rules key on narrow alone, not on the rail", () => {
    expect(css).toMatch(
      /\.app\[data-narrow="true"\]\s+\.app-side\s*\{/,
    );
    expect(css).toMatch(
      /\.app\[data-narrow="true"\]\[data-nav-open="true"\]\s+\.app-side\s*\{/,
    );
    // The old rail-gated selectors are gone.
    expect(css).not.toMatch(
      /\.app\[data-narrow="true"\]\[data-rail="true"\]\s+\.app-side\s*\{/,
    );
  });

  it("offsets collapse to the window edge when the rail is hidden", () => {
    expect(css).toMatch(
      /\.app\[data-narrow="true"\]\[data-rail="false"\]\s+\.app-side\s*\{[^}]*left:\s*0/,
    );
    expect(css).toMatch(
      /\.app\[data-rail="false"\]\s+\.app-nav-scrim\s*\{\s*left:\s*0/,
    );
  });

  it("a closed drawer becomes visibility:hidden after the slide-out", () => {
    const closed = css.match(
      /\.app\[data-narrow="true"\]\s+\.app-side\s*\{[^}]*\}/,
    )![0];
    expect(closed).toMatch(/visibility:\s*hidden/);
    // 0.18s now reads as var(--dur-8) (S7); either form is a valid match.
    expect(closed).toMatch(
      /transition:[^;]*visibility 0s linear (0\.18s|var\(--dur-8\))/,
    );
    const open = css.match(
      /\.app\[data-narrow="true"\]\[data-nav-open="true"\]\s+\.app-side\s*\{[^}]*\}/,
    )![0];
    expect(open).toMatch(/visibility:\s*visible/);
  });

  it("the drawer paints above the rail", () => {
    // S7 routed z-index through the --z-* scale (tokens.css), so a rule's
    // z-index may read as `var(--z-name)` instead of a literal number —
    // resolve it against the :root definitions before comparing.
    const zIndexOf = (ruleText: string): number => {
      const raw = ruleText.match(/z-index:\s*(-?\d+|var\(--[\w-]+\))/)![1];
      if (!raw.startsWith("var(")) return Number(raw);
      const name = raw.slice(4, -1);
      return Number(css.match(new RegExp(`${name}:\\s*(-?\\d+)`))![1]);
    };
    const drawerRule = css.match(
      /\.app\[data-narrow="true"\]\s+\.app-side\s*\{[^}]*\}/,
    )![0];
    const railRule = css.match(/\.app-rail\s*\{[^}]*\}/)![0];
    expect(zIndexOf(drawerRule)).toBeGreaterThan(zIndexOf(railRule));
  });

  it("data-nav=false drops the panel column at full width only", () => {
    expect(css).toMatch(
      /\.app\[data-nav="false"\]:not\(\[data-narrow="true"\]\)\s+\.app-side\s*\{\s*display:\s*none/,
    );
  });
});
