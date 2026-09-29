import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { UsageSessionsCard } from "@/screens/usage/UsageSessionsCard";
import { renderWithProviders } from "./helpers";
import type {
  UsageSessionRow,
  UsageTokenCounts,
} from "@/features/usage/usageTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

/** Open a themed `<Select>` by its accessible (aria-)label and pick one
 *  option by its rendered text — same helper `LocalAgentUsage.test.tsx` uses. */
function pickSelectOption(label: string, optionName: string) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function tok(
  input: number,
  output: number,
  cacheCreation = 0,
  cacheRead = 0,
): UsageTokenCounts {
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead,
  };
}

function session(
  overrides: Partial<UsageSessionRow> & { id: string },
): UsageSessionRow {
  return {
    period: overrides.id,
    harnessId: "claude",
    harnessName: "Claude Code",
    models: [],
    modelBreakdown: [],
    tokens: tok(100, 20),
    estimatedCost: { usd: 1, label: "Estimated API-equivalent cost" },
    ...overrides,
  };
}

/** A rich Claude Code session carrying every optional fact — title, branch,
 *  PR, tool breakdown (with sub-agents), lines, duration, last activity, a
 *  hub project. */
const sessionRich = session({
  id: "s-rich",
  title: "Session Alpha",
  harnessId: "claude",
  harnessName: "Claude Code",
  tokens: tok(74_000, 16_400, 6_100, 3_500),
  estimatedCost: { usd: 14.28, label: "Estimated API-equivalent cost" },
  models: ["claude-sonnet-4"],
  modelBreakdown: [],
  toolCalls: 212,
  toolBreakdown: [
    { name: "Bash", count: 169 },
    { name: "Read", count: 24 },
    { name: "Edit", count: 12 },
    { name: "Write", count: 8 },
    { name: "Agent", count: 5 },
    { name: "Grep", count: 4 },
  ],
  linesAdded: 2_529,
  linesRemoved: 1_421,
  durationMs: 5_268_720,
  lastActivity: "2026-07-14T20:41:00Z",
  branch: "design/snippets",
  pr: { number: 90, url: "https://github.com/acme/skill-tree/pull/90" },
  hubProject: "skill-tree",
});

/** A Codex session with a real per-model breakdown (two models, different
 *  costs) and Codex-only reasoning tokens. */
const sessionModels = session({
  id: "s-models",
  harnessId: "codex",
  harnessName: "Codex",
  tokens: tok(19_000, 5_600, 1_500, 1_900),
  estimatedCost: { usd: 2.72, label: "Estimated API-equivalent cost" },
  models: ["gpt-5.5", "gpt-5.4-mini"],
  modelBreakdown: [
    {
      modelName: "gpt-5.4-mini",
      tokens: tok(6_000, 1_800, 500, 700),
      estimatedCost: { usd: 0.88, label: "Estimated API-equivalent cost" },
    },
    {
      modelName: "gpt-5.5",
      tokens: tok(13_000, 3_800, 1_000, 1_200),
      estimatedCost: { usd: 1.84, label: "Estimated API-equivalent cost" },
    },
  ],
  reasoningOutputTokens: 2_050,
  hubProject: "codex-lab",
});

/** A session carrying only the required fields — no title, no tool data, no
 *  lines/duration/lastActivity, no branch/PR, no hub project, and a single
 *  plain model name with no per-model breakdown. */
const sessionBare = session({
  id: "s-bare",
  harnessId: "claude",
  harnessName: "Claude Code",
  tokens: tok(4_500, 500),
  estimatedCost: { usd: 0.2, label: "Estimated API-equivalent cost" },
  models: ["claude-sonnet-4"],
  modelBreakdown: [],
});

/** A session with a real but tiny cache-read/cache-write share — the shape
 *  a plain integer-rounded percentage would misreport as "0%". */
const sessionTinyShare = session({
  id: "s-tiny",
  harnessId: "claude",
  harnessName: "Claude Code",
  tokens: tok(99_000, 900, 90, 10),
  estimatedCost: { usd: 5, label: "Estimated API-equivalent cost" },
  models: ["claude-sonnet-4"],
});

/** A pi session whose tool breakdown happens to carry Agent/Task calls too —
 *  sub-agent counting is Claude-Code-only, so this must NOT show the line. */
