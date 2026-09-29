import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import { Harnesses } from "@/screens/Harnesses";
import { HarnessConfig } from "@/screens/HarnessConfig";
import { useAppStore, type HarnessStatus } from "@/store";
import type { Registry } from "@/types";
import { PROJECT_ACTIVITY_KEY } from "@/lib/projectActivity";
import {
  renderWithProviders,
  primeRegistry,
  sampleRegistry,
  makeQueryClient,
} from "./helpers";

function setHarnesses(
  list: Array<Partial<HarnessStatus> & {
    id: string;
    label: string;
    installed: boolean;
    on_globally: boolean;
  }>,
) {
  useAppStore.setState({
    mutating: false,
    harnesses: list.map((h) => ({ used_by_projects: [], ...h })),
  });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

beforeEach(() => {
  useAppStore.setState({ mutating: false, harnesses: [] });
});

describe("Harnesses — no-active-harness banner (F7)", () => {
  it("shows the banner when a harness is enabled globally but none installed", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: false, on_globally: true },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.getByText(/No active harness/)).toBeInTheDocument();
    expect(
      screen.getByText(/synced skills won't reach any harness yet/),
    ).toBeInTheDocument();
  });

  it("hides the banner when an enabled harness is installed", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: true, on_globally: true },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.queryByText(/No active harness/)).not.toBeInTheDocument();
  });

  it("hides the banner when nothing is enabled globally", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: false, on_globally: false },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.queryByText(/No active harness/)).not.toBeInTheDocument();
  });
});

describe("Harnesses — Sub-agents link row", () => {
  const agents = {
    supported: true,
    format: "md",
    agents_dir: "~/.claude/agents",
    project_agents_dir: ".claude/agents",
  } as const;

  it("renders a disabled row that names the reason when installed but not enabled", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: true, on_globally: false, agents },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    const row = screen.getByRole("button", { name: /Sub-agents/i });
    expect(row).toBeDisabled();
    expect(row).toHaveAccessibleName(/enable Claude Code first/i);
    expect(row).toHaveAttribute("title", "Enable Claude Code first");
  });

  it("omits the row when not installed, and marks only an on-globally card", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: false, on_globally: false, agents },
      { id: "codex", label: "Codex", installed: true, on_globally: true },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.queryByRole("button", { name: /Sub-agents/i })).toBeNull();
    const cards = container.querySelectorAll(".harness-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).not.toHaveAttribute("data-on-globally");
    expect(cards[1]).toHaveAttribute("data-on-globally", "true");
  });

  it("keeps the installed badge named when its label collapses", () => {
    setHarnesses([
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.getByRole("img", { name: "installed" })).toBeInTheDocument();
  });
});

describe("Harnesses — global instruction-doc affordance", () => {
  it("renders an Instructions affordance per harness with a global_doc", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(
      screen.getByRole("button", { name: /Global instructions/i }),
    ).toBeInTheDocument();
    // The doc filename renders in mono inside the instructions affordance.
    const affordance = container.querySelector(".harness-card-instructions");
    expect(affordance?.textContent).toContain("CLAUDE.md");
  });

  it("shows a 'not created' hint when the global doc is missing", () => {
    setHarnesses([
      {
        id: "codex",
        label: "Codex",
        installed: true,
        on_globally: false,
        global_doc: "/home/test/.codex/AGENTS.md",
        global_doc_exists: false,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.getByText(/not created/i)).toBeInTheDocument();
  });

  it("navigates to /harness/:id/doc on click", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { client } = renderWithProviders(
      <>
        <Harnesses />
        <LocationProbe />
      </>,
    );
    primeRegistry(client);
    fireEvent.click(
      screen.getByRole("button", { name: /Global instructions/i }),
    );
    expect(screen.getByTestId("loc").textContent).toBe(
      "/harness/claude-code/doc",
    );
  });

  it("omits the affordance for a harness without a global_doc", () => {
    setHarnesses([
      {
        id: "mystery",
        label: "Mystery",
        installed: true,
        on_globally: false,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(
      screen.queryByRole("button", { name: /Global instructions/i }),
    ).not.toBeInTheDocument();
  });
});

/** `hub harness doc status --json` (global-doc-sharing) drives the
 *  Instructions hint's state-aware priority — see `InstructionsLink`. */
function mockDocStatus(rows: unknown[]) {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
    if (cmd === "hub_cmd") {
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (
        cmdArgs[0] === "harness" &&
        cmdArgs[1] === "doc" &&
        cmdArgs[2] === "status"
      ) {
        return { success: true, output: JSON.stringify(rows) };
      }
      return { success: true, output: "" };
    }
    return undefined;
  }) as never);
}

