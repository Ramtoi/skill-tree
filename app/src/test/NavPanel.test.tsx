import { qk } from "@/lib/queryKeys";
import { SideAttention } from "@/components/nav/SideAttention";
import { attentionLine, type AttentionKind } from "@/lib/navAttention";
import { SyncReportDrawer } from "@/components/SyncReportDrawer";
import { describe, it, expect, beforeEach } from "vitest";
import { act, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { NavPanel, migratePins, migrateCollapsed } from "@/components/NavPanel";
import { Sources } from "@/screens/Sources";
import { useSnippets } from "@/hooks/useSnippets";
import {
  GROUP_FOR_SECTION,
  GROUP_META,
  sectionForPath,
  type SectionId,
} from "@/lib/sections";
import {
  renderWithProviders,
  makeQueryClient,
  primeRegistry,
  sampleRegistry,
  sampleSyncReportEnvelope,
  mockSyncReport,
} from "./helpers";
import { useAppStore } from "@/store";
import type { Registry, Project, Bundle, Skill, GitSourceConfig } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderPanel(route: string, registry: Registry = sampleRegistry) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return renderWithProviders(
    <>
      <NavPanel />
      <LocationProbe />
    </>,
    { client, initialRoute: route },
  );
}

/** M-3: mounts the REAL `Sources` screen next to the panel — the screen owns
 *  the `?focus=` strip effect that unmounted the panel's detail block. */
function renderPanelWithSourcesScreen(route: string, registry: Registry) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return renderWithProviders(
    <>
      <Sources />
      <NavPanel />
      <LocationProbe />
    </>,
    { client, initialRoute: route },
  );
}

/** Like `renderPanel`, but also primes a sync-report envelope so the
 *  attention/tile insights that read `syncEnvelope` have real data. */
function renderPanelWithSync(
  route: string,
  registry: Registry,
  envelope: SyncReportEnvelope,
) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  mockSyncReport(envelope);
  client.setQueryData(["syncReport"], envelope);
  return renderWithProviders(
    <>
      <NavPanel />
      <LocationProbe />
    </>,
    { client, initialRoute: route },
  );
}

function registryWith(over: Partial<Registry>): Registry {
  return { ...sampleRegistry, ...over };
}

function manyProjects(n: number): Record<string, Project> {
  const projects: Record<string, Project> = {};
  for (let i = 0; i < n; i++) {
    const name = `proj-${String(i).padStart(2, "0")}`;
    projects[name] = { path: `/x/${name}`, bundles: [], enabled: [] };
  }
  return projects;
}

function manySkills(n: number): Record<string, Skill> {
  const skills: Record<string, Skill> = {};
  for (let i = 0; i < n; i++) {
    skills[`skill-${String(i).padStart(2, "0")}`] = {
      version: "1.0.0",
      description: "x",
      source: "~/h/skills/x",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    };
  }
  return skills;
}

function bundlesNamed(names: string[]): Record<string, Bundle> {
  const bundles: Record<string, Bundle> = {};
  for (const name of names) {
    bundles[name] = {
      description: name,
      icon: "📦",
      scope: "global",
      skills: [],
    };
  }
  return bundles;
}

function manyBundles(n: number): Record<string, Bundle> {
  const names = Array.from({ length: n }, (_, i) => `bundle-${String(i).padStart(2, "0")}`);
  return bundlesNamed(names);
}

/** `SnippetInfo` shapes for the Snippets group's own filter — it reads
 *  through `useSnippets()` (a `snippets_list` invoke), never the registry. */
function manySnippets(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `snippet-${String(i).padStart(2, "0")}`,
    description: "x",
    tags: [],
    version: 1,
    created: "",
    updated: "",
    hash: `h${i}`,
    usage: { count: 0, summary: "none" as const, outdated_count: 0 },
  }));
}

/** Overrides ONLY `snippets_list`, chaining every other command to whatever
 *  implementation was already installed — same pattern the "clicking a
 *  snippet row navigates" test below uses. */
function mockManySnippets(n: number) {
  const prev = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) =>
    cmd === "snippets_list"
      ? Promise.resolve(manySnippets(n))
      : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
}

const harnessFixture = [
  {
    id: "claude-code",
    label: "Claude Code",
    installed: true,
    on_globally: true,
    used_by_projects: [],
    agents: { supported: true, format: "yaml", agents_dir: null, project_agents_dir: null },
  },
  {
    id: "codex",
    label: "Codex",
    installed: false,
    on_globally: false,
    used_by_projects: [],
    agents: { supported: true, format: "toml", agents_dir: null, project_agents_dir: null },
  },
];

beforeEach(() => {
  useAppStore.setState({
    recentlyVisited: [],
    paletteOpen: false,
    toasts: [],
    harnesses: harnessFixture,
  });
});

// ─── Panel header: every section names itself ────────────────────────────────

/** One representative route per section, plus the detail routes that must stay
 *  inside their section. */
const ROUTES: Array<{ route: string; section: SectionId }> = [
  { route: "/", section: "library" },
  { route: "/skill/brainstorm", section: "library" },
  { route: "/bundle/android", section: "library" },
  { route: "/project/example-app", section: "projects" },
  { route: "/snippets", section: "snippets" },
  { route: "/snippet/x", section: "snippets" },
  { route: "/hooks", section: "hooks" },
  { route: "/hook/lsp-report", section: "hooks" },
  { route: "/harnesses", section: "harnesses" },
  { route: "/harness/claude-code", section: "harnesses" },
  { route: "/permissions", section: "permissions" },
  { route: "/remotes", section: "remotes" },
  { route: "/remote/hermes-main", section: "remotes" },
  { route: "/cloud/claude-ai", section: "remotes" },
  { route: "/sources", section: "sources" },
  { route: "/usage", section: "usage" },
  { route: "/backup", section: "backup" },
];

describe("NavPanel — panel header", () => {
  // The header now names the GROUP (five intent clusters), not the section —
  // several routes below share one group and so share one header label.
  it.each(ROUTES)(
    "names the current group on $route",
    ({ route, section }) => {
      const { container, unmount } = renderPanel(route);
      const head = container.querySelector(".side-head");
      expect(head, `no panel header on ${route}`).not.toBeNull();
      expect(head!.querySelector(".side-head-name")?.textContent).toBe(
        GROUP_META[GROUP_FOR_SECTION[section]].label,
      );
      unmount();
    },
  );

  // The head covers part of the macOS title bar when the panel is DOCKED, so it
  // drags the window. As a narrow drawer it floats over page content at
  // y=--topbar-h instead, where a press-drag (or a double-click zoom) would be a
  // bug. Tauri's handler reads the ATTRIBUTE, so CSS alone is not enough.
  it("carries the drag region only while docked", () => {
    const docked = renderPanel("/");
    expect(
      docked.container.querySelector(".side-head")?.hasAttribute(
        "data-tauri-drag-region",
      ),
    ).toBe(true);
    docked.unmount();

    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    const { container } = renderWithProviders(<NavPanel narrow />, {
      client,
      initialRoute: "/",
    });
    expect(
      container
        .querySelector(".side-head")
        ?.hasAttribute("data-tauri-drag-region"),
    ).toBe(false);
  });

  it("keeps a labelled navigation landmark around the section content", () => {
    const { container } = renderPanel("/");
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Navigator");
    expect(nav?.querySelector(".side-scroll")).not.toBeNull();
    // The head is CHROME (the panel's band cell), a sibling ABOVE the plate —
    // not part of the landmark; the plate wraps nav + recent + quick-jump on
    // one raised surface (the rounded plate the chrome contour curves around).
    expect(nav?.querySelector(".side-head")).toBeNull();
    expect(container.querySelector(".app-side > .side-head")).not.toBeNull();
    expect(container.querySelector(".side-plate > .side-nav")).not.toBeNull();
  });
});

// ─── Contextual content per section ──────────────────────────────────────────

