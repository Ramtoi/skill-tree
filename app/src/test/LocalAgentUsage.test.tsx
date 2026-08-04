import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { LocalAgentUsage } from "@/screens/LocalAgentUsage";
import { renderWithProviders, makeQueryClient } from "./helpers";
import type { UsageDiagnostic, UsageScan } from "@/features/usage/usageTypes";

describe("LocalAgentUsage", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders visible route chrome and a first-run empty cached state", async () => {
    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(screen.getByText("Local Agent Usage")).toBeInTheDocument();
    expect(screen.getByText("Runs locally · No raw prompts uploaded")).toBeInTheDocument();
    expect(screen.getByText("Loading latest cached scan…")).toBeInTheDocument();
    expect(await screen.findByText("No cached usage scan yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Scan local usage/i }).length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_load_latest_ccusage");
  });

  it("renders polished success metrics, harness/source rows, daily chart, and sessions", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(await screen.findByLabelText("Cached usage summary")).toBeInTheDocument();
    expect(screen.getByLabelText("Usage overview metrics")).toHaveTextContent("Total tokens");
    expect(screen.getAllByText("1,200").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Estimated API-equivalent cost")).toBeInTheDocument();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Codex: no usage/)).toBeInTheDocument();
    expect(screen.getByLabelText("Daily usage chart")).toHaveTextContent("07-14");
    expect(screen.getByLabelText("Largest sessions")).toHaveTextContent("Project A");
    expect(screen.queryByText("/Users/alice/private/skill-tree")).not.toBeInTheDocument();
    expect(screen.getByText(/Estimated API-equivalent cost; not an invoice/)).toBeInTheDocument();
  });

  it("supports harness filtering and sorting of the sessions table", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ includeCodexSession: true });
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    const sessions = await screen.findByLabelText("Largest sessions");
    expect(sessions).toHaveTextContent("Project A");
    expect(sessions).toHaveTextContent("Project B");

    await userEvent.selectOptions(screen.getByLabelText("Harness"), "codex");
    const sessionRows = within(sessions).getAllByRole("row");
    expect(sessionRows[1]).toHaveTextContent("Codex");
    expect(sessionRows[1]).not.toHaveTextContent("Claude Code");

    // Sorting still works without touching the full-paths toggle.
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "cost");
    expect(within(sessions).getAllByRole("row").length).toBeGreaterThanOrEqual(2);
  });

  it("disables the full-paths toggle over cache-only data and never reveals a redacted path", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      // Only the on-disk (redacted) cache is available — no live scan this session.
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Cached usage summary");

    const toggle = screen.getByLabelText("Show full paths");
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Cached data hides full paths for privacy/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run a fresh scan/i })).toBeInTheDocument();
    // Honest coverage copy: Claude Code and pi-agent report project paths.
    expect(screen.getByText(/currently Claude Code and pi-agent/)).toBeInTheDocument();

    // The redaction hash / real path must never render while cache-only.
    expect(screen.queryByText("/Users/alice/private/skill-tree")).not.toBeInTheDocument();
  });

  it("enables the full-paths toggle after a live scan and reveals the real path when checked", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByLabelText("Show full paths")).toBeDisabled();

    // Run a fresh (full-fidelity) scan.
    await userEvent.click(screen.getByRole("button", { name: /Refresh scan/i }));

    await waitFor(() => expect(screen.getByLabelText("Show full paths")).toBeEnabled());
    await userEvent.click(screen.getByLabelText("Show full paths"));
    expect(await screen.findByText("/Users/alice/private/skill-tree")).toBeInTheDocument();
  });

  it("does not refetch the redacted cache on window focus after a live scan", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("button", { name: /Refresh scan/i }));
    await waitFor(() => expect(screen.getByLabelText("Show full paths")).toBeEnabled());

    const loadCallsBefore = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "usage_load_latest_ccusage").length;

    // Fire a window-focus event. With `refetchOnWindowFocus: false` on the
    // `latest` query, the redacted disk cache must NOT be re-fetched (which would
    // flip provenance back to "cache" mid-session). makeQueryClient's staleTime:0
    // would otherwise make the query eligible for a focus refetch.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    focusManager.setFocused(undefined);

    const loadCallsAfter = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "usage_load_latest_ccusage").length;
    expect(loadCallsAfter).toBe(loadCallsBefore);
    // The toggle stays enabled (still full-fidelity).
    expect(screen.getByLabelText("Show full paths")).toBeEnabled();
  });

  it("exposes exactly one 'Show full paths' control after the Toggle swap", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Cached usage summary");
    // getByLabelText throws if there is more than one match.
    expect(screen.getByLabelText("Show full paths")).toBeInTheDocument();
  });

  it("shows a no-usage state after a successful empty scan", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return emptyScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(await screen.findByText("No local harness usage was detected yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry scan/i })).toBeInTheDocument();
  });

  it("shows permission and ccusage failure states with copy diagnostics and retry", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("permission denied reading Claude logs");

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(await screen.findByText("Skill Tree cannot access local usage logs")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Copy diagnostic/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("permission denied"));

    vi.mocked(invoke).mockResolvedValueOnce(sampleScan());
    await userEvent.click(screen.getByRole("button", { name: /Retry scan/i }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage"));
  });

  it("keeps the cached dashboard visible when a refresh fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") {
        // Benign "scan succeeded but found zero new rows" the Rust side reports as no_usage.
        throw { kind: "no_usage", message: "no new usage since the last scan" } satisfies UsageDiagnostic;
      }
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(await screen.findByLabelText("Cached usage summary")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Refresh scan/i }));

    // The refresh failure is surfaced non-destructively…
    expect(await screen.findByText(/Refresh failed — showing the last successful scan/)).toBeInTheDocument();
    // …and the previously populated dashboard is STILL rendered, not replaced by
    // the full-screen error state.
    expect(screen.getByLabelText("Cached usage summary")).toBeInTheDocument();
    expect(screen.getByLabelText("Usage overview metrics")).toBeInTheDocument();
    expect(screen.queryByText("ccusage could not finish the scan")).not.toBeInTheDocument();
  });

  it("maps structured UsageDiagnostic kinds to the correct error state", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "access",
      message: "EACCES: permission denied",
      stderr: "cannot read /Users/alice/.claude/logs/session.jsonl",
    } satisfies UsageDiagnostic);

    const accessClient = makeQueryClient();
    const view = renderWithProviders(<LocalAgentUsage />, { client: accessClient });
    expect(await screen.findByText("Skill Tree cannot access local usage logs")).toBeInTheDocument();
    view.unmount();

    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "no_usage",
      message: "ccusage found no usage rows",
    } satisfies UsageDiagnostic);

    const noUsageClient = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client: noUsageClient });
    expect(await screen.findByText("No usage found")).toBeInTheDocument();
  });

  it("redacts local paths from the copied diagnostic", async () => {
    const secretPath = "/Users/alice/.claude/projects/secret/session.jsonl";
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: "access",
      message: "EACCES: permission denied",
      stderr: `cannot read ${secretPath}`,
    } satisfies UsageDiagnostic);

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByText("Skill Tree cannot access local usage logs");
    await userEvent.click(screen.getByRole("button", { name: /Copy diagnostic/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("<redacted-path>"));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining(secretPath));
  });

  it("triggers a ccusage scan and replaces the cached summary", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return null;
      if (cmd === "usage_scan_ccusage") return sampleScan({ totalTokens: 2400 });
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByText("No cached usage scan yet");
    await userEvent.click(screen.getAllByRole("button", { name: /Scan local usage/i })[0]);

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage"),
    );
    await waitFor(() => expect(screen.getAllByText("2,400").length).toBeGreaterThanOrEqual(1));
  });

  it("respects the Date range filter for the chart instead of a fixed 14-day window", async () => {
    // 5 days: three within 7 days, two well outside.
    const daily = [
      dayRow(isoDaysAgo(0), 500),
      dayRow(isoDaysAgo(2), 400),
      dayRow(isoDaysAgo(4), 300),
      dayRow(isoDaysAgo(12), 200),
      dayRow(isoDaysAgo(20), 100),
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const client = makeQueryClient();
    const { container } = renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Daily usage chart");
    // Default "all" → all 5 bars.
    expect(container.querySelectorAll(".usage-chart-bar").length).toBe(5);

    await userEvent.selectOptions(screen.getByLabelText("Date range"), "7d");
    // Only the three within-7-days bars remain (not the old fixed 14).
    expect(container.querySelectorAll(".usage-chart-bar").length).toBe(3);
  });

  it("buckets a wide (>60 day) range into weekly bars and labels the chart weekly", async () => {
    const daily = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      return dayRow(d, 100 + i);
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const client = makeQueryClient();
    const { container } = renderWithProviders(<LocalAgentUsage />, { client });

    const chart = await screen.findByLabelText("Daily usage chart");
    const barCount = container.querySelectorAll(".usage-chart-bar").length;
    expect(barCount).toBeGreaterThan(0);
    expect(barCount).toBeLessThan(70); // week-bucketed → fewer bars than input days
    expect(chart).toHaveTextContent("Tokens by day (weekly)");
  });

  it("normalizes bar heights against the visible max and caps at the column ceiling", async () => {
    const daily = [
      dayRow("2026-07-10", 1000),
      dayRow("2026-07-11", 100),
      dayRow("2026-07-12", 100),
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const client = makeQueryClient();
    const { container } = renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Daily usage chart");
    const heights = Array.from(container.querySelectorAll<HTMLElement>(".usage-chart-bar")).map((el) =>
      parseFloat(el.style.height),
    );
    const max = Math.max(...heights);
    const min = Math.min(...heights);
    expect(max).toBe(96); // the window-max day hits the ceiling exactly, no clip
    expect(max).toBeGreaterThan(min); // real variation, not all collapsed to the floor
  });

  it("excludes unparseable-date rows from the chart while keeping sessions visible", async () => {
    const daily = [
      dayRow("2026-07-10", 500),
      dayRow("2026-07-11", 400),
      dayRow("2026-07-12", 300),
      dayRow("Unknown date", 999),
    ];
    const session = [
      {
        agent: "claude",
        period: "2026-07-12T10:00:00Z",
        inputTokens: 300,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 400,
        totalCost: 0.5,
        modelsUsed: ["claude-sonnet-5"],
      },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily, session);
      return null;
    });

    const client = makeQueryClient();
    const { container } = renderWithProviders(<LocalAgentUsage />, { client });

    const chart = await screen.findByLabelText("Daily usage chart");
    // Only the 3 parseable rows render as bars; "Unknown date" is dropped.
    expect(container.querySelectorAll(".usage-chart-bar").length).toBe(3);
    expect(chart).not.toHaveTextContent("Unknown date");
    // The session (parsed separately) is still visible in the table.
    expect(screen.getByLabelText("Largest sessions")).toHaveTextContent("Claude Code");
  });

  it("makes chart bars keyboard-focusable with an accessible label and no native title", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan([dayRow("2026-07-10", 500)]);
      return null;
    });

    const client = makeQueryClient();
    const { container } = renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Daily usage chart");
    const wrap = container.querySelector(".usage-chart-bar-wrap") as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute("tabindex")).toBe("0");
    expect(wrap.getAttribute("aria-label")).toMatch(/2026-07-10: 500 tokens/);
    // The native tooltip is gone — replaced by the accessible popover.
    expect(container.querySelector(".usage-chart-bar")?.getAttribute("title")).toBeNull();
  });

  it("filters sessions by free-text search and updates the count label", async () => {
    // 14 claude + 6 codex = 20 sessions.
    const session = [
      ...makeSessions("claude", 14, 0),
      ...makeSessions("codex", 6, 100),
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sessionsScan(session);
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    const sessions = await screen.findByLabelText("Largest sessions");
    expect(sessions).toHaveTextContent("Showing 10 of 20 sessions");

    await userEvent.type(screen.getByPlaceholderText("Search sessions…"), "codex");
    // 6 codex sessions match — narrowed below the collapsed cap, so all show and
    // the "Showing X of Y" footer disappears.
    expect(sessions).not.toHaveTextContent("Showing 10 of 20 sessions");
    const rows = within(sessions).getAllByRole("row");
    expect(rows.length - 1).toBe(6); // minus the header row
    rows.slice(1).forEach((row) => expect(row).toHaveTextContent("Codex"));
  });

  it("filters sessions by the Model select", async () => {
    const session = [
      ...makeSessions("claude", 3, 0, "claude-opus-4-8"),
      ...makeSessions("claude", 4, 50, "claude-haiku-4-5"),
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sessionsScan(session);
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    const sessions = await screen.findByLabelText("Largest sessions");
    await userEvent.selectOptions(screen.getByLabelText("Model"), "claude-opus-4-8");
    const rows = within(sessions).getAllByRole("row");
    expect(rows.length - 1).toBe(3);
  });

  it("expands the sessions list up to the 100 cap and drops the dead 'Show more' button", async () => {
    const session = makeSessions("claude", 105, 0);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sessionsScan(session);
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    const sessions = await screen.findByLabelText("Largest sessions");
    expect(sessions).toHaveTextContent("Showing 10 of 105 sessions");
    const showMore = screen.getByRole("button", { name: /Show 90 more/i });

    await userEvent.click(showMore);

    // Now filteredSessions === expandTarget (100): the button must be gone, not
    // stuck on a dead "Show 0 more", and only the ceiling note remains.
    expect(within(sessions).getAllByRole("row").length - 1).toBe(100);
    expect(screen.queryByRole("button", { name: /Show \d+ more/i })).not.toBeInTheDocument();
    expect(sessions).toHaveTextContent("Showing the first 100 matches");
  });

  it("never searches full paths even with full paths revealed", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("button", { name: /Refresh scan/i }));
    await waitFor(() => expect(screen.getByLabelText("Show full paths")).toBeEnabled());
    await userEvent.click(screen.getByLabelText("Show full paths"));
    // The full path is now shown in the cell…
    expect(await screen.findByText("/Users/alice/private/skill-tree")).toBeInTheDocument();

    // …but searching for a fragment of that path finds nothing, because the
    // search haystack uses the anonymized label only.
    await userEvent.type(screen.getByPlaceholderText("Search sessions…"), "skill-tree");
    const sessions = screen.getByLabelText("Largest sessions");
    expect(within(sessions).queryAllByRole("row").length - 1).toBe(0);
    expect(sessions).toHaveTextContent("No sessions match the selected filters");
  });
});