describe("Harnesses — global instruction-doc state-aware hint (B2)", () => {
  it("a follower reads 'follows Claude Code'", async () => {
    mockDocStatus([
      {
        harness: "codex",
        label: "Codex",
        path: "/home/test/.codex/AGENTS.md",
        state: "follows",
        follows: "claude-code",
        followers: [],
        bytes: null,
      },
    ]);
    setHarnesses([
      {
        id: "codex",
        label: "Codex",
        installed: true,
        on_globally: false,
        global_doc: "/home/test/.codex/AGENTS.md",
        global_doc_exists: true,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    await waitFor(() =>
      expect(screen.getByText(/follows Claude Code/i)).toBeInTheDocument(),
    );
  });

  it("a source with followers reads 'shared with N'", async () => {
    mockDocStatus([
      {
        harness: "claude-code",
        label: "Claude Code",
        path: "/home/test/.claude/CLAUDE.md",
        state: "source",
        follows: null,
        followers: ["codex", "pi"],
        bytes: 24,
      },
    ]);
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    await waitFor(() =>
      expect(screen.getByText(/shared with 2/i)).toBeInTheDocument(),
    );
  });

  it("ONE follower is named, not counted", async () => {
    // "shared with 1" makes the reader open the card to learn the one fact the
    // line exists for. Naming it is the same width and answers the question.
    mockDocStatus([
      {
        harness: "claude-code",
        label: "Claude Code",
        path: "/home/test/.claude/CLAUDE.md",
        state: "source",
        follows: null,
        followers: ["codex"],
        bytes: 24,
      },
    ]);
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    await waitFor(() =>
      expect(screen.getByText(/shared with Codex/)).toBeInTheDocument(),
    );
  });

  it("a failed status scan degrades to the plain filename, with no error card", async () => {
    // `hub harness doc status` is one CLI call away from a degraded install
    // (no python3). The card must lose the hint, not the screen.
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "hub_cmd") {
        return { success: false, output: "python3: command not found\n" };
      }
      return undefined;
    }) as never);
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    await waitFor(() =>
      expect(screen.getByText("Global instructions")).toBeInTheDocument(),
    );
    const hint = container.querySelector(
      ".harness-card-instructions .harness-card-link-hint",
    );
    expect(hint?.textContent).toBe("CLAUDE.md");
    expect(hint?.querySelector(".status-badge")).toBeNull();
  });

  it("a broken link reads 'broken link' with a warn dot before it", async () => {
    mockDocStatus([
      {
        harness: "codex",
        label: "Codex",
        path: "/home/test/.codex/AGENTS.md",
        state: "broken",
        follows: "claude-code",
        followers: [],
        bytes: null,
      },
    ]);
    setHarnesses([
      {
        id: "codex",
        label: "Codex",
        installed: true,
        on_globally: false,
        global_doc: "/home/test/.codex/AGENTS.md",
        global_doc_exists: false,
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    await waitFor(() =>
      expect(screen.getByText(/broken link/i)).toBeInTheDocument(),
    );
    expect(
      container.querySelector(".harness-card-link-hint .status-badge"),
    ).toBeInTheDocument();
  });
});

/**
 * B7 — `/harness/:id` for a harness whose config surface isn't built yet used
 * to be a terminal "coming soon" card with nothing to click. The one thing the
 * harness DOES expose today is its global instruction file, so the screen hands
 * the user there instead of dead-ending them.
 */
describe("HarnessConfig — coming-soon is not a dead end", () => {
  const routed = (
    <Routes>
      <Route path="/harness/:id" element={<HarnessConfig />} />
      <Route path="/harnesses" element={<div data-testid="harness-list" />} />
    </Routes>
  );

  it("offers the instruction-file editor for a known unsupported harness", () => {
    setHarnesses([
      { id: "pi", label: "Pi", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(
      <>
        {routed}
        <LocationProbe />
      </>,
      { initialRoute: "/harness/pi" },
    );
    primeRegistry(client);

    expect(screen.getByText("Configuration coming soon")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("harness-config-doc"));
    expect(screen.getByTestId("loc").textContent).toBe("/harness/pi/doc");
  });

  it("still gives an unknown harness id a way back to the list", () => {
    setHarnesses([
      { id: "mystery", label: "Mystery", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(routed, {
      initialRoute: "/harness/mystery",
    });
    primeRegistry(client);

    expect(screen.queryByTestId("harness-config-doc")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to harnesses" }));
    expect(screen.getByTestId("harness-list")).toBeInTheDocument();
  });
});

const threeProjectRegistry: Registry = {
  ...sampleRegistry,
  projects: {
    apple: { path: "/projects/apple", bundles: [], enabled: [] },
    banana: { path: "/projects/banana", bundles: [], enabled: [] },
    cherry: { path: "/projects/cherry", bundles: [], enabled: [] },
  },
};

describe("Harnesses — used by", () => {
  it("a global harness with 3 registry projects and 1 pinned shows count 3, three chips, one pinned, and the hint", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: ["apple"],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });

    const card = container.querySelector(".harness-card");
    expect(card?.querySelector(".harness-users-head")?.textContent).toContain(
      "3",
    );
    const chips = card?.querySelectorAll(".harness-user-chip") ?? [];
    expect(chips).toHaveLength(3);
    const pinnedChips = card?.querySelectorAll(
      '.harness-user-chip[data-pinned="true"]',
    );
    expect(pinnedChips).toHaveLength(1);
    expect(pinnedChips?.[0].textContent).toContain("apple");
    expect(
      card?.querySelector(".harness-users-hint")?.textContent,
    ).toContain("every project · via the global switch");
    expect(
      card?.querySelector(".harness-users-hint")?.textContent,
    ).toContain("1 pinned");
  });

  it("a non-global harness with no pins shows the new empty copy", () => {
    setHarnesses([
      {
        id: "codex",
        label: "Codex",
        installed: true,
        on_globally: false,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    renderWithProviders(<Harnesses />, { client });

    expect(
      screen.getByText(
        "No project uses Codex. Turn on the global switch, or add it per project.",
      ),
    ).toBeInTheDocument();
  });

  it("clicking a via-global chip navigates to /project/<name>", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    renderWithProviders(
      <>
        <Harnesses />
        <LocationProbe />
      </>,
      { client },
    );

    fireEvent.click(screen.getByRole("button", { name: /banana/ }));
    expect(screen.getByTestId("loc").textContent).toBe("/project/banana");
  });
});

describe("Harnesses — open config directory", () => {
  it("renders a config row that opens the harness's config dir in Finder", async () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
        config_dir: "/Users/dev/.claude",
      },
    ]);
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "harness_open_dir") return undefined;
      return undefined;
    }) as never);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);

    const button = screen.getByRole("button", {
      name: /Open Claude Code config folder in Finder/i,
    });
    expect(button.textContent).toContain("~/.claude");
    fireEvent.click(button);
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("harness_open_dir", {
        harnessId: "claude-code",
      });
    });
  });

  it("shows the binary row only when a real binary differs from the config dir", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
        config_dir: "/Users/dev/.claude",
        path: "/usr/local/bin/claude",
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    const rows = container.querySelectorAll(".harness-meta-row");
    const binaryRow = Array.from(rows).find((r) =>
      r.textContent?.startsWith("binary"),
    );
    expect(binaryRow?.textContent).toContain("/usr/local/bin/claude");
  });

  it("hides the binary row when no real binary was found (path falls back to the config dir)", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
        config_dir: "/Users/dev/.claude",
        path: "/Users/dev/.claude",
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    const rows = container.querySelectorAll(".harness-meta-row");
    const binaryRow = Array.from(rows).find((r) =>
      r.textContent?.startsWith("binary"),
    );
    expect(binaryRow).toBeUndefined();
  });
});