describe("NavPanel — contextual content", () => {
  it("lists projects with the active one marked on /project/:name", () => {
    const { container } = renderPanel("/project/example-app");
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("example-app");
    // resolveActiveSkills: android bundle (2) ∪ brainstorm = 3
    expect(within(active as HTMLElement).getByText("3")).toBeInTheDocument();
  });

  it("shows Bundles + Snippets but NOT the skill list on / (the screen is the list)", () => {
    const { container } = renderPanel("/");
    const groups = [...container.querySelectorAll(".side-group .t-name")].map(
      (n) => n.textContent,
    );
    expect(groups).toEqual(["Bundles", "Snippets"]);
    expect(screen.queryByText("brainstorm")).toBeNull();
  });

  it("adds a Skills sibling group on /skill/:name with the current one active", () => {
    const { container } = renderPanel("/skill/brainstorm");
    const groups = [...container.querySelectorAll(".side-group .t-name")].map(
      (n) => n.textContent,
    );
    expect(groups).toEqual(["Bundles", "Snippets", "Skills"]);
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("brainstorm");
  });

  it("marks the open bundle active on /bundle/:name", () => {
    const { container } = renderPanel("/bundle/android");
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("android");
  });

  it("renders harness rows from the store (no harness_list call of its own)", () => {
    const { container } = renderPanel("/harness/claude-code");
    const names = [...container.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Codex"]));
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("Claude Code");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain(
      "harness_list",
    );
  });

  it("groups Remotes + Cloud apps and marks the open cloud target", () => {
    // `gone-skill` was archived after being equipped: the registry no longer
    // knows it, so neither count may include it (partition_equipped drops it).
    const reg = registryWith({
      remotes: {
        "hermes-main": {
          connector: "hermes",
          bundles: ["android"],
          enabled: ["gone-skill"],
        },
      },
      // fs-mcp is an mcp-server: a hosted chat product cannot take one, so it
      // must NOT be counted here (the screen beside us does not count it).
      cloud: { "claude-ai": { enabled: ["brainstorm", "fs-mcp", "gone-skill"] } },
    });
    const { container } = renderPanel("/cloud/claude-ai", reg);
    const groups = [...container.querySelectorAll(".side-group .t-name")].map(
      (n) => n.textContent,
    );
    // Elsewhere's third resident (Sources) sits ahead of these two.
    expect(groups).toEqual(["Sources", "Remotes", "Cloud apps"]);
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("claude.ai");
    // Equipped count = bundles ∪ enabled, resolved to distinct skills.
    const rowNamed = (name: string) =>
      [...container.querySelectorAll(".side-item")].find(
        (r) => r.querySelector(".name")?.textContent === name,
      ) as HTMLElement;
    expect(within(rowNamed("hermes-main")).getByText("2")).toBeInTheDocument();
    // brainstorm counts, fs-mcp (mcp-server) does not.
    expect(within(rowNamed("claude.ai")).getByText("1")).toBeInTheDocument();
  });

  it("gives every group a two-tile glance layer instead of a descriptor line", () => {
    // The old `.side-info` descriptor is gone (§2's Cut lists); every group
    // now carries exactly two steady tiles in the glance layer instead.
    for (const route of ["/permissions", "/usage", "/backup"]) {
      const { container, unmount } = renderPanel(route);
      expect(
        container.querySelectorAll(".side-dash .side-stat"),
        `no tiles on ${route}`,
      ).toHaveLength(2);
      expect(container.querySelector(".side-info")).toBeNull();
      unmount();
    }
  });

  it("keeps the real Sources action row a button routing to /sources?add=1", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/sources");
    await user.click(
      within(container).getByRole("button", { name: /Add source/ }),
    );
    expect(screen.getByTestId("loc").textContent).toBe("/sources?add=1");
  });

  // P4 — a row whose destination IS the current route cannot navigate, so it
  // must not be a button. Sources and Snippets are NOT in this list any more:
  // neither renders a self-link marker today (see below) — both are entirely
  // per-item rows now, so there is nothing for "you are here" to mark.
  it.each([
    { route: "/permissions", label: "Permissions" },
    { route: "/usage", label: "Usage" },
    { route: "/backup", label: "Backup" },
  ])(
    "renders the self-link row on $route as a non-interactive marker",
    ({ route, label }) => {
      const { container, unmount } = renderPanel(route);
      const here = container.querySelector(".side-item.is-here") as HTMLElement;
      expect(here, `no you-are-here row on ${route}`).not.toBeNull();
      expect(here.getAttribute("data-active")).toBe("true");
      expect(here.querySelector(".name")?.textContent).toBe(label);
      const main = here.querySelector(".side-item-main") as HTMLElement;
      expect(main.tagName).toBe("DIV");
      expect(main.getAttribute("aria-current")).toBe("page");
      // …and there is no "Open <label>" button left over anywhere.
      expect(
        within(container).queryByRole("button", {
          name: new RegExp(`Open ${label}`, "i"),
        }),
      ).toBeNull();
      unmount();
    },
  );
});

// ─── Merged groups: a critical descriptor beside real per-item rows ─────────

describe("NavPanel — merged groups mix a descriptor with real rows", () => {
  it("guardrails: a non-collapsible Permissions block beside a collapsible Hooks group", async () => {
    const { container } = renderPanel("/permissions");
    const staticBlock = container.querySelector(".side-group-static") as HTMLElement;
    expect(staticBlock.querySelector(".side-group-static-title")?.textContent).toBe(
      "Permissions",
    );
    // Never collapsible: no toggle button lives in this block.
    expect(staticBlock.querySelector("button.side-group-toggle")).toBeNull();
    // The global rule count now lives in the GLOBAL RULES tile, not a prose line.
    const tiles = [...container.querySelectorAll(".side-stat")];
    const globalRulesTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "GLOBAL RULES",
    ) as HTMLElement;
    expect(globalRulesTile.querySelector(".side-stat-value")?.textContent).toBe("2");
    const here = container.querySelector(".side-item.is-here");
    expect(here?.querySelector(".name")?.textContent).toBe("Permissions");

    // Hooks is a real, SEPARATE, collapsible group beside it.
    await screen.findByText("No hooks defined yet.");
    const hooksGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Hooks",
    ) as HTMLElement;
    expect(hooksGroup.querySelector("button.side-group-toggle")).not.toBeNull();
  });

  it("degrades the GLOBAL RULES tile to 0s when permissions_global is absent", () => {
    const reg = { ...sampleRegistry, permissions_global: undefined };
    const { container } = renderPanel("/permissions", reg);
    const tiles = [...container.querySelectorAll(".side-stat")];
    const globalRulesTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "GLOBAL RULES",
    ) as HTMLElement;
    expect(globalRulesTile.querySelector(".side-stat-value")?.textContent).toBe("0");
  });

  it("agents: a non-collapsible Harnesses block beside the Usage descriptor + self row", () => {
    const { container } = renderPanel("/harnesses");
    const staticBlock = container.querySelector(".side-group-static") as HTMLElement;
    expect(staticBlock.querySelector(".side-group-static-title")?.textContent).toBe(
      "Harnesses",
    );
    expect(staticBlock.querySelector("button.side-group-toggle")).toBeNull();
    const names = [...staticBlock.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Codex"]));
    // The constant descriptor prose is gone — replaced by the USAGE tile.
    expect(container.querySelector(".side-info-line")).toBeNull();
    expect(
      container.querySelectorAll(".side-dash .side-stat"),
    ).toHaveLength(2);
    expect(
      within(container).getByRole("button", { name: /Open usage/ }),
    ).toBeInTheDocument();
  });

  it("elsewhere: Sources/Remotes/Cloud rows are real navigation, not action rows", () => {
    const { container } = renderPanel("/remotes");
    const orgRow = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Org Skills",
    ) as HTMLElement;
    expect(orgRow.classList.contains("is-action")).toBe(false);
    // …while "Add source" stays a real action row, same as before.
    const addRow = within(container).getByRole("button", { name: /Add source/ });
    expect(addRow.closest(".side-item")?.classList.contains("is-action")).toBe(
      true,
    );
  });

  it("keeps a Backup row reachable from every elsewhere route", () => {
    for (const [route, expectHere] of [
      ["/sources", false],
      ["/remotes", false],
      ["/backup", true],
    ] as const) {
      const { container, unmount } = renderPanel(route);
      const row = expectHere
        ? container.querySelector(".side-item.is-here")
        : within(container).getByRole("button", { name: /Open backup/ }).closest(
            ".side-item",
          );
      expect(row?.querySelector(".name")?.textContent).toBe(
        expectHere ? "Backup" : "Open backup",
      );
      unmount();
    }
  });
});

// ─── Row geometry + identity (P2/P3/P5) ──────────────────────────────────────