const sessionPiAgentTool = session({
  id: "s-pi",
  harnessId: "pi",
  harnessName: "pi-agent",
  tokens: tok(3_000, 400),
  estimatedCost: { usd: 0.1, label: "Estimated API-equivalent cost" },
  toolCalls: 9,
  toolBreakdown: [
    { name: "Agent", count: 3 },
    { name: "Task", count: 2 },
  ],
  hubProject: "pi-lab",
});

/** A Claude Code session whose id is a full RFC-4122 UUID — the shape
 *  `ledgerSessionIdFor` (design D14.7) requires before it offers a
 *  `Timeline` action at all. Every OTHER fixture in this file uses a plain
 *  slug id, on purpose (see `baseProps`'s comment), so this is the only one
 *  the Timeline tests below use. */
const sessionTimelineReady = session({
  id: "1dae0a69-6f00-4109-ab1c-873861269996",
  harnessId: "claude",
  harnessName: "Claude Code",
  // `hasActivity` in `UsageSessionDetail` requires at least one of these
  // before it renders the `Inspect session` button at all — without one,
  // the Timeline/Inspect coexistence tests below would find neither.
  toolCalls: 5,
});

function baseProps() {
  return {
    effectiveShowFullPaths: false,
    onShowFullPathsChange: vi.fn(),
    hasFullFidelityData: true,
    busy: false,
    onRunFreshScan: vi.fn(),
    currency: "USD" as const,
    eurRate: 0.86,
    // Every existing fixture session's `id`/`period` is a plain slug, not a
    // UUID, so `ledgerSessionIdFor` returns null for all of them regardless
    // of `scanned` — these pre-existing tests never exercise `Timeline`.
    scanned: true,
    analysedSessions: undefined as readonly string[] | undefined,
    onOpenTimeline: vi.fn(),
  };
}

function renderCard(sessions: UsageSessionRow[], overrides: Partial<ReturnType<typeof baseProps>> = {}) {
  // `renderWithProviders`, not a plain `render`: the card now always embeds
  // `UsageSessionSheet` (the drill-down sheet, closed by default), which
  // reads the captured inspection index — a `useQuery` needs a
  // `QueryClientProvider` ancestor even while its own query is disabled.
  return renderWithProviders(
    <UsageSessionsCard sessions={sessions} {...baseProps()} {...overrides} />,
  );
}