const eightProjectNames = [
  "proj-a",
  "proj-b",
  "proj-c",
  "proj-d",
  "proj-e",
  "proj-f",
  "proj-g",
  "proj-h",
];
const eightProjectRegistry: Registry = {
  ...sampleRegistry,
  projects: Object.fromEntries(
    eightProjectNames.map((name) => [
      name,
      { path: `/projects/${name}`, bundles: [], enabled: [] },
    ]),
  ),
};

describe("Harnesses — used-by chips ordered by recency, truncated (A3)", () => {
  it("shows 6 chips + '+2 more', ordered most-recent-first from stored activity; expanding shows all 8 + 'Show less'", () => {
    // Seed a most-recent-first order that is the REVERSE of alphabetical, so
    // a pass that accidentally fell back to alpha order would fail loudly.
    const seeded = Object.fromEntries(
      eightProjectNames.map((name, i) => {
        const ts = new Date(2026, 8, 1 + i, 12, 0, 0).toISOString();
        return [name, { last: ts, byHarness: { "claude-code": ts } }];
      }),
    );
    localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify(seeded));

    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, eightProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });

    const card = container.querySelector(".harness-card");
    let chips = card?.querySelectorAll(
      ".harness-user-chip:not(.harness-users-more)",
    );
    expect(chips).toHaveLength(6);
    // Most-recent-first = reverse alphabetical here: proj-h..proj-c.
    expect(Array.from(chips ?? []).map((c) => c.textContent)).toEqual([
      "proj-h",
      "proj-g",
      "proj-f",
      "proj-e",
      "proj-d",
      "proj-c",
    ]);

    const moreButton = screen.getByRole("button", { name: "+2 more" });
    expect(moreButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(moreButton);

    chips = card?.querySelectorAll(".harness-user-chip:not(.harness-users-more)");
    expect(chips).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not render a more/less button when effective fits within the cap", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    renderWithProviders(<Harnesses />, { client });

    expect(
      screen.queryByRole("button", { name: /more/ }),
    ).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial coverage for the `effective` derivation (wave A review).
// ─────────────────────────────────────────────────────────────────────────────

function projectRegistry(
  names: string[],
  extra: Record<string, unknown> = {},
): Registry {
  return {
    ...sampleRegistry,
    projects: Object.fromEntries(
      names.map((name) => [
        name,
        { path: `/projects/${name}`, bundles: [], enabled: [], ...extra },
      ]),
    ),
  } as Registry;
}

function usedByChips(container: HTMLElement, cardIndex = 0): string[] {
  const card = container.querySelectorAll(".harness-card")[cardIndex];
  return Array.from(
    card?.querySelectorAll(".harness-user-chip:not(.harness-users-more)") ?? [],
  ).map((c) => c.textContent ?? "");
}

describe("Harnesses — used by, adversarial", () => {
  it("a project that is BOTH globally reached and pinned renders exactly one chip, marked pinned", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: ["banana"],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });

    const chips = usedByChips(container);
    expect(chips.filter((c) => c === "banana")).toHaveLength(1);
    expect(chips).toHaveLength(3);
    const pinnedChips = container.querySelectorAll(
      '.harness-user-chip[data-pinned="true"]',
    );
    expect(pinnedChips).toHaveLength(1);
    expect(pinnedChips[0].textContent).toContain("banana");
    // The pinned chip still says WHY it is pinned, not "via the global switch".
    expect(pinnedChips[0].getAttribute("title")).toContain(
      "pinned in this project's harnesses",
    );
  });

  it("an empty registry says no project is registered, never 'turn on the global switch' at a switch that is already on", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, projectRegistry([]));
    const { container } = renderWithProviders(<Harnesses />, { client });

    expect(
      container.querySelector(".harness-users-empty")?.textContent,
    ).toBe("No projects registered yet.");
    expect(
      container.querySelector(".harness-users-head")?.textContent,
    ).toContain("0");
    expect(screen.queryByText(/Turn on the global switch/)).toBeNull();
  });

  it("a pinned project that no longer exists in the registry is dropped from a globally-on card", () => {
    // The Rust command derives `used_by_projects` from the same registry, so
    // this only happens transiently (a removed/renamed project between the two
    // queries). The global set is authoritative: no chip to a dead route.
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: ["ghost"],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });

    expect(usedByChips(container)).toEqual(["apple", "banana", "cherry"]);
    expect(
      container.querySelector(".harness-users-head")?.textContent,
    ).toContain("3");
    expect(
      container.querySelectorAll('.harness-user-chip[data-pinned="true"]'),
    ).toHaveLength(0);
  });

  it("a project with no `harnesses:` key of its own is still reached by a globally-on harness", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    // `harnesses` deliberately absent on every project — the global switch is
    // the only thing putting them on this card.
    primeRegistry(client, projectRegistry(["apple", "banana"]));
    const { container } = renderWithProviders(<Harnesses />, { client });
    expect(usedByChips(container)).toEqual(["apple", "banana"]);
  });

  it("survives a payload with no `used_by_projects` at all (pre-field fixture)", () => {
    useAppStore.setState({
      mutating: false,
      harnesses: [
        {
          id: "claude-code",
          label: "Claude Code",
          installed: true,
          on_globally: true,
        },
        {
          id: "codex",
          label: "Codex",
          installed: true,
          on_globally: false,
        },
      ] as unknown as HarnessStatus[],
    });
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });

    // Global card still lists every project; the non-global one is empty
    // instead of throwing on `undefined.length`.
    expect(usedByChips(container, 0)).toEqual(["apple", "banana", "cherry"]);
    expect(usedByChips(container, 1)).toEqual([]);
    expect(
      screen.getByText(
        "No project uses Codex. Turn on the global switch, or add it per project.",
      ),
    ).toBeInTheDocument();
  });

  it("counts a globally-on harness that is NOT installed against every project (documented behaviour)", () => {
    // Effective harnesses are intersected with `installed` at SYNC time
    // (CLAUDE.md §Data Model), so this card's count is "configured for",
    // not "reaching". The not-installed state and the no-active-harness
    // banner carry that caveat; change this deliberately, not by accident.
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: false,
        on_globally: true,
        used_by_projects: [],
      },
    ]);
    const client = makeQueryClient();
    primeRegistry(client, threeProjectRegistry);
    const { container } = renderWithProviders(<Harnesses />, { client });
    expect(usedByChips(container)).toHaveLength(3);
  });

  it("omits the config row (and keeps the detected fallback) when the schema declares no config dir", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: false,
        used_by_projects: [],
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(
      screen.queryByRole("button", { name: /config folder in Finder/i }),
    ).toBeNull();
    const rows = Array.from(container.querySelectorAll(".harness-meta-row"));
    expect(
      rows.some((r) => r.textContent?.startsWith("status")),
    ).toBe(true);
  });
});