function sampleScan({ totalTokens = 1200, includeCodexSession = false } = {}): UsageScan {
  const session = [
    {
      agent: "claude",
      period: "2026-07-14T20:00:00Z",
      inputTokens: totalTokens - 200,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens,
      totalCost: 0.42,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { projectPath: "/Users/alice/private/skill-tree" },
    },
  ];
  if (includeCodexSession) {
    session.push({
      agent: "codex",
      period: "2026-07-14T21:00:00Z",
      inputTokens: 400,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 500,
      totalCost: 0.9,
      modelsUsed: ["gpt-5.5"],
      metadata: { projectPath: "/Users/alice/private/codex-lab" },
    });
  }

  return {
    scanned_at: 1_784_068_400,
    source: {
      command: "ccusage",
      args: ["--json"],
      resolved_from: "test-runner",
    },
    raw: "",
    parsed: {
      daily: [
        {
          period: "2026-07-14",
          totalTokens,
          totalCost: 0.42,
          agents: [
            {
              agent: "claude",
              inputTokens: totalTokens - 200,
              outputTokens: 200,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalTokens,
              totalCost: 0.42,
              modelsUsed: ["claude-sonnet-4"],
            },
            ...(includeCodexSession
              ? [
                  {
                    agent: "codex",
                    inputTokens: 400,
                    outputTokens: 100,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    totalTokens: 500,
                    totalCost: 0.9,
                    modelsUsed: ["gpt-5.5"],
                  },
                ]
              : []),
          ],
        },
      ],
      session,
      totals: {
        inputTokens: totalTokens - 200,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: includeCodexSession ? totalTokens + 500 : totalTokens,
        totalCost: includeCodexSession ? 1.32 : 0.42,
      },
    },
  };
}