describe("NavPanel — row alignment and identity", () => {
  it("reserves the leading box on EVERY row so labels line up", () => {
    // Hooks rows carry no glyph; they must still reserve the box.
    const { container } = renderPanel("/remotes", {
      ...sampleRegistry,
      remotes: { "hermes-main": { connector: "hermes" } },
    });
    const rows = [...container.querySelectorAll(".side-item")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.querySelector(".side-item-lead"))).toBe(true);
  });

  it("gives harness rows their brand glyph AND keeps the state dot trailing", () => {
    const { container } = renderPanel("/harness/claude-code");
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Claude Code",
    ) as HTMLElement;
    const lead = row.querySelector(".side-item-lead") as HTMLElement;
    expect(lead.querySelector(".harness-glyph")?.getAttribute("data-harness")).toBe(
      "claude-code",
    );
    // The dot moved OUT of the leading slot and now follows the name.
    const dot = row.querySelector(".health") as HTMLElement;
    expect(dot.getAttribute("data-state")).toBe("ok");
    expect(lead.contains(dot)).toBe(false);
    expect(
      dot.compareDocumentPosition(row.querySelector(".name") as HTMLElement) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    // A harness this machine lacks is dimmed, not silently identical.
    const codex = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Codex",
    ) as HTMLElement;
    expect(codex.getAttribute("data-dim")).toBe("true");
  });

  it("shows the SKILLS/IN USE tiles and drops the misleading header count", () => {
    // A skill total in the header sat directly above a contradicting
    // "Bundles N" group count — so the header count is gone; the shape of the
    // library now lives in the SKILLS tile (singularisation is pinned in
    // navInsights.test.ts, not here).
    const reg = registryWith({
      skills: manySkills(12),
      bundles: bundlesNamed(["a", "b", "c", "d"]),
    });
    const { container } = renderPanel("/", reg);
    expect(container.querySelector(".side-head-count")).toBeNull();
    const tiles = [...container.querySelectorAll(".side-stat")];
    const skillsTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "SKILLS",
    ) as HTMLElement;
    expect(skillsTile.querySelector(".side-stat-value")?.textContent).toBe("12");
    expect(skillsTile.getAttribute("title")).toContain("4 bundles");
  });
});

// ─── Regressions the rework exists to close ──────────────────────────────────

describe("NavPanel — dead-link + IPC regressions", () => {
  it("keeps per-source rows scoped to the elsewhere group — never leaking onto another group's routes", () => {
    for (const { route, section } of ROUTES) {
      if (GROUP_FOR_SECTION[section] === "elsewhere") continue;
      const { container, unmount } = renderPanel(route);
      const names = [...container.querySelectorAll(".side-item .name")].map(
        (n) => n.textContent,
      );
      // sampleRegistry's derived sources: Local, Starter Pack, Org Skills.
      for (const src of ["Local", "Starter Pack", "Org Skills"]) {
        expect(names, `source row leaked onto ${route}`).not.toContain(src);
      }
      unmount();
    }
  });

  it("renders a per-source row for every elsewhere route, each navigating to /sources?focus=<id>", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/sources");
    const orgRow = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Org Skills",
    ) as HTMLElement;
    expect(orgRow).toBeTruthy();
    await user.click(within(orgRow).getByRole("button"));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/sources?focus=org-skills",
    );
  });

  it("colors source rows by status — error, update-available (warn), else ok", () => {
    const reg = registryWith({
      sources: {
        ...sampleRegistry.sources,
        broken: {
          type: "git",
          name: "Broken",
          url: "git@github.com:x/broken.git",
          status: "error",
        },
      },
    });
    const { container } = renderPanel("/sources", reg);
    const rowFor = (name: string) =>
      [...container.querySelectorAll(".side-item")].find(
        (r) => r.querySelector(".name")?.textContent === name,
      ) as HTMLElement;
    expect(rowFor("Local").querySelector(".health")?.getAttribute("data-state")).toBe(
      "ok",
    );
    // sampleRegistry's org-skills carries status: "update-available".
    expect(
      rowFor("Org Skills").querySelector(".health")?.getAttribute("data-state"),
    ).toBe("warn");
    expect(
      rowFor("Broken").querySelector(".health")?.getAttribute("data-state"),
    ).toBe("error");
  });

  // R6 ban list — every one of these is either an expensive SSH/subprocess
  // sweep or a route-gated key the panel must never trigger, on ANY group.
  // Rendered with the panel ALONE (no StatusBar) so a panel-originated
  // `backup_status` call cannot hide behind the StatusBar's own observer.
  const BANNED_COMMANDS = [
    "remote_health",
    "remote_list",
    "remote_doctor",
    "permissions_show",
    "permissions_risks_schema",
    "local_skill_candidates",
    "subagent_link_status",
    "cloud_targets",
    "backup_status",
    "backup_auth_status",
    // review C4: capture-on-open moved out of `useLocalAgentUsage()` into a
    // dedicated `useCaptureOnOpen()` the Usage screen alone calls — the
    // Agents group's `AgentsGlance` reads `useLocalAgentUsage()` for its
    // cache-only `latest`/`snapshot` fields, and that read must never start
    // a scan (or read the durable history) as a side effect.
    "usage_scan_ccusage",
  ];

  it.each([
    "/project/example-app",
    "/",
    "/hooks",
    "/harnesses",
    "/remotes",
  ])("never calls a banned IPC command on %s", async (route) => {
    const reg = registryWith({
      remotes: {
        "hermes-main": { connector: "hermes" },
        "moon-base": { connector: "hermes" },
      },
    });
    renderPanel(route, reg);
    // Let every group's own screen-hook query settle before asserting.
    await new Promise((r) => setTimeout(r, 0));
    const called = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    for (const cmd of BANNED_COMMANDS) {
      expect(called, `${cmd} called on ${route}`).not.toContain(cmd);
    }
    // `hub usage history`/`hub usage import-claude-stats` go through the
    // generic `hub_cmd` bridge (review C4) — `useUsageHistory()` is not
    // called anywhere the panel reaches, so no `hub_cmd` invocation may
    // carry `usage` as its first argument either.
    const usageHubCmdCalls = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "hub_cmd" && (c[1] as { args?: string[] } | undefined)?.args?.[0] === "usage",
    );
    expect(usageHubCmdCalls, `hub_cmd usage … called on ${route}`).toHaveLength(0);
  });

  it("does not fetch the hooks library outside the guardrails group", () => {
    renderPanel("/");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain(
      "hook_list",
    );
  });

  it("reads the hooks library on the guardrails group, through the shared key", async () => {
    renderPanel("/hooks");
    await screen.findByText("No hooks defined yet.");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toContain("hook_list");
  });

  it("does not fetch the snippets library outside the context group", () => {
    renderPanel("/harnesses");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain(
      "snippets_list",
    );
  });

  it("reads the snippets library on the context group, through the screen's own hook", async () => {
    renderPanel("/");
    // Default mock answers `[]` — the group renders with an empty-state row.
    await screen.findByText("No snippets yet.");
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toContain(
      "snippets_list",
    );
  });

  it.each(["/hooks", "/"])(
    "does not fetch usage or sub-agent lists off the agents group (%s)",
    async (route) => {
      renderPanel(route);
      await new Promise((r) => setTimeout(r, 0));
      const called = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      expect(called).not.toContain("subagent_list");
      expect(called).not.toContain("usage_load_latest_ccusage");
    },
  );

  it.each(["/harnesses", "/usage"])(
    "reads the usage cache on the agents group (%s)",
    async (route) => {
      renderPanel(route);
      await new Promise((r) => setTimeout(r, 0));
      expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toContain(
        "usage_load_latest_ccusage",
      );
    },
  );

  it("fetches sub-agents on /harnesses for the one installed+on-globally+supported harness only", async () => {
    renderPanel("/harnesses");
    await new Promise((r) => setTimeout(r, 0));
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "subagent_list");
    // harnessFixture: claude-code installed+on_globally+supported; codex NOT
    // installed → exactly one call, for claude-code.
    expect(calls).toHaveLength(1);
    // The invoke arg key is `harnessId`, and `listSubagents` OMITS it for
    // claude-code so the shipped call site stays byte-identical
    // (see lib/subagents.ts's `harnessArg`); a call that named codex would
    // carry `harnessId: "codex"` instead.
    expect(calls[0][1]).not.toHaveProperty("harnessId");
  });

  it("primes the BACKUP tile from the query cache and never fetches backup_status itself", async () => {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    client.setQueryData(["backupStatus"], {
      enabled: true,
      initialized: true,
      configured: true,
      dir: "~/.skill-hub-backup",
      remote: "origin",
      repo: "user/repo",
      branch: "main",
      auth: {
        configured: "gh",
        pat_available: false,
        pat_detail: "",
        gh_login: "user",
        gh_active_login: "user",
        gh_account_mismatch: false,
      },
      push_failures: 0,
      last_push_error: null,
      pending_reconcile: false,
      ahead: 0,
      behind: 0,
      drift: "in-sync",
      manifest: null,
      warnings: [],
      last_commit: { sha: "abc", ts: "2026-05-21T16:40:00Z", subject: "snapshot" },
    });
    renderWithProviders(<NavPanel />, { client, initialRoute: "/backup" });
    await waitFor(() => {
      const tiles = [...document.querySelectorAll(".side-stat")];
      const backupTile = tiles.find(
        (t) => t.querySelector(".side-stat-label")?.textContent === "BACKUP",
      ) as HTMLElement;
      expect(backupTile.querySelector(".side-stat-value")?.textContent).not.toBe("—");
    });
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain(
      "backup_status",
    );
  });

  it("shows the BACKUP tile as unknown/checking when the cache is unprimed", () => {
    const { container } = renderPanel("/backup");
    const tiles = [...container.querySelectorAll(".side-stat")];
    const backupTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "BACKUP",
    ) as HTMLElement;
    expect(backupTile.querySelector(".side-stat-value")?.textContent).toBe("—");
    expect(backupTile.querySelector(".side-stat-sub")?.textContent).toBe("checking");
  });

  it("clicking a snippet row navigates to /snippet/house-rules", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) =>
      cmd === "snippets_list"
        ? Promise.resolve([
            {
              name: "house-rules",
              description: "d",
              tags: [],
              version: 1,
              created: "",
              updated: "",
              hash: "x",
              usage: { count: 2, summary: "applied", outdated_count: 0 },
            },
          ])
        : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
    const user = userEvent.setup();
    renderPanel("/");
    const row = await screen.findByText("house-rules");
    const item = row.closest(".side-item") as HTMLElement;
    expect(within(item).getByText("2 applied")).toBeInTheDocument();
    await user.click(within(item).getByRole("button"));
    expect(screen.getByTestId("loc").textContent).toBe("/snippet/house-rules");
  });

  it("marks the active row with a left bar only — no right-hand dot", () => {
    const { container } = renderPanel("/project/example-app");
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active).not.toBeNull();
    // The count must still be a plain, unobstructed span in the row.
    expect(active!.querySelector(".count")?.textContent).toBe("3");
    // Nothing renders a `.side-item::after` marker any more — the class that
    // carried it is gone from the row markup entirely.
    expect(active!.querySelector(".pin-kind")).toBeNull();
  });
});