describe("Harnesses — used-by truncation boundaries", () => {
  function renderWithProjects(count: number, harnessIds = ["claude-code"]) {
    const names = Array.from({ length: count }, (_, i) => `proj-${i + 1}`);
    setHarnesses(
      harnessIds.map((id) => ({
        id,
        label: id,
        installed: true,
        on_globally: true,
        used_by_projects: [],
      })),
    );
    const client = makeQueryClient();
    primeRegistry(client, projectRegistry(names));
    return renderWithProviders(<Harnesses />, { client });
  }

  it("shows all 6 with no more/less button at exactly the cap", () => {
    const { container } = renderWithProjects(6);
    expect(usedByChips(container)).toHaveLength(6);
    expect(
      container.querySelectorAll(".harness-users-more"),
    ).toHaveLength(0);
  });

  it("shows 6 + '+1 more' at one over the cap", () => {
    const { container } = renderWithProjects(7);
    expect(usedByChips(container)).toHaveLength(6);
    const more = screen.getByRole("button", { name: "+1 more" });
    fireEvent.click(more);
    expect(usedByChips(container)).toHaveLength(7);
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
  });

  it("wires aria-controls at a real element", () => {
    renderWithProjects(9);
    const more = screen.getByRole("button", { name: "+3 more" });
    const controls = more.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).not.toBeNull();
  });

  it("keeps the expanded state per card — expanding one does not expand another", () => {
    const { container } = renderWithProjects(8, ["claude-code", "codex"]);
    expect(usedByChips(container, 0)).toHaveLength(6);
    expect(usedByChips(container, 1)).toHaveLength(6);

    const moreButtons = screen.getAllByRole("button", { name: "+2 more" });
    expect(moreButtons).toHaveLength(2);
    fireEvent.click(moreButtons[0]);

    expect(usedByChips(container, 0)).toHaveLength(8);
    expect(usedByChips(container, 1)).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: "Show less" })).toHaveLength(1);
  });
});

