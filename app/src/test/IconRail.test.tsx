import { describe, it, expect, beforeEach, vi } from "vitest";
import { readAppCss } from "./readAppCss";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { IconRail } from "@/components/IconRail";
import {
  renderWithProviders,
  makeQueryClient,
  primeRegistry,
  sampleRegistry,
} from "./helpers";
import { useAppStore } from "@/store";
import { TWEAK_DEFAULTS } from "@/lib/tweaks";

// App calls getCurrentWindow() for fullscreen tracking — stub the window API
// (only the App-root test below mounts it; the mock is inert for the rest).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

const css = readAppCss();

/** `tweaks` is a process-wide store slice hydrated once from localStorage, so a
 *  test that flips a tweak would leak into every later test. Reset both. */
beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ tweaks: { ...TWEAK_DEFAULTS } });
});

describe("IconRail", () => {
  it("hosts no brand mark — it moved up to the title strip", () => {
    // The mark lives in `.app-topbar` (the band cell over the rail column,
    // asserted in OnboardingGate's shell test); a second copy in the rail
    // would be the old layout surviving a refactor.
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<IconRail />, { client });
    expect(screen.queryByTitle("Skill Tree")).toBeNull();
    expect(container.querySelector(".rail-logo")).toBeNull();
  });

  it("shows the ten destinations + two utilities", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    expect(screen.getByTitle("Library")).toBeInTheDocument();
    expect(screen.getByTitle("Projects")).toBeInTheDocument();
    expect(screen.getByTitle("Sources")).toBeInTheDocument();
    expect(screen.getByTitle("Snippets")).toBeInTheDocument();
    expect(screen.getByTitle("Hooks")).toBeInTheDocument();
    expect(screen.getByTitle("Permissions")).toBeInTheDocument();
    expect(screen.getByTitle("Harnesses")).toBeInTheDocument();
    expect(screen.getByTitle("Remotes")).toBeInTheDocument();
    expect(screen.getByTitle("Usage / Local Agent Usage")).toBeInTheDocument();
    expect(screen.getByTitle("Backup")).toBeInTheDocument();
    expect(screen.getByTitle("Command palette (⌘K)")).toBeInTheDocument();
    expect(screen.getByTitle("Settings")).toBeInTheDocument();
  });

  it("orders the destinations by intent group", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<IconRail />, { client });
    const titleOrder = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-btn"),
    ).map((b) => b.getAttribute("title"));
    // Projects · CONTEXT · GUARDRAILS · AGENTS · ELSEWHERE, then utilities.
    expect(titleOrder).toEqual([
      "Projects",
      "Library",
      "Snippets",
      "Permissions",
      "Hooks",
      "Harnesses",
      "Usage / Local Agent Usage",
      "Sources",
      "Remotes",
      "Backup",
      "Command palette (⌘K)",
      "Settings",
      "Expand rail (show labels)",
    ]);
  });

  it("captions each group boundary, in group order and with no caption above Projects", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<IconRail />, { client });
    const captions = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-caption"),
    );
    expect(captions.map((c) => c.textContent)).toEqual([
      "Context",
      "Guardrails",
      "Agents",
      "Elsewhere",
    ]);
    // The first caption sits AFTER the Projects button: slot 1 is its own group
    // and captioning it would just repeat the button's label.
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-btn, .rail-caption"),
    );
    expect(items[0].getAttribute("title")).toBe("Projects");
    expect(items[1].className).toBe("rail-caption");
  });

  it("CSS contract: the caption text appears only in the expanded, non-narrow rail", () => {
    // Never `display:none` — that cannot transition. Collapsed the caption text
    // is fully transparent; expanded it fades in (the rail animates).
    expect(css).toMatch(/\.rail-caption\s*>\s*span\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(
      /\.app\[data-rail-expanded="true"\]:not\(\[data-narrow="true"\]\)\s+\.rail-caption\s*>\s*span\s*\{[^}]*opacity:\s*1/,
    );
    // Collapsed, the caption IS the old hairline divider.
    expect(css).toMatch(
      /\.rail-caption\s*\{[^}]*background:\s*var\(--border\)/,
    );
  });

  it("keeps the tips-tour anchors on their rail buttons", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<IconRail />, { client });
    const anchored = (tour: string) =>
      container.querySelector<HTMLElement>(`[data-tour="${tour}"]`);
    expect(anchored("equip")?.getAttribute("title")).toBe("Projects");
    expect(anchored("library")?.getAttribute("title")).toBe("Library");
    expect(anchored("palette")?.getAttribute("title")).toBe(
      "Command palette (⌘K)",
    );
    expect(anchored("help")?.getAttribute("title")).toBe("Settings");
    // The second Projects anchor rides a zero-chrome overlay inside the button.
    expect(anchored("add-project")?.closest(".rail-btn")).toBe(
      screen.getByTitle("Projects"),
    );
  });

  it("marks Hooks aria-current on /hooks and /hook/* routes", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/hook/lint-after-edit" });
    expect(screen.getByTitle("Hooks").getAttribute("aria-current")).toBe("true");
  });

  it("marks Remotes aria-current on /remotes and /remote/* routes", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/remote/hermes-main" });
    expect(screen.getByTitle("Remotes").getAttribute("aria-current")).toBe("true");
  });

  it("marks Usage aria-current on /usage", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/usage" });
    expect(screen.getByTitle("Usage / Local Agent Usage").getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("no longer has Bundles or Sync rail buttons", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    expect(screen.queryByTitle("Bundles")).toBeNull();
    expect(screen.queryByTitle("Sync")).toBeNull();
  });

  it("marks Library aria-current on root route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/" });
    expect(screen.getByTitle("Library").getAttribute("aria-current")).toBe("true");
  });

  it("marks Library aria-current on /bundle/* route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/bundle/android" });
    expect(screen.getByTitle("Library").getAttribute("aria-current")).toBe("true");
  });

  it("marks Projects aria-current on /project/* route", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/project/example-app" });
    expect(screen.getByTitle("Projects").getAttribute("aria-current")).toBe("true");
  });

  it("marks Permissions aria-current on /permissions and uses a non-cog icon", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client, initialRoute: "/permissions" });
    const perms = screen.getByTitle("Permissions");
    expect(perms.getAttribute("aria-current")).toBe("true");
    // Permissions wears the warded shield (shield outline + keyhole), never the
    // cog. The cog has a connected toothed outline around its center ring.
    const cogPath = "M6.4 1.5h3.2";
    expect(perms.querySelector(`path[d^="${cogPath}"]`)).toBeNull();
    expect(perms.querySelector('path[d^="M8 1.8 13 3.3"]')).not.toBeNull();
    const settings = screen.getByTitle("Settings");
    expect(settings.querySelector(`path[d^="${cogPath}"]`)).not.toBeNull();
  });

  it("every destination glyph carries a live-point detail on a live-glint host", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<IconRail />, { client });
    const destinations = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-btn"),
    ).filter((b) => !["Toggle navigation", "Collapse rail", "Expand rail (show labels)"]
      .includes(b.getAttribute("title") ?? ""));
    for (const btn of destinations) {
      expect(btn.classList.contains("live-glint")).toBe(true);
      expect(
        btn.querySelectorAll(".ic-live").length,
        `${btn.getAttribute("title")} icon must tag a live point`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("Hooks wears the fishhook, not the bolt (bolt = the APPLY verb)", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    const hooks = screen.getByTitle("Hooks");
    const boltPath = "m9 1.5-6 8h4l-1 5 6-8H8l1-5Z";
    expect(hooks.querySelector(`path[d="${boltPath}"]`)).toBeNull();
    // Fishhook marker: the shank-and-bend path.
    expect(hooks.querySelector('path[d^="M10.6 4.1v5"]')).not.toBeNull();
  });

  it("clicking the command-palette button opens the palette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail />, { client });
    await userEvent.click(screen.getByTitle("Command palette (⌘K)"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });

  it("Projects with no registered projects opens the palette", async () => {
    const client = makeQueryClient();
    // Empty registry — no projects, so the Projects rail button falls back to the palette.
    client.setQueryData(["registry"], {
      harnesses_global: [],
      projects: {},
      bundles: {},
      skills: {},
      sources: {},
    });
    useAppStore.setState({ recentlyVisited: [] });
    renderWithProviders(<IconRail />, { client });
    await userEvent.click(screen.getByTitle("Projects"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });
});

// ─── Expandable rail (labels mode) ───────────────────────────────────────────

/** Answer `read_registry` so a full <App /> mount reaches the shell, chaining
 *  to whatever implementation setup.ts installed for every other command. */
function mockReadRegistry() {
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) =>
    cmd === "read_registry"
      ? Promise.resolve(sampleRegistry)
      : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
}

function renderRail() {
  const client = makeQueryClient();
  primeRegistry(client);
  return renderWithProviders(<IconRail />, { client });
}

describe("IconRail — expand/collapse", () => {
  it("starts collapsed: the toggle offers to expand", () => {
    renderRail();
    expect(useAppStore.getState().tweaks.railExpanded).toBe(false);
    expect(screen.getByTitle("Expand rail (show labels)")).toBeInTheDocument();
    expect(screen.queryByTitle("Collapse rail")).toBeNull();
  });

  it("renders a label for every destination and utility", () => {
    const { container } = renderRail();
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-label"),
    ).map((el) => el.textContent);
    // Intent order: the campaign · context · guardrails · agents · elsewhere
    // · utilities.
    expect(labels).toEqual([
      "Projects",
      "Library",
      "Snippets",
      "Permissions",
      "Hooks",
      "Harnesses",
      "Usage",
      "Sources",
      "Remotes",
      "Backup",
      "Palette",
      "Settings",
      "Collapse",
    ]);
  });

  it("clicking the toggle expands, persists the tweak, and offers to collapse", async () => {
    renderRail();
    const toggle = screen.getByTitle("Expand rail (show labels)");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);

    expect(useAppStore.getState().tweaks.railExpanded).toBe(true);
    const stored = JSON.parse(localStorage.getItem("skill-tree:tweaks") ?? "{}");
    expect(stored.railExpanded).toBe(true);
    expect(screen.getByTitle("Collapse rail")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("narrow windows hide the toggle: CSS forces the compact rail there, so the chevron would be inert", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<IconRail showNavToggle />, { client });
    expect(screen.queryByTitle("Expand rail (show labels)")).toBeNull();
    expect(screen.queryByTitle("Collapse rail")).toBeNull();
    // The drawer toggle (the narrow-only control) is still there.
    expect(screen.getByTitle("Toggle navigation")).toBeInTheDocument();
  });

  it("the toggle glyph mirrors: chevron-right collapsed, chevron-left expanded", async () => {
    renderRail();
    const expand = screen.getByTitle("Expand rail (show labels)");
    expect(expand.querySelector('path[d="m6 3 5 5-5 5"]')).not.toBeNull();

    await userEvent.click(expand);
    const collapse = screen.getByTitle("Collapse rail");
    expect(collapse.querySelector('path[d="m10 3-5 5 5 5"]')).not.toBeNull();
  });

  it("clicking the toggle again collapses back", async () => {
    renderRail();
    await userEvent.click(screen.getByTitle("Expand rail (show labels)"));
    await userEvent.click(screen.getByTitle("Collapse rail"));

    expect(useAppStore.getState().tweaks.railExpanded).toBe(false);
    const stored = JSON.parse(localStorage.getItem("skill-tree:tweaks") ?? "{}");
    expect(stored.railExpanded).toBe(false);
    expect(screen.getByTitle("Expand rail (show labels)")).toBeInTheDocument();
  });

  it("expanding preserves every destination title (tooltips stay in both modes)", async () => {
    renderRail();
    await userEvent.click(screen.getByTitle("Expand rail (show labels)"));
    for (const title of [
      "Library",
      "Projects",
      "Sources",
      "Snippets",
      "Hooks",
      "Permissions",
      "Harnesses",
      "Remotes",
      "Usage / Local Agent Usage",
      "Backup",
      "Command palette (⌘K)",
      "Settings",
    ]) {
      expect(screen.getByTitle(title)).toBeInTheDocument();
    }
  });

  // The labels are always in the DOM; visibility is a CSS concern (no remount,
  // no content reflow), so the mode contract is pinned against the stylesheet.
  it("CSS contract: labels are hidden until the expanded, non-narrow state", () => {
    // Collapsed: a zero-width, transparent, clipped sliver (so the width can
    // ease open — `display:none` cannot animate). Expanded: content-sized,
    // left-aligned, opaque.
    expect(css).toMatch(/\.rail-label\s*\{[^}]*max-width:\s*0/);
    expect(css).toMatch(/\.rail-label\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\.rail-label\s*\{[^}]*text-align:\s*left/);
    expect(css).toMatch(
      /\.app\[data-rail-expanded="true"\]:not\(\[data-narrow="true"\]\)\s+\.rail-label\s*\{[^}]*opacity:\s*1/,
    );
  });

  it("CSS contract: expanded swaps --rail-w, and a narrow window opts out", () => {
    expect(css).toMatch(
      /\.app\[data-rail="true"\]\[data-rail-expanded="true"\]:not\(\[data-narrow="true"\]\)\s*\{[^}]*--rail-w:\s*var\(--rail-w-expanded\)/,
    );
    // Every expanded-mode rule must carry the narrow guard, or a narrow window
    // (regex matches data-rail-expanded ANYWHERE in the selector, so compound
    // forms like .app[data-rail="true"][data-rail-expanded="true"] are seen too)
    // would inherit half the labels layout at 56px.
    const expandedRules = css.match(/\.app\[[^{]*data-rail-expanded="true"[^{]*\{/g) ?? [];
    expect(expandedRules.length).toBeGreaterThan(0);
    for (const rule of expandedRules) {
      expect(rule).toContain(':not([data-narrow="true"])');
    }
  });

  it("App root carries data-rail-expanded, reflecting the tweak live", async () => {
    useAppStore.setState({ tweaks: { ...TWEAK_DEFAULTS, railExpanded: true } });
    mockReadRegistry();
    const client = makeQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );

    const root = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".app");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(root.getAttribute("data-rail-expanded")).toBe("true");

    await act(async () => {
      useAppStore.getState().setTweak("railExpanded", false);
    });
    expect(root.getAttribute("data-rail-expanded")).toBe("false");
  });
});

// ─── Critique-pass regressions ───────────────────────────────────────────────

describe("IconRail — active pill follows sectionForPath (finding 7)", () => {
  function renderAt(route: string) {
    const client = makeQueryClient();
    primeRegistry(client);
    return renderWithProviders(<IconRail />, { client, initialRoute: route });
  }

  /** Every route → the rail button that must carry `aria-current`, plus the
   *  detail routes the hand-rolled predicates used to miss entirely. */
  const CASES: Array<{ route: string; title: string }> = [
    { route: "/", title: "Library" },
    { route: "/skill/brainstorm", title: "Library" },
    { route: "/bundle/android", title: "Library" },
    { route: "/project/example-app", title: "Projects" },
    { route: "/snippets", title: "Snippets" },
    { route: "/hooks", title: "Hooks" },
    { route: "/hook/lsp-report", title: "Hooks" },
    { route: "/harnesses", title: "Harnesses" },
    // Was dead: `isHarnesses` only matched the index route.
    { route: "/harness/claude-code", title: "Harnesses" },
    { route: "/harness/claude-code/doc", title: "Harnesses" },
    { route: "/permissions", title: "Permissions" },
    { route: "/remotes", title: "Remotes" },
    { route: "/remote/hermes-main", title: "Remotes" },
    // Was dead: cloud targets live on the Remotes surface.
    { route: "/cloud/claude-ai", title: "Remotes" },
    { route: "/sources", title: "Sources" },
    { route: "/usage", title: "Usage / Local Agent Usage" },
    // Backup was the one section the navigator named that the rail could not
    // reach; it now has a button of its own in the Elsewhere group.
    { route: "/backup", title: "Backup" },
  ];

  it.each(CASES)("marks $title current on $route", ({ route, title }) => {
    const { unmount } = renderAt(route);
    expect(screen.getByTitle(title)).toHaveAttribute("aria-current", "true");
    unmount();
  });

  it("marks exactly one destination per route", () => {
    for (const { route } of CASES) {
      const { container, unmount } = renderAt(route);
      expect(
        container.querySelectorAll('.rail-btn[aria-current="true"]'),
        route,
      ).toHaveLength(1);
      unmount();
    }
  });
});

/** Reports the router location so a rail click's destination is assertable. */
function RailLocationProbe() {
  const loc = useLocation();
  return <div data-testid="rail-loc">{loc.pathname}</div>;
}

describe("IconRail — Backup destination", () => {
  it("navigates to /backup", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <IconRail />
        <RailLocationProbe />
      </>,
      { client },
    );
    await userEvent.click(screen.getByTitle("Backup"));
    expect(screen.getByTestId("rail-loc").textContent).toBe("/backup");
  });
});