// ─── Pins ────────────────────────────────────────────────────────────────────

describe("NavPanel — pins", () => {
  it("puts the pin in a SIBLING button that the keyboard can reach", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/project/example-app");
    const row = container.querySelector(".side-item") as HTMLElement;
    const main = row.querySelector(".side-item-main") as HTMLElement;
    const pin = row.querySelector(".side-item-pin") as HTMLButtonElement;
    expect(pin).not.toBeNull();
    // Sibling, not nested.
    expect(main.contains(pin)).toBe(false);
    expect(pin.parentElement).toBe(row);
    expect(pin.getAttribute("aria-pressed")).toBe("false");

    pin.focus();
    expect(document.activeElement).toBe(pin);
    await user.keyboard("{Enter}");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("st:sb:pinned")).toContain(
      "project:example-app",
    );
    // Toggling a pin must NOT navigate.
    expect(screen.getByTestId("loc").textContent).toBe("/project/example-app");
  });

  it("hoists pinned rows to the top of their own section (no Pinned card)", () => {
    window.localStorage.setItem(
      "st:sb:pinned",
      JSON.stringify(["project:proj-07"]),
    );
    const reg = registryWith({ projects: manyProjects(8) });
    const { container } = renderPanel("/project/proj-00", reg);
    expect(container.querySelector(".side-group.is-featured")).toBeNull();
    const names = [...container.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names[0]).toBe("proj-07");
    // …and it appears exactly once, not duplicated under a Pinned card.
    expect(names.filter((n) => n === "proj-07")).toHaveLength(1);
  });

  it("pins bundles too, and nothing else", () => {
    const { container } = renderPanel("/bundle/android");
    const rows = [...container.querySelectorAll(".side-item")];
    expect(rows.every((r) => r.querySelector(".side-item-pin"))).toBe(true);
    const { container: sources } = renderPanel("/sources");
    expect(sources.querySelector(".side-item-pin")).toBeNull();
  });

  it("migrates legacy pin keys tolerantly, says so once, and rewrites storage", async () => {
    window.localStorage.setItem(
      "st:sb:pinned",
      JSON.stringify([
        "project:example-app",
        "source:org-skills",
        "bundle:android",
        "garbage",
      ]),
    );
    renderPanel("/project/example-app");
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("Source pins were removed");
    expect(toasts[0].body).toMatch(/Sources screen/);
    const stored = JSON.parse(
      window.localStorage.getItem("st:sb:pinned") || "[]",
    );
    expect(stored).toEqual(["project:example-app", "bundle:android"]);
  });
});

describe("migratePins", () => {
  it("keeps project + bundle keys, drops the rest, reports dropped kinds", () => {
    expect(
      migratePins([
        "project:a",
        "bundle:b",
        "source:c",
        "remote:d",
        "nope",
        ":x",
        "y:",
        42,
      ]),
    ).toEqual({
      kept: ["project:a", "bundle:b"],
      droppedKinds: ["source", "remote"],
    });
  });

  it("splits on the FIRST colon so ids may contain colons", () => {
    expect(migratePins(["project:a:b"]).kept).toEqual(["project:a:b"]);
  });

  it("tolerates junk in storage", () => {
    expect(migratePins(null)).toEqual({ kept: [], droppedKinds: [] });
    expect(migratePins("nope")).toEqual({ kept: [], droppedKinds: [] });
  });
});

// ─── Filter ──────────────────────────────────────────────────────────────────