describe("Harnesses — open config directory, failure path", () => {
  it("surfaces the Rust error (which names the missing folder) as a toast", async () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: false,
        used_by_projects: [],
        config_dir: "/Users/dev/.claude",
      },
    ]);
    useAppStore.setState({ toasts: [] });
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "harness_open_dir") {
        // The shape `require_existing_dir` returns for a harness whose config
        // dir has not been created yet.
        throw "/Users/dev/.claude does not exist";
      }
      return undefined;
    }) as never);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);

    fireEvent.click(
      screen.getByRole("button", { name: /config folder in Finder/i }),
    );
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.map((t) => t.title)).toContain("Couldn't open folder");
      expect(toasts[0].body).toContain("/Users/dev/.claude does not exist");
      expect(toasts[0].kind).toBe("error");
    });
  });
});

describe("unavailable harness remediation", () => {
  it("allows disabling an unavailable global harness but keeps enabling unavailable harnesses disabled", async () => {
    setHarnesses([
      { id: "opencode", label: "opencode", installed: false, on_globally: true },
      { id: "codex", label: "Codex", installed: false, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    const enabled = screen.getByRole("checkbox", { name: "Enable opencode globally" });
    expect(enabled).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Enable Codex globally" })).toBeDisabled();
    fireEvent.click(enabled);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("harness_set_global", { id: "opencode", enabled: false }));
  });
});