describe("IconRail — Hooks destination", () => {
  it("navigates to /hooks", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <>
        <IconRail />
        <RailLocationProbe />
      </>,
      { client },
    );
    await userEvent.click(screen.getByTitle("Hooks"));
    expect(screen.getByTestId("rail-loc").textContent).toBe("/hooks");
  });
});

describe("IconRail — Projects skips stale Recent entries (finding 3)", () => {
  function renderRailAt(registry = sampleRegistry) {
    const client = makeQueryClient();
    primeRegistry(client, registry);
    return renderWithProviders(
      <>
        <IconRail />
        <RailLocationProbe />
      </>,
      { client },
    );
  }

  it("falls back to a registered project when the recent one was removed", async () => {
    useAppStore.setState({
      recentlyVisited: [
        { type: "project", name: "deleted-app" },
        { type: "skill", name: "brainstorm" },
      ],
    });
    renderRailAt();
    await userEvent.click(screen.getByTitle("Projects"));
    expect(screen.getByTestId("rail-loc").textContent).toBe(
      "/project/example-app",
    );
  });

  it("still honours a recent project that DOES exist", async () => {
    // A registry with only one project can't tell "fell back to the first
    // registered project" apart from "honoured the recent one" — both land
    // on the same route. Extend the registry locally (never `sampleRegistry`
    // itself; other tests are seed-coupled to its counts) with a second
    // project and point `recentlyVisited` at it, so only the honour branch
    // can produce this route.
    const registryWithSecondProject = {
      ...sampleRegistry,
      projects: {
        ...sampleRegistry.projects,
        "second-app": { path: "/Users/dev/second-app", bundles: [], enabled: [] },
      },
    };
    useAppStore.setState({
      recentlyVisited: [{ type: "project", name: "second-app" }],
    });
    renderRailAt(registryWithSecondProject);
    await userEvent.click(screen.getByTitle("Projects"));
    expect(screen.getByTestId("rail-loc").textContent).toBe(
      "/project/second-app",
    );
  });

  it("opens the palette when nothing resolves at all", async () => {
    useAppStore.setState({
      recentlyVisited: [{ type: "project", name: "deleted-app" }],
      paletteOpen: false,
    });
    renderRailAt({ ...sampleRegistry, projects: {} });
    await userEvent.click(screen.getByTitle("Projects"));
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });
});