describe("NavPanel — list filter", () => {
  it("stays hidden for a short list", () => {
    const { container } = renderPanel("/project/example-app");
    expect(container.querySelector(".side-filter")).toBeNull();
  });

  it("opens search from the header and closes without leaving a hidden query", () => {
    const reg = registryWith({ projects: manyProjects(12) });
    const { container } = renderPanel("/project/proj-00", reg);
    expect(container.querySelector(".side-filter input")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Search projects" });
    fireEvent.click(toggle);
    const input = screen.getByRole("textbox", { name: "Search projects" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "proj-1" } });
    fireEvent.click(toggle);
    expect(container.querySelector(".side-filter input")).toBeNull();
    expect(container.querySelectorAll(".side-item .name")).toHaveLength(12);
    expect(toggle).toHaveFocus();
  });

  it("narrows the list and clears on Esc", () => {
    const reg = registryWith({ projects: manyProjects(12) });
    const { container } = renderPanel("/project/proj-00", reg);
    fireEvent.click(screen.getByRole("button", { name: "Search projects" }));
    const input = container.querySelector(
      ".side-filter input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "proj-1" } });
    let names = [...container.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["proj-10", "proj-11"]);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(container.querySelector(".side-empty")?.textContent).toBe(
      "No matches.",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    names = [...container.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(12);
  });

  it("filters the skills sibling list on a skill route", () => {
    const reg = registryWith({ skills: manySkills(12) });
    const { container } = renderPanel("/skill/skill-00", reg);
    const skillsGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Skills",
    ) as HTMLElement;
    fireEvent.click(within(skillsGroup).getByRole("button", { name: "Search skills" }));
    const input = skillsGroup.querySelector(
      ".side-filter input",
    ) as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Search skills");
    fireEvent.change(input, { target: { value: "skill-1" } });
    const names = [...skillsGroup.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["skill-10", "skill-11"]);
  });

  // navigator-search.journey.spec.ts: NavPanel.test.tsx only covered the
  // projects group's search open/close and narrow/Esc behavior — the same
  // two cases for the Bundles group, same fixtures-shape as the projects
  // case above (`manyBundles` mirrors `manyProjects`).
  it("opens search from the header and closes without leaving a hidden query (bundles)", () => {
    const reg = registryWith({ bundles: manyBundles(12) });
    const { container } = renderPanel("/", reg);
    const bundlesGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Bundles",
    ) as HTMLElement;
    expect(bundlesGroup.querySelector(".side-filter input")).toBeNull();
    const toggle = within(bundlesGroup).getByRole("button", { name: "Search bundles" });
    fireEvent.click(toggle);
    const input = within(bundlesGroup).getByRole("textbox", { name: "Search bundles" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "bundle-07" } });
    fireEvent.click(toggle);
    expect(bundlesGroup.querySelector(".side-filter input")).toBeNull();
    expect(bundlesGroup.querySelectorAll(".side-item .name")).toHaveLength(12);
    expect(toggle).toHaveFocus();
  });

  it("narrows the bundles list to one and clears on Esc", () => {
    const reg = registryWith({ bundles: manyBundles(12) });
    const { container } = renderPanel("/", reg);
    const bundlesGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Bundles",
    ) as HTMLElement;
    fireEvent.click(within(bundlesGroup).getByRole("button", { name: "Search bundles" }));
    const input = bundlesGroup.querySelector(".side-filter input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bundle-07" } });
    let names = [...bundlesGroup.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["bundle-07"]);
    fireEvent.keyDown(input, { key: "Escape" });
    names = [...bundlesGroup.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(12);
  });

  // Same two cases for the Snippets group — its own data source
  // (`useSnippets()`, a `snippets_list` invoke) rather than the registry.
  it("opens search from the header and closes without leaving a hidden query (snippets)", async () => {
    mockManySnippets(12);
    const { container } = renderPanel("/");
    await screen.findByText("snippet-00");
    const snippetsGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Snippets",
    ) as HTMLElement;
    expect(snippetsGroup.querySelector(".side-filter input")).toBeNull();
    const toggle = within(snippetsGroup).getByRole("button", { name: "Search snippets" });
    fireEvent.click(toggle);
    const input = within(snippetsGroup).getByRole("textbox", { name: "Search snippets" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "snippet-07" } });
    fireEvent.click(toggle);
    expect(snippetsGroup.querySelector(".side-filter input")).toBeNull();
    expect(snippetsGroup.querySelectorAll(".side-item .name")).toHaveLength(12);
    expect(toggle).toHaveFocus();
  });

  it("narrows the snippets list to one and clears on Esc", async () => {
    mockManySnippets(12);
    const { container } = renderPanel("/");
    await screen.findByText("snippet-00");
    const snippetsGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Snippets",
    ) as HTMLElement;
    fireEvent.click(within(snippetsGroup).getByRole("button", { name: "Search snippets" }));
    const input = snippetsGroup.querySelector(".side-filter input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "snippet-07" } });
    let names = [...snippetsGroup.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["snippet-07"]);
    fireEvent.keyDown(input, { key: "Escape" });
    names = [...snippetsGroup.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(12);
  });
});

// ─── Lists scroll: no truncation mechanism at all ────────────────────────────

describe("NavPanel — no truncation", () => {
  it("renders every project (no LIMIT, no Show-N-more)", () => {
    const reg = registryWith({ projects: manyProjects(20) });
    const { container } = renderPanel("/project/proj-00", reg);
    expect(container.querySelectorAll(".side-item").length).toBe(20);
    expect(container.querySelector(".side-show-more")).toBeNull();
  });
});

// ─── Groups ──────────────────────────────────────────────────────────────────

describe("NavPanel — group headers", () => {
  it("uses a real button carrying aria-expanded, and persists collapse", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/");
    const toggle = container.querySelector(
      ".side-group-toggle",
    ) as HTMLButtonElement;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Scoped to THIS group: the Snippets group beside it stays expanded.
    expect(toggle.closest(".side-group")?.querySelector(".side-group-items")).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem("st:sb:collapsed") || "[]"),
    ).toContain("context.bundles");
  });

  it("restores a stored collapse on a fresh mount (not just in-session)", () => {
    window.localStorage.setItem(
      "st:sb:collapsed",
      JSON.stringify(["context.bundles"]),
    );
    const { container } = renderPanel("/");
    const group = container.querySelector(".side-group") as HTMLElement;
    expect(group.getAttribute("data-collapsed")).toBe("true");
    expect(
      container.querySelector(".side-group-toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    // …and it is not clobbered back to empty by the persistence effect.
    expect(
      JSON.parse(window.localStorage.getItem("st:sb:collapsed") || "[]"),
    ).toEqual(["context.bundles"]);
  });

  it("keeps the add affordance OUT of the header button", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/");
    const toggle = container.querySelector(".side-group-toggle") as HTMLElement;
    const add = container.querySelector(
      '.side-group-head button[title="New bundle"]',
    ) as HTMLElement;
    expect(toggle.contains(add)).toBe(false);
    await user.click(add);
    expect(screen.getByTestId("loc").textContent).toBe("/?addBundle=1");
  });

  it("offers Add project from the panel header on the projects section", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/project/example-app");
    const add = container.querySelector(".side-head-add") as HTMLElement;
    await user.click(add);
    expect(screen.getByTestId("loc").textContent).toBe("/?addProject=1");
  });
});

// ─── Empty states ────────────────────────────────────────────────────────────

describe("NavPanel — empty sections", () => {
  it("offers a CTA row instead of a blank column", () => {
    const reg = registryWith({ projects: {}, bundles: {} });
    const { container } = renderPanel("/project/__none__", reg);
    expect(container.querySelector(".side-empty")?.textContent).toBe(
      "No projects registered yet.",
    );
    expect(
      within(container).getByRole("button", { name: /Add a project/ }),
    ).toBeInTheDocument();
  });

  it("offers a New bundle CTA when the library has none", () => {
    const reg = registryWith({ bundles: {} });
    const { container } = renderPanel("/", reg);
    expect(container.querySelector(".side-empty")?.textContent).toBe(
      "No bundles yet.",
    );
  });

  it("keeps the bundles group filterable past the threshold", () => {
    const reg = registryWith({
      bundles: bundlesNamed([
        "a1",
        "a2",
        "a3",
        "b1",
        "b2",
        "b3",
        "c1",
        "c2",
        "c3",
      ]),
    });
    const { container } = renderPanel("/", reg);
    fireEvent.click(screen.getByRole("button", { name: "Search bundles" }));
    const input = container.querySelector(
      ".side-filter input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "b" } });
    const names = [...container.querySelectorAll(".side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["b1", "b2", "b3"]);
  });
});

// ─── Constant bottom elements (unchanged this wave) ──────────────────────────

describe("NavPanel — Recent strip & Quick-jump footer", () => {
  it("renders empty placeholder when no recent items", () => {
    const { container } = renderPanel("/");
    expect(container.querySelector(".side-recent-empty")?.textContent).toBe(
      "nothing yet",
    );
  });

  it("marks the active recent chip with aria-current", () => {
    useAppStore.setState({
      recentlyVisited: [{ type: "project", name: "example-app" }],
    });
    const { container } = renderPanel("/project/example-app");
    const chip = container.querySelector(".side-recent-chip");
    expect(chip?.getAttribute("aria-current")).toBe("true");
  });

  it("clicking Quick-jump invokes openPalette", async () => {
    const { container } = renderPanel("/");
    expect(useAppStore.getState().paletteOpen).toBe(false);
    await userEvent.click(container.querySelector(".side-foot-btn") as HTMLElement);
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });
});

// ─── Route → section table ───────────────────────────────────────────────────

describe("sectionForPath", () => {
  it.each(ROUTES)("maps $route → $section", ({ route, section }) => {
    expect(sectionForPath(route)).toBe(section);
  });

  it("falls back to library for unknown paths", () => {
    expect(sectionForPath("/nope")).toBe("library");
  });
});

// ─── Critique-pass regressions ───────────────────────────────────────────────

describe("NavPanel — shared snippets query (finding 1)", () => {
  it("never becomes the fetcher for the Snippets screen's query", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    let calls = 0;
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "snippets_list") {
        calls += 1;
        return [
          {
            name: "house-rules",
            description: "d",
            tags: [],
            body: "b",
            usage: { count: 1 },
          },
        ];
      }
      if (cmd === "read_registry") return sampleRegistry;
      return undefined;
    }) as never);

    function ScreenProbe() {
      const { data } = useSnippets();
      return <div data-testid="snips">{(data ?? []).length}</div>;
    }

    // NavPanel LAST on purpose: both observers share one Query and
    // `Query.setOptions` is last-writer-wins over `queryFn`, so this is the
    // mount order in which a stub here would hijack every later refetch.
    renderWithProviders(
      <>
        <ScreenProbe />
        <NavPanel />
      </>,
      { client, initialRoute: "/snippets" },
    );

    await waitFor(() => expect(screen.getByTestId("snips").textContent).toBe("1"));
    expect(calls).toBe(1);

    // What a save / apply / remove does.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["snippets"] });
    });

    await waitFor(() => expect(calls).toBe(2));
    expect(client.getQueryState(["snippets", "", ""])?.status).toBe("success");
    expect(screen.getByTestId("snips").textContent).toBe("1");
  });
});