describe("UsageSessionsCard", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockClear();
  });

  it("expands and collapses the detail panel on row click, mirrored by aria-expanded", async () => {
    renderCard([sessionRich]);
    const row = screen.getByTestId("usage-session-row");

    expect(
      within(row).getByRole("button", { name: "Show session details" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(within(row).queryByText("Tokens")).not.toBeInTheDocument();

    await userEvent.click(row);
    expect(
      within(row).getByRole("button", { name: "Hide session details" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("Tokens")).toBeInTheDocument();

    await userEvent.click(row);
    expect(
      within(row).getByRole("button", { name: "Show session details" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(within(row).queryByText("Tokens")).not.toBeInTheDocument();
  });

  it("toggles the detail with Enter on the focused row", () => {
    renderCard([sessionRich]);
    const row = screen.getByTestId("usage-session-row");

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(
      within(row).getByRole("button", { name: "Hide session details" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the PR link without toggling the row", async () => {
    renderCard([sessionRich]);
    const row = screen.getByTestId("usage-session-row");

    await userEvent.click(within(row).getByRole("button", { name: "PR #90" }));

    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/skill-tree/pull/90",
    );
    expect(
      within(row).getByRole("button", { name: "Show session details" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the four token figures once (in the composition legend) and Reasoning only for a session that carries it", async () => {
    renderCard([sessionRich, sessionModels]);
    const rows = screen.getAllByTestId("usage-session-row");

    await userEvent.click(rows[0]);
    const tokensBlock = within(
      rows[0].querySelector(".usage-detail-block") as HTMLElement,
    );
    for (const label of ["Input", "Output", "Cache write", "Cache read"]) {
      // Exactly once: the legend carries the figure; no key/value list repeats it.
      expect(tokensBlock.getAllByText(label)).toHaveLength(1);
    }
    expect(tokensBlock.queryByText("Reasoning")).not.toBeInTheDocument();

    await userEvent.click(rows[1]);
    const modelsTokens = within(
      rows[1].querySelector(".usage-detail-block") as HTMLElement,
    );
    expect(modelsTokens.getByText("Reasoning")).toBeInTheDocument();
    expect(modelsTokens.getByText("2.1k")).toBeInTheDocument();
  });

  it("never prints 0% for a non-zero token segment in the session composition", async () => {
    renderCard([sessionTinyShare]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    const pcts = Array.from(row.querySelectorAll(".comp-bar-legend-pct")).map((el) => el.textContent);
    // Every segment here is non-zero (10 cache-read tokens included), so
    // none of them may read the same "0%" a truly empty segment would.
    expect(pcts).not.toContain("0%");
    expect(pcts).toContain("<0.1%");
  });

  it("lists real per-model breakdown rows sorted by cost, descending", async () => {
    renderCard([sessionModels]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    const bars = within(row).getAllByRole("listitem");
    const labels = bars.map((el) => el.textContent ?? "");
    // Display names, not the raw ids — a model row reads the same way here
    // as it does in the screen-wide Top models card.
    expect(labels[0]).toContain("GPT-5.5");
    expect(labels[1]).toContain("GPT-5.4 mini");
  });

  it("shows display model names in the session detail", async () => {
    renderCard([sessionModels]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).getByText("GPT-5.5")).toBeInTheDocument();
    expect(within(row).getByText("GPT-5.4 mini")).toBeInTheDocument();
    // The raw id survives on hover.
    expect(within(row).getByText("GPT-5.5").closest(".usage-model-name")).toHaveAttribute(
      "title",
      "gpt-5.5",
    );
  });

  it("falls back to plain model names when there is no real breakdown", async () => {
    renderCard([sessionBare]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    // "claude-sonnet-4" is now a readable display name in BOTH the row's own
    // collapsed meta line and the expanded detail's fallback list — scope to
    // the detail panel, the one this test is actually about.
    const detail = within(row.querySelector(".usage-session-detail") as HTMLElement);
    expect(detail.getByText("Sonnet 4")).toBeInTheDocument();
    expect(detail.getByText("Sonnet 4").closest(".usage-model-name")).toHaveAttribute(
      "title",
      "claude-sonnet-4",
    );
    expect(row.querySelectorAll(".hbar-row")).toHaveLength(0);
  });

  it("shows sub-agents spawned only for Claude Code, from Agent/Task tool counts", async () => {
    renderCard([sessionRich, sessionPiAgentTool]);
    const rows = screen.getAllByTestId("usage-session-row");

    await userEvent.click(rows[0]);
    expect(within(rows[0]).getByText("Sub-agents spawned")).toBeInTheDocument();

    await userEvent.click(rows[1]);
    expect(
      within(rows[1]).queryByText("Sub-agents spawned"),
    ).not.toBeInTheDocument();
  });

  it("caps top tools at 5 and appends a +N more clause", async () => {
    renderCard([sessionRich]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    const toolsLine = within(row).getByText(/Bash 169/);
    expect(toolsLine.textContent).toContain("Bash 169");
    expect(toolsLine.textContent).toContain("Read 24");
    expect(toolsLine.textContent).toContain("Agent 5");
    expect(toolsLine.textContent).not.toContain("Grep");
    expect(toolsLine.textContent).toContain("+1 more");
  });

  it("keeps an unavailable removed-line count distinct from observed zero", async () => {
    renderCard([session({ id: "partial-lines", linesAdded: 4 })]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);
    expect(within(row).getByText("+4 / removed unavailable")).toBeInTheDocument();
    expect(within(row).queryByText("+4 / −0")).not.toBeInTheDocument();
  });

  it("shows lines changed and duration only when present", async () => {
    renderCard([sessionRich, sessionBare]);
    const rows = screen.getAllByTestId("usage-session-row");

    await userEvent.click(rows[0]);
    expect(within(rows[0]).getByText("Lines changed")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Duration")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/1h 27m/)).toBeInTheDocument();

    await userEvent.click(rows[1]);
    expect(
      within(rows[1]).queryByText("Lines changed"),
    ).not.toBeInTheDocument();
    expect(within(rows[1]).queryByText("Duration")).not.toBeInTheDocument();
  });

  it("renders no Activity block for a session with none of the optional facts", async () => {
    renderCard([sessionBare]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).queryByText("Activity")).not.toBeInTheDocument();
    expect(within(row).queryByText("Session id")).not.toBeInTheDocument();
    // Tokens (and, for this session, Models) still render.
    expect(within(row).getByText("Tokens")).toBeInTheDocument();
  });

  it("narrows the list with the Project filter", () => {
    renderCard([sessionRich, sessionModels, sessionBare]);
    expect(screen.getAllByTestId("usage-session-row")).toHaveLength(3);

    pickSelectOption("Project", "skill-tree");
    const rows = screen.getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Session Alpha")).toBeInTheDocument();
  });

  it("switches the heading between Largest sessions and Recent sessions with the sort", () => {
    renderCard([sessionRich]);
    expect(
      screen.getByRole("heading", { name: "Largest sessions" }),
    ).toBeInTheDocument();

    pickSelectOption("Sort", "Most recent");
    expect(
      screen.getByRole("heading", { name: "Recent sessions" }),
    ).toBeInTheDocument();
  });

  it("carries the exact input/output token split in the row description", () => {
    renderCard([sessionRich]);
    const row = screen.getByTestId("usage-session-row");
    expect(within(row).getByText(/74k in/)).toBeInTheDocument();
    expect(within(row).getByText(/16.4k out/)).toBeInTheDocument();
    // The split comes BEFORE the model list, so a long model list is what a
    // narrow row truncates — never the figures the row exists to show.
    const desc =
      row.querySelector(".resource-desc, .row-desc, [class*='desc']")
        ?.textContent ??
      row.textContent ??
      "";
    // "claude-sonnet-4" now reads as its display name ("Sonnet 4") — the raw
    // id survives on hover instead.
    expect(desc.indexOf("74k in")).toBeLessThan(desc.indexOf("Sonnet 4"));
    expect(within(row).getByText("Sonnet 4").closest("span")).toHaveAttribute(
      "title",
      "claude-sonnet-4",
    );
  });

  it("does not badge a scanned Codex row, but still needs a ledger UUID for Timeline", async () => {
    renderCard([sessionModels]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).queryByText("No analysis for Codex")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
  });

  it("never offers Timeline for a scannerless codex row, even with a uuid id once scanned", async () => {
    const codexUuid = session({
      ...sessionModels,
      id: "0199ab12-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
      period: "2026/09/08/rollout-2026-09-08T15-30-00-0199ab12-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    });
    renderCard([codexUuid], { scanned: true, analysedSessions: [] });
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).getByText("Not analysed yet")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
  });

  it("offers one inspection action for an analysed Codex row", async () => {
    const codexUuid = "0199ab12-3c4d-7e5f-8a9b-0c1d2e3f4a5b";
    const codex = session({ ...sessionModels, id: codexUuid, period: `2026/09/08/rollout-2026-09-08T15-30-00-${codexUuid}` });
    renderCard([codex], { analysedSessions: [`codex:${codexUuid}`] });
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);
    expect(within(row).queryByText("Not analysed yet")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Inspect session" })).toBeInTheDocument();
  });

  it("opens the inspection overlay without a redundant Timeline action", async () => {
    const onOpenTimeline = vi.fn();
    renderCard([sessionTimelineReady], { onOpenTimeline });
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).queryByText("not analysed yet")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Inspect session" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Inspect session" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(onOpenTimeline).not.toHaveBeenCalled();
  });

  it("suppresses Timeline on every row while the last scan is unknown (scanned=false)", async () => {
    renderCard([sessionTimelineReady], { scanned: false });
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);

    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
    // The pre-existing Inspect affordance is untouched by the gate.
    expect(within(row).getByRole("button", { name: "Inspect session" })).toBeInTheDocument();
  });

  it("does not toggle the row when Inspect session is clicked", async () => {
    renderCard([sessionTimelineReady]);
    const row = screen.getByTestId("usage-session-row");
    await userEvent.click(row);
    await userEvent.click(within(row).getByRole("button", { name: "Inspect session" }));

    expect(
      within(row).getByRole("button", { name: "Hide session details" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