function emptyScan(): UsageScan {
  return {
    scanned_at: 1_784_068_400,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: { daily: [], session: [], totals: { totalTokens: 0, totalCost: 0 } },
  };
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function dayRow(period: string, tokens: number, cost = 1) {
  return {
    period,
    totalTokens: tokens,
    totalCost: cost,
    agents: [{ agent: "claude", totalTokens: tokens, totalCost: cost, modelsUsed: ["claude-sonnet-5"] }],
  };
}

function dailyScan(daily: unknown[], session: unknown[] = []): UsageScan {
  return {
    scanned_at: 1_784_068_400,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: { daily, session, totals: { totalTokens: 100_000, totalCost: 5 } },
  };
}

function makeSessions(agent: string, count: number, tokenBase: number, model = `${agent}-model`) {
  return Array.from({ length: count }, (_, i) => ({
    agent,
    period: `${agent}-session-${i}`,
    inputTokens: tokenBase + i + 1,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokenBase + i + 1,
    totalCost: (tokenBase + i + 1) / 1000,
    modelsUsed: [model],
  }));
}

function sessionsScan(session: unknown[]): UsageScan {
  return {
    scanned_at: 1_784_068_400,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: { daily: [], session, totals: { totalTokens: 100_000, totalCost: 5 } },
  };
}