describe("NavPanel — collapse-key migration (finding 10)", () => {
  it("maps the oldest flat keys and drops the ones with no group left", () => {
    expect(
      migrateCollapsed(["bundles", "projects", "sources", "pinned"]).sort(),
    ).toEqual(["context.bundles"]);
  });

  it("maps Milestone A's section-namespaced keys to the new group-namespaced ones", () => {
    expect(
      migrateCollapsed([
        "library.bundles",
        "library.skills",
        "remotes.remotes",
        "remotes.cloud",
      ]).sort(),
    ).toEqual(
      ["context.bundles", "context.skills", "elsewhere.cloud", "elsewhere.remotes"].sort(),
    );
  });

  it("keeps current group-namespaced keys and drops unknown debris", () => {
    expect(
      migrateCollapsed([
        "context.skills",
        "elsewhere.cloud",
        "who.knows",
        42,
        null,
      ]).sort(),
    ).toEqual(["context.skills", "elsewhere.cloud"]);
  });

  it("tolerates a non-array blob", () => {
    expect(migrateCollapsed(null)).toEqual([]);
    expect(migrateCollapsed({ bundles: true })).toEqual([]);
  });

  it("re-persists only the migrated set, so the legacy keys never come back", () => {
    localStorage.setItem(
      "st:sb:collapsed",
      JSON.stringify(["bundles", "sources"]),
    );
    const { container } = renderPanel("/");
    // The legacy `bundles` collapse survived both renames as `context.bundles`.
    expect(
      container.querySelector(".side-group .side-group-toggle"),
    ).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem("st:sb:collapsed")!)).toEqual([
      "context.bundles",
    ]);
    localStorage.clear();
  });
});

describe("NavPanel — active row stays in view (finding 8)", () => {
  // `setup.ts` installs a no-op `scrollIntoView` on HTMLElement.prototype
  // (jsdom has none); swap in a spy for the duration.
  function withScrollSpy(fn: (spy: ReturnType<typeof vi.fn>) => void) {
    const real = window.HTMLElement.prototype.scrollIntoView;
    const spy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = spy;
    try {
      fn(spy);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = real;
    }
  }

  it("scrolls the active row into view when it mounts", () => {
    withScrollSpy((spy) => {
      renderPanel("/project/example-app");
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toEqual({ block: "nearest" });
    });
  });

  it("leaves inactive rows alone", () => {
    withScrollSpy((spy) => {
      renderPanel("/project/nothing-here");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe("NavPanel — Recent chips are reconciled with the registry (finding 3)", () => {
  it("hides a chip whose project no longer exists", () => {
    useAppStore.setState({
      recentlyVisited: [
        { type: "project", name: "deleted-app" },
        { type: "project", name: "example-app" },
      ],
    });
    const { container } = renderPanel("/");
    const chips = [...container.querySelectorAll(".side-recent-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["example-app"]);
  });

  it("hides deleted bundles and skills too", () => {
    useAppStore.setState({
      recentlyVisited: [
        { type: "bundle", name: "gone" },
        { type: "skill", name: "vanished" },
        { type: "bundle", name: "android" },
      ],
    });
    const { container } = renderPanel("/");
    const chips = [...container.querySelectorAll(".side-recent-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["android"]);
  });

  it("keeps kinds the registry cannot describe (a hook chip passes through)", () => {
    useAppStore.setState({
      recentlyVisited: [{ type: "hook", name: "lsp-report" }],
    });
    const { container } = renderPanel("/");
    expect(container.querySelector(".side-recent-chip")?.textContent).toBe(
      "lsp-report",
    );
  });
});

// ─── W2: the glance layer (attention plaque + tiles) ─────────────────────────

function envelopeWith(over: Partial<SyncReportEnvelope["report"]>): SyncReportEnvelope {
  return {
    registry_current: { sha256: "abc123", mtime: 0 },
    report: {
      schema_version: 1,
      generated_at: "2026-05-21T16:40:00Z",
      registry_sha256: "abc123",
      registry_mtime: 0,
      ok: true,
      global: {
        skipped: [],
        skills: { writes: 0, removed: 0 },
        mcp: { writes: 0, removed: 0 },
        permissions: { ok: true, errors: [] },
        remotes: { attempted: 0, alarming: 0 },
      },
      projects: {},
      ...over,
    },
  };
}

describe("NavPanel — attention plaque (spec §5.3)", () => {
  it("is absent on the default fixtures for /", () => {
    const { container } = renderPanel("/");
    expect(container.querySelector(".side-attn")).toBeNull();
  });

  it("opens explanations before navigation and keeps protected links out of the queue", async () => {
    // `harnesses_global` fixed so `effectiveHarnesses` is never empty — this
    // scenario is about the failed/affinity/stale/skipped lines specifically,
    // not the (separately-tested) "writes to no agent" line.
    const reg = registryWith({
      harnesses_global: ["claude-code"],
      projects: {
        "alpha-app": { path: "/x/alpha-app", bundles: [], enabled: [] },
        "zeta-app": { path: "/x/zeta-app", bundles: [], enabled: [] },
      },
    });
    const env: SyncReportEnvelope = {
      // A different sha than the report's own → every `ok:true` project reads
      // "stale" (zeta-app), on top of its own affinity_skips line.
      registry_current: { sha256: "different-sha", mtime: 0 },
      report: {
        schema_version: 1,
        generated_at: "2026-05-21T16:40:00Z",
        registry_sha256: "abc123",
        registry_mtime: 0,
        ok: false,
        global: {
          skipped: [],
          skills: { writes: 0, removed: 0, skipped_unowned: 2 },
          mcp: { writes: 0, removed: 0 },
          permissions: { ok: true, errors: [] },
          remotes: { attempted: 0, alarming: 0 },
        },
        projects: {
          "alpha-app": { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
          "zeta-app": {
            ts: "t",
            ok: true,
            errors: [],
            writes: 0,
            removed: 0,
            affinity_skips: [
              { skill: "some-skill", skill_harnesses: ["codex"], project_harnesses: ["claude-code"] },
            ],
          },
        },
      },
    };
    const user = userEvent.setup();
    const { container } = renderPanelWithSync("/project/alpha-app", reg, env);

    const plaque = await screen.findByRole("group");
    expect(plaque.className).toContain("side-attn");
    expect(plaque.getAttribute("data-worst")).toBe("error");
    expect(plaque.getAttribute("aria-labelledby")).toBeTruthy();

    const lines = [...plaque.querySelectorAll(".side-attn-line")];
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.tagName === "BUTTON")).toBe(true);
    expect(lines[0].getAttribute("data-tone")).toBe("error");
    expect(plaque).not.toHaveTextContent("owned by another install");
    expect(container.querySelector(".side-attn-more")).toBeNull();

    const row = within(plaque).getByRole("button", { name: /cannot reach an agent/ });
    await user.click(row);
    const dialog = screen.getByRole("dialog", { name: "Skills cannot reach an agent" });
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/alpha-app");
    expect(dialog).toHaveTextContent("some-skill · zeta-app");
    expect(dialog).toHaveTextContent("Skill supports: codex");
    expect(dialog).toHaveTextContent("Project harnesses: claude-code");
    await user.click(within(dialog).getByRole("button", { name: /Open project: some-skill/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/zeta-app?tab=loadout");

  });

  it("landmark: nav[aria-label=Navigator] holds no tile/attention; section.side-dash is its own labelled region", () => {
    const { container } = renderPanel("/project/example-app");
    const nav = container.querySelector('nav[aria-label="Navigator"]') as HTMLElement;
    expect(nav.querySelector(".side-stat")).toBeNull();
    expect(nav.querySelector(".side-attn")).toBeNull();
    const dash = container.querySelector("section.side-dash") as HTMLElement;
    expect(dash.getAttribute("aria-label")).toBe("Projects overview");
    expect(dash.querySelector("section")).toBeNull();
    expect(dash.querySelector("nav")).toBeNull();
  });
});

// ─── W2: detail expansion on the active row ──────────────────────────────────

describe("NavPanel — detail expansion (spec §5.1/§5.4)", () => {
  it("only the aria-current row expands, its detail holds nested [data-side-row] buttons, and navigating away unmounts it", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/project/example-app");
    const active = container.querySelector('.side-item[data-expanded="true"]') as HTMLElement;
    expect(active).not.toBeNull();
    expect(active.querySelector(".name")?.textContent).toBe("example-app");
    const detail = active.nextElementSibling as HTMLElement;
    expect(detail.className).toContain("side-item-detail");
    const nested = within(detail).getByRole("button", { name: /android 2$/i });
    expect(nested.hasAttribute("data-side-row")).toBe(true);

    await user.click(nested);
    expect(screen.getByTestId("loc").textContent).toBe("/bundle/android");
    // The panel head stays on Projects, and the project row stays anchored —
    // clicking a nested detail row must not blow away the referrer.
    expect(container.querySelector(".side-head-name")?.textContent).toBe("Projects");
    const stillActive = container.querySelector('.side-item[data-active="true"]');
    expect(stillActive?.querySelector(".name")?.textContent).toBe("example-app");
    // M-1: the nested `android` row itself is now `aria-current` — before the
    // fix `SideDetail` compared the REFERRER's path (still "/project/…")
    // against the row's href, which can never match the row you just landed
    // on.
    expect(nested.getAttribute("aria-current")).toBe("true");
  });

  it("a project with no bundles and no marks gets no detail block", () => {
    const reg = registryWith({
      projects: { solo: { path: "/x/solo", bundles: [], enabled: [] } },
    });
    const { container } = renderPanel("/project/solo", reg);
    const active = container.querySelector('.side-item[data-active="true"]') as HTMLElement;
    expect(active.getAttribute("data-expanded")).toBeNull();
  });

  it("does not expand a detail block on /bundle/android (no active project row)", () => {
    const { container } = renderPanel("/bundle/android");
    expect(container.querySelector(".side-item-detail")).toBeNull();
  });
});

// ─── W2: guardrails project-permission row ────────────────────────────────────

describe("NavPanel — guardrails permission rows (spec §2.3)", () => {
  it("links a project-permissions row to ?tab=permissions, keeps the panel on Guardrails, and shows the amber trust hint", async () => {
    const user = userEvent.setup();
    const reg = registryWith({
      projects: {
        ...sampleRegistry.projects,
        "skill-hub": {
          path: "/x/skill-hub",
          bundles: [],
          enabled: [],
          permissions: { allow: [], deny: [], ask: [], project_trust: true },
        },
      },
    });
    const { container } = renderPanel("/permissions", reg);
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "skill-hub",
    ) as HTMLElement;
    expect(row).toBeTruthy();
    const hint = row.querySelector(".row-hint") as HTMLElement;
    expect(hint.textContent).toBe("trust");
    expect(hint.getAttribute("data-tone")).toBe("severity");
    await user.click(within(row).getByRole("button"));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/project/skill-hub?tab=permissions",
    );
  });

  it("lights the project-permissions row active when on that exact route+tab", () => {
    const { container } = renderWithProviders(
      <>
        <NavPanel />
        <LocationProbe />
      </>,
      {
        client: (() => {
          const c = makeQueryClient();
          primeRegistry(c, registryWith({
            projects: {
              "skill-hub": {
                path: "/x",
                bundles: [],
                enabled: [],
                permissions: { allow: [], deny: [], ask: [], project_trust: true },
              },
            },
          }));
          return c;
        })(),
        initialRoute: {
          pathname: "/project/skill-hub",
          search: "?tab=permissions",
          state: { from: { label: "Permissions", path: "/permissions" } },
        },
      },
    );
    expect(container.querySelector(".side-head-name")?.textContent).toBe("Guardrails");
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "skill-hub",
    ) as HTMLElement;
    expect(row.getAttribute("data-active")).toBe("true");
  });
});

// ─── W2: agents group ─────────────────────────────────────────────────────────

describe("NavPanel — agents group (spec §2.4)", () => {
  it("has no head count and marks Open harnesses as a marker on /harnesses, a button elsewhere", () => {
    const { container: onScreen } = renderPanel("/harnesses");
    expect(onScreen.querySelector(".side-head-count")).toBeNull();
    const here = onScreen.querySelector(".side-item.is-here");
    expect(here?.querySelector(".name")?.textContent).toBe("Harnesses");

    const { container: elsewhere } = renderPanel("/harness/claude-code");
    const open = within(elsewhere).getByRole("button", { name: /Open harnesses/i });
    expect(open).toBeInTheDocument();
  });

  it("cold /usage (no harnesses scanned) shows —/not scanned and the empty-store copy, no plaque", () => {
    useAppStore.setState({ harnesses: [] });
    const { container } = renderPanel("/usage");
    expect(container.querySelector(".side-attn")).toBeNull();
    expect(container.querySelector(".side-empty")?.textContent).toBe(
      "No harnesses detected.",
    );
    const tiles = [...container.querySelectorAll(".side-stat")];
    const harnessesTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "HARNESSES",
    ) as HTMLElement;
    expect(harnessesTile.querySelector(".side-stat-value")?.textContent).toBe("—");
    expect(harnessesTile.querySelector(".side-stat-sub")?.textContent).toBe("not scanned");
  });

  it("marks a harness row's health dot error when on globally but not installed", () => {
    useAppStore.setState({
      harnesses: [
        {
          id: "opencode",
          label: "opencode",
          installed: false,
          on_globally: true,
          used_by_projects: [],
        },
      ],
    });
    const { container } = renderPanel("/harnesses");
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "opencode",
    ) as HTMLElement;
    expect(row.querySelector(".health")?.getAttribute("data-state")).toBe("error");
  });
});

// ─── W2: elsewhere group ──────────────────────────────────────────────────────

describe("NavPanel — elsewhere group (spec §2.5, bugs #1/#7/#10)", () => {
  it("Cloud apps group has no .t-count", () => {
    const { container } = renderPanel("/remotes");
    const cloudGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Cloud apps",
    ) as HTMLElement;
    expect(cloudGroup.querySelector(".t-count")).toBeNull();
  });

  it("Add remote navigates to /remotes?add=1", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("/remotes");
    await user.click(within(container).getByRole("button", { name: /Add remote/ }));
    expect(screen.getByTestId("loc").textContent).toBe("/remotes?add=1");
  });

  it("REMOTE SYNC tile reads —/auto-sync when the last run skipped remotes (B4)", () => {
    const env = envelopeWith({
      global: {
        skipped: ["remotes"],
        skills: { writes: 0, removed: 0 },
        mcp: { writes: 0, removed: 0 },
        permissions: { ok: true, errors: [] },
        remotes: { attempted: 0, alarming: 0 },
      },
    });
    const { container } = renderPanelWithSync("/remotes", sampleRegistry, env);
    const tiles = [...container.querySelectorAll(".side-stat")];
    const remoteSyncTile = tiles.find(
      (t) => t.querySelector(".side-stat-label")?.textContent === "REMOTE SYNC",
    ) as HTMLElement;
    expect(remoteSyncTile.querySelector(".side-stat-value")?.textContent).toBe("—");
    expect(remoteSyncTile.querySelector(".side-stat-sub")?.textContent).toBe("auto-sync");
  });

  it("dims a disabled source's row AND its dot reads never, not ok (bug #1)", () => {
    const reg = registryWith({
      sources: {
        ...sampleRegistry.sources,
        "org-skills": { ...sampleRegistry.sources!["org-skills"], enabled: false, status: "up-to-date" as never },
      },
    });
    const { container } = renderPanel("/sources", reg);
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Org Skills",
    ) as HTMLElement;
    expect(row.getAttribute("data-dim")).toBe("true");
    expect(row.querySelector(".health")?.getAttribute("data-state")).toBe("never");
    expect(row.querySelector(".row-hint")?.textContent).toBe("off");
  });

  it("dims a sync-off remote's row", () => {
    const reg = registryWith({
      remotes: { "worker-pool": { connector: "hermes", sync_enabled: false } },
    });
    const { container } = renderPanel("/remotes", reg);
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "worker-pool",
    ) as HTMLElement;
    expect(row.getAttribute("data-dim")).toBe("true");
    expect(row.querySelector(".row-hint")?.textContent).toBe("sync off");
  });

  it("M-3: the active source's detail block survives the Sources screen stripping ?focus=", async () => {
    const reg = registryWith({
      sources: {
        "org-skills": {
          ...(sampleRegistry.sources!["org-skills"] as GitSourceConfig),
          status: "error",
          error: "git fetch failed: Permission denied (publickey).",
        },
      },
    });
    const { container } = renderPanelWithSourcesScreen(
      "/sources?focus=org-skills",
      reg,
    );
    // The Sources screen strips `?focus=` in a mount effect — wait for it.
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/sources"),
    );
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "Org Skills",
    ) as HTMLElement;
    expect(row.getAttribute("data-active")).toBe("true");
    const detail = row.nextElementSibling as HTMLElement;
    expect(detail?.className).toContain("side-item-detail");
    expect(detail?.textContent).toContain("git fetch failed");
  });
});

// ─── W2: hook attached-nowhere row dims (guardrails) ──────────────────────────

describe("NavPanel — hook row marks (spec §2.3)", () => {
  it("dims a hook that is attached nowhere and gives it a never dot", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) =>
      cmd === "hook_list"
        ? Promise.resolve({
            hooks: [
              {
                name: "orphan-hook",
                provenance: "user",
                event: "PreToolUse",
                command: "echo hi",
                description: "",
                tools: [],
                matcher: "",
                timeout: null,
                harnesses: null,
                settings: {},
                attached_global: false,
                attached_projects: [],
              },
            ],
            reach: {},
          })
        : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
    const { container } = renderPanel("/hooks");
    await screen.findByText("orphan-hook");
    const row = [...container.querySelectorAll(".side-item")].find(
      (r) => r.querySelector(".name")?.textContent === "orphan-hook",
    ) as HTMLElement;
    expect(row.getAttribute("data-dim")).toBe("true");
    expect(row.querySelector(".health")?.getAttribute("data-state")).toBe("never");
  });
});


describe("bundle menus in expanded navigator rows", () => {
  it.each(["/project/example-app", "/skill/rt-android-expert"])("offers rename from %s", async (route) => {
    const { container } = renderPanel(route);
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-item.is-nested .side-item-main"))
      .find((button) => button.textContent?.includes("android"));
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
    expect(screen.getByTestId("loc")).toHaveTextContent(route);
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename bundle…" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android?rename=1"));
  });
});

describe("shared attention explanations", () => {
  it.each([
    ["raw", "symlink: source missing: /sources/benchmark\ninvocation: source missing: /sources/benchmark\nsymlink: source missing: /sources/browse\npermissions: access denied"],
    ["grouped", "source missing: /sources/benchmark (symlink + invocation)\nsource missing: /sources/browse (symlink)\npermissions: access denied"],
  ])("summarizes %s missing sources while preserving full diagnostics", async (_format, detail) => {
    const user = userEvent.setup();
    const line = attentionLine("projects.failed", "error", "Sync failed", [
      { id: "dev", label: "dev", detail, action: { label: "Open project", href: "/project/dev?tab=loadout" } },
    ]);
    renderWithProviders(<><SideAttention lines={[line]} groupLabel="Projects" /><LocationProbe /></>);
    await user.click(screen.getByRole("button", { name: /Sync failed, show details/ }));
    expect(screen.getByText("2 missing sources")).toBeVisible();
    expect(screen.getByText("1 other error")).toBeVisible();
    expect(document.querySelector(".attention-diagnostics pre")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Full diagnostics: dev" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".attention-diagnostics pre")?.textContent).toBe(detail);
    await user.click(toggle);
    expect(document.querySelector(".attention-diagnostics pre")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open project: dev" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/dev?tab=loadout");
  });

  it.each([
    ["Projects", "projects.missingRefs"], ["Context", "context.bundleMissing"],
    ["Guardrails", "guardrails.unsafeCombo"], ["Agents", "agents.invalidSubagent"],
    ["Elsewhere", "elsewhere.sourceFailing"],
  ] as Array<[string, AttentionKind]>)("%s opens a dialog without navigation or IPC and restores keyboard focus", async (groupLabel, kind) => {
    const user = userEvent.setup();
    const line = attentionLine(kind, "warn", "2 affected items", [
      { id: "first", label: "First item", detail: "First recorded detail", action: { label: "Inspect item", href: "/project/first" } },
      { id: "second", label: "Second item", detail: "Second recorded detail", action: { label: "Inspect item", href: "/project/second" } },
    ]);
    renderWithProviders(<><SideAttention lines={[line]} groupLabel={groupLabel} /><LocationProbe /></>, { initialRoute: "/permissions" });
    const row = screen.getByRole("button", { name: /2 affected items, show details/ });
    row.focus();
    vi.mocked(invoke).mockClear();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(line.explanation.happened);
    expect(dialog).toHaveTextContent(line.explanation.impact);
    expect(dialog).toHaveTextContent("First recorded detail");
    expect(dialog).toHaveTextContent("Second recorded detail");
    expect(screen.getByTestId("loc")).toHaveTextContent("/permissions");
    expect(invoke).not.toHaveBeenCalled();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row).toHaveFocus();
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Inspect item: Second item" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/project/second");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps same-route actions active and offers Close and backdrop dismissal", async () => {
    const user = userEvent.setup();
    const line = attentionLine("guardrails.unsafeCombo", "error", "Review Codex access", [{ id: "codex", label: "Codex" }], { label: "Review permissions", href: "/permissions" });
    renderWithProviders(<><SideAttention lines={[line]} groupLabel="Guardrails" /><LocationProbe /></>, { initialRoute: "/permissions" });
    const row = screen.getByRole("button", { name: /Review Codex access/ });
    await user.click(row);
    await user.click(within(document.querySelector(".modal-foot") as HTMLElement).getByRole("button", { name: "Close" }));
    expect(row).toHaveFocus();
    await user.click(row);
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row).toHaveFocus();
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Review permissions" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("loc")).toHaveTextContent("/permissions");
  });

  it("bounds the plaque by kind count with a keyboard-accessible more control", async () => {
    const user = userEvent.setup();
    const kinds: AttentionKind[] = ["projects.failed", "projects.noAgent", "projects.missingRefs", "projects.stale"];
    const lines = kinds.map((kind, index) => attentionLine(kind, "warn", `Problem ${index}`, [{ id: "item", label: "Item", action: { label: "Open project", href: "/project/item" } }]));
    const { container } = renderWithProviders(<SideAttention lines={lines} groupLabel="Projects" />);
    expect(container.querySelectorAll(".side-attn-line")).toHaveLength(3);
    const more = screen.getByRole("button", { name: "+1 more" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(container.querySelectorAll(".side-attn-line")).toHaveLength(4);
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("shows protected global links in sync context even without projects", async () => {
    const client = makeQueryClient();
    primeRegistry(client, registryWith({ projects: {} }));
    const env = structuredClone(sampleSyncReportEnvelope);
    env.report.global.skills.skipped_unowned = 4;
    mockSyncReport(env);
    client.setQueryData(qk.syncReport(), env);
    renderWithProviders(<SyncReportDrawer open onClose={() => {}} />, { client });
    expect(await screen.findByText(/4 global links belong to another installation/)).toBeVisible();
  });
});

it("inspects sub-agents for installed harnesses enabled through a project", async () => {
  useAppStore.setState({ harnesses: harnessFixture.map((h) => ({ ...h, on_globally: false, used_by_projects: h.id === "claude-code" ? ["moon-base"] : [] })) });
  renderPanel("/harnesses");
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((call) => call[0] === "subagent_list")).toHaveLength(1));
  // `harnessId` (not `harness`) is the real invoke key, and `listSubagents`
  // omits it for claude-code — see lib/subagents.ts's `harnessArg`.
  const args = vi.mocked(invoke).mock.calls.find((call) => call[0] === "subagent_list")?.[1];
  expect(args).not.toHaveProperty("harnessId");
});
