import { useUsagePreferences } from "@/store/usagePreferences";
import { readUsagePreferences } from "@/lib/usagePreferences";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LocalAgentUsage } from "@/screens/LocalAgentUsage";
import { USAGE_IMPORT_TARGET, useLocalAgentUsage } from "@/features/usage/useLocalAgentUsage";
import { formatCompact, shortId } from "@/screens/usage/usageFormat";
import { Processes } from "@/store/processes";
import { renderWithProviders, makeQueryClient } from "./helpers";
import type { UsageDiagnostic, UsageHistoryPayload, UsageScan } from "@/features/usage/usageTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

// Every hand-built `UsageScan` fixture in this file used a fixed, long-past
// `scanned_at` (2026-07-14) before capture-on-open existed — now that a
// cached scan older than 60m auto-fires a background rescan on mount (see
// `useLocalAgentUsage.ts`), that stale timestamp would fire one on EVERY
// test's initial render, silently overwriting the fixture the test just
// set up. `Date.now()` keeps every fixture "fresh" by construction instead;
// the dedicated capture-on-open tests below pass their own timestamps.
const FRESH_SCANNED_AT = Math.floor(Date.now() / 1000);

// A `Date.now`/`localStorage` spy restored only at the end of an `it()` body
// leaks into every later test if an earlier assertion throws (TA-1-d9f4 /
// R7); restore in `afterEach` so one real failure can't cascade.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Open a themed `<Select>` by its accessible (aria-)label and pick one
 *  option by its rendered text. */
function pickSelectOption(label: string, optionName: string) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function headerScanButton() {
  return within(document.querySelector(".main-header") as HTMLElement).getByRole("button", { name: /Scan/ });
}

// ─── Durable usage history fixtures (wave 2b) ──────────────────────────────

function historyPayload(overrides: Partial<UsageHistoryPayload> = {}): UsageHistoryPayload {
  return {
    schema_version: 1,
    generated_at: "2026-09-04T12:00:00Z",
    horizon: "2026-08-21",
    since: null,
    until: null,
    days: [],
    counts: { days: 0, rows: 0, backfilled_days: 0, frozen_days: 0, scanned_days: 0 },
    claude_stats: { available: false, path: "~/.claude/stats-cache.json", importable_days: 0, last_computed: null },
    warnings: [],
    ...overrides,
  };
}

function historyDay(
  date: string,
  tokensTotal: number,
  opts: { provenance?: "scanned" | "frozen" | "backfilled"; costUsd?: number } = {},
): UsageHistoryPayload["days"][number] {
  const provenance = opts.provenance ?? "scanned";
  const known = provenance !== "backfilled";
  const costUsd = known ? (opts.costUsd ?? tokensTotal / 1000) : 0;
  const tokens = known
    ? { input: Math.round(tokensTotal * 0.7), output: Math.round(tokensTotal * 0.3), cacheCreation: 0, cacheRead: 0, total: tokensTotal }
    : { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: tokensTotal };
  return {
    date,
    provenance,
    tokens,
    costUsd,
    costKnown: known,
    splitKnown: known,
    agents: [
      {
        agent: "claude",
        name: "Claude Code",
        provenance,
        source: known ? "ccusage" : "claude-stats-cache",
        tokens,
        costUsd,
        costKnown: known,
        splitKnown: known,
        models: [{ model: "claude-sonnet-5", tokens, costUsd, costKnown: known }],
      },
    ],
  };
}

/** A `hub_cmd` handler for `usage history`/`usage import-claude-stats`,
 *  composable with a test's own `usage_load_latest_ccusage`/
 *  `usage_scan_ccusage` handling. */
function historyHubCmd(
  payload: UsageHistoryPayload,
  importOutput: unknown = {
    inserted: 1,
    path: "~/.claude/stats-cache.json",
    skipped_existing: 0,
    skipped_ccusage_days: 0,
    dry_run: false,
    warnings: [],
  },
) {
  return async (cmd: string, args?: unknown): Promise<unknown> => {
    if (cmd !== "hub_cmd") return undefined;
    const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
    if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
      return { success: true, output: JSON.stringify(payload) };
    }
    if (cmdArgs[0] === "usage" && cmdArgs[1] === "import-claude-stats") {
      return { success: true, output: JSON.stringify(importOutput) };
    }
    return { success: true, output: "" };
  };
}

describe("LocalAgentUsage", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    localStorage.clear();
    vi.mocked(openUrl).mockClear();
  });

  it("renders visible route chrome and a first-run empty cached state", async () => {
    // No cache → capture-on-open auto-fires a scan on mount (see
    // `useLocalAgentUsage.ts`). Hanging it here keeps the "nothing scanned
    // yet" chrome this test is actually about observable for its whole
    // duration, instead of racing straight through to whatever the
    // auto-scan resolves to.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return null;
      if (cmd === "usage_scan_ccusage") return new Promise<never>(() => {});
      return null;
    });
    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(screen.getByText("Usage")).toBeInTheDocument();
    expect(screen.getByText("Runs locally · No raw prompts uploaded")).toBeInTheDocument();
    expect(screen.getByText("Loading latest cached scan…")).toBeInTheDocument();
    expect(await screen.findByText("No cached usage scan yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Scan local usage/i }).length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_load_latest_ccusage");
  });

  it("renders the KPI row, spend chart, harness breakdown and sessions for a populated scan", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    const client = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client });

    expect(await screen.findByLabelText("Cached usage summary")).toBeInTheDocument();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    // The sub line is two independent clauses now, each its own element, so
    // it never breaks mid-clause ("6% cache / read").
    expect(screen.getByText("API-equivalent")).toBeInTheDocument();
    expect(screen.getByText("not an invoice")).toBeInTheDocument();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Spend over time")).toBeInTheDocument();
    expect(screen.getByLabelText("Sessions")).toHaveTextContent("Project A");
    expect(screen.getByLabelText("Harness breakdown")).toHaveTextContent("scanned just now");
    expect(screen.getByLabelText("Harness breakdown")).toHaveTextContent("Scan");
    expect(screen.queryByText("/Users/alice/private/skill-tree")).not.toBeInTheDocument();
  });

  it("runs the header ccusage scan before the transcript scan", async () => {
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") {
        order.push("ccusage");
        return sampleScan();
      }
      if (cmd === "hub_cmd") {
        const command = (args as { args?: string[] } | undefined)?.args ?? [];
        if (command[0] === "usage" && command[1] === "scan-sessions") {
          order.push("transcript");
          return { success: true, output: JSON.stringify({ ok: true, rows_written: 0, rows_frozen: 0, files_scanned: 0, files_skipped: 0, bytes_read: 0, sessions_unregistered: 0, stopped_on: null, errors: [], malformed_rows_dropped: 0, last_scan_at: null }) };
        }
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    const header = document.querySelector(".main-header") as HTMLElement;
    expect(within(header).getAllByRole("button", { name: /Scan/ })).toHaveLength(1);
    expect(within(header).queryByRole("button", { name: /Refresh scan/ })).not.toBeInTheDocument();

    await userEvent.click(headerScanButton());
    await waitFor(() => expect(order).toEqual(["ccusage", "transcript"]));
  });

  it("runs both scans from the Harness breakdown Scan button", async () => {
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") {
        order.push("ccusage");
        return sampleScan();
      }
      if (cmd === "hub_cmd") {
        const command = (args as { args?: string[] } | undefined)?.args ?? [];
        if (command[0] === "usage" && command[1] === "scan-sessions") {
          order.push("transcript");
          return { success: true, output: JSON.stringify({ ok: true, rows_written: 0, rows_frozen: 0, files_scanned: 0, files_skipped: 0, bytes_read: 0, sessions_unregistered: 0, stopped_on: null, errors: [], malformed_rows_dropped: 0, last_scan_at: null }) };
        }
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(within(screen.getByLabelText("Harness breakdown")).getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(order).toEqual(["ccusage", "transcript"]));
  });


  it("shows a HarnessGlyph on each harness row and folds harnesses with no usage into one details block", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ includeCodexSession: true });
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    expect(container.querySelector('[data-harness="claude-code"]')).not.toBeNull();

    const fold = container.querySelector(".usage-fold");
    expect(fold).not.toBeNull();
    const summary = within(fold as HTMLElement).getByText(/more harnesses ccusage supports show no local usage/);
    expect(summary.textContent).toMatch(/^\d+ more harnesses/);
  });

  it("carries the exact token count as a title on the harness breakdown's compact figure", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 2_500_000_000 });
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const tokenFigure = container.querySelector(".usage-harness-row .usage-row-numbers b");
    expect(tokenFigure).not.toBeNull();
    expect(tokenFigure!.textContent).toBe(formatCompact(2_500_000_000));
    expect(tokenFigure).toHaveAttribute("title", "2,500,000,000");
  });

  it("renders the harness row's meta line as one clause per fact, sessions · tool calls · model, with separators between", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const meta = container.querySelector(".usage-harness-row .usage-harness-meta")!;
    expect(meta).not.toBeNull();
    const clauses = meta.querySelectorAll("span:not(.usage-harness-sep)");
    expect(clauses).toHaveLength(3);
    expect(clauses[0].textContent).toMatch(/session/);
    expect(clauses[1].textContent).toMatch(/tool call/);
    expect(meta.querySelectorAll(".usage-harness-sep")).toHaveLength(2);
  });

  it("shows the harness's brand glyph as a leading icon in the Harness filter's options and trigger", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ includeCodexSession: true });
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Sessions");

    fireEvent.click(screen.getByLabelText("Harness"));
    const codexOption = screen.getByRole("option", { name: /^Codex\b/ });
    expect(codexOption).toHaveAttribute("data-leading", "");
    expect(codexOption.querySelector('[data-harness="codex"]')).not.toBeNull();

    await userEvent.click(codexOption);
    expect(screen.getByLabelText("Harness").querySelector(".select-trigger-leading")).not.toBeNull();
  });

  it("switches the spend chart's heading with the Measure chip", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const chart = await screen.findByLabelText("Spend over time");
    expect(chart).toHaveTextContent("Tokens by day");

    await userEvent.click(screen.getByRole("radio", { name: "Cost" }));
    expect(chart).toHaveTextContent("Cost by day");
  });

  it("supports harness filtering and sorting of the sessions table", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ includeCodexSession: true });
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    expect(sessions).toHaveTextContent("Project A");
    expect(sessions).toHaveTextContent("Project B");

    pickSelectOption("Harness", "Codex");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Codex");
    expect(rows[0]).not.toHaveTextContent("Claude Code");

    // Sorting still works without touching the full-paths toggle.
    pickSelectOption("Sort", "Cost");
    expect(within(sessions).getAllByTestId("usage-session-row").length).toBeGreaterThanOrEqual(1);
  });

  it("disables the full-paths toggle over cache-only data and never reveals a redacted path", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      // Only the on-disk (redacted) cache is available — no live scan this session.
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
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

    renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByLabelText("Show full paths")).toBeDisabled();

    // Run a fresh (full-fidelity) scan.
    await userEvent.click(headerScanButton());

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

    renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(headerScanButton());
    await waitFor(() => expect(screen.getByLabelText("Show full paths")).toBeEnabled());

    const loadCallsBefore = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "usage_load_latest_ccusage").length;

    // Fire a window-focus event. With `refetchOnWindowFocus: false` on the
    // `latest` query, the redacted disk cache must NOT be re-fetched (which
    // would flip provenance back to "cache" mid-session).
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    focusManager.setFocused(undefined);

    const loadCallsAfter = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "usage_load_latest_ccusage").length;
    expect(loadCallsAfter).toBe(loadCallsBefore);
    expect(screen.getByLabelText("Show full paths")).toBeEnabled();
  });

  it("exposes exactly one 'Show full paths' control after the Toggle swap", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByLabelText("Show full paths")).toBeInTheDocument();
  });

  it("shows a no-usage state after a successful empty scan", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return emptyScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    expect(await screen.findByText("No local harness usage was detected yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry scan/i })).toBeInTheDocument();
  });

  it("shows permission and ccusage failure states with copy diagnostics and retry", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") throw "permission denied reading Claude logs";
      if (cmd === "usage_scan_ccusage") return sampleScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    expect(await screen.findByText("Skill Tree cannot access local usage logs")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Copy diagnostic/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("permission denied"));

    await userEvent.click(screen.getByRole("button", { name: /Retry scan/i }));
    // The online-pricing pref (default off) now threads through as a second
    // arg (Plan A Addendum A3) — never a bare single-arg call.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage", { onlinePricing: false }),
    );
  });

  it("keeps the cached dashboard visible when a refresh fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") {
        // Benign "scan succeeded but found zero new rows" the Rust side
        // reports as no_usage.
        throw { kind: "no_usage", message: "no new usage since the last scan" } satisfies UsageDiagnostic;
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    expect(await screen.findByLabelText("Cached usage summary")).toBeInTheDocument();

    await userEvent.click(headerScanButton());

    // The refresh failure is surfaced non-destructively…
    expect(await screen.findByText(/Refresh failed — showing the last successful scan/)).toBeInTheDocument();
    // …and the previously populated dashboard is STILL rendered, not
    // replaced by the full-screen error state.
    expect(screen.getByLabelText("Cached usage summary")).toBeInTheDocument();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(screen.queryByText("ccusage could not finish the scan")).not.toBeInTheDocument();
  });

  it("maps structured UsageDiagnostic kinds to the correct error state", async () => {
    let failure: UsageDiagnostic = {
      kind: "access",
      message: "EACCES: permission denied",
      stderr: "cannot read /Users/alice/.claude/logs/session.jsonl",
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") throw failure;
      return null;
    });

    const accessClient = makeQueryClient();
    const view = renderWithProviders(<LocalAgentUsage />, { client: accessClient });
    expect(await screen.findByText("Skill Tree cannot access local usage logs")).toBeInTheDocument();
    view.unmount();

    failure = {
      kind: "no_usage",
      message: "ccusage found no usage rows",
    };

    const noUsageClient = makeQueryClient();
    renderWithProviders(<LocalAgentUsage />, { client: noUsageClient });
    expect(await screen.findByText("No usage found")).toBeInTheDocument();
  });

  it("redacts local paths from the copied diagnostic", async () => {
    const secretPath = "/Users/alice/.claude/projects/secret/session.jsonl";
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== "usage_load_latest_ccusage") return null;
      return Promise.reject({
      kind: "access",
      message: "EACCES: permission denied",
      stderr: `cannot read ${secretPath}`,
      } satisfies UsageDiagnostic);
    });

    renderWithProviders(<LocalAgentUsage />);

    await screen.findByText("Skill Tree cannot access local usage logs");
    await userEvent.click(screen.getByRole("button", { name: /Copy diagnostic/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("<redacted-path>"));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining(secretPath));
  });

  it("triggers a ccusage scan and replaces the cached summary", async () => {
    // A fresh (not stale) starting cache — the "no cache at all" case now
    // auto-fires via capture-on-open (see the dedicated tests for that), so
    // it would race this test's own manual click; starting from a populated,
    // fresh dashboard isolates the header button's own effect.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_000 });
      if (cmd === "usage_scan_ccusage") return sampleScan({ totalTokens: 2400 });
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(headerScanButton());

    // The online-pricing pref (default off) now threads through as a second
    // arg (Plan A Addendum A3) — never a bare single-arg call.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage", { onlinePricing: false }),
    );
    await waitFor(() => expect(screen.getAllByText(formatCompact(2400)).length).toBeGreaterThanOrEqual(1));
  });

  it("dedupes rapid clicks across the header Scan and the breakdown Scan into one ccusage run (review A)", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    let scanCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_000 });
      if (cmd === "usage_scan_ccusage") {
        scanCalls += 1;
        // Hold the first scan open so a second click lands while it is in flight.
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return sampleScan({ totalTokens: 2400 });
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const refresh = headerScanButton();
    const breakdownScan = within(screen.getByLabelText("Harness breakdown")).getByRole("button", { name: /^Scan$/ });
    // Two controls, two clicks, no await between them: the second lands
    // before React commits `isPending`, which is exactly the window the
    // synchronous guard closes.
    const clicks = Promise.all([userEvent.click(refresh), userEvent.click(breakdownScan)]);
    await clicks;
    await waitFor(() => expect(scanCalls).toBe(1));

    gate.release?.();
    await waitFor(() => expect(screen.getAllByText(formatCompact(2400)).length).toBeGreaterThanOrEqual(1));
    // Once settled, the guard reopens: a further click starts a new run.
    await userEvent.click(headerScanButton());
    await waitFor(() => expect(scanCalls).toBe(2));
    gate.release?.();
  });

  it("keeps the combined workflow singleflight while transcript capture is pending", async () => {
    let ccusageCalls = 0;
    let transcriptCalls = 0;
    const transcriptGate: { release: (() => void) | null } = { release: null };
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_000 });
      if (cmd === "usage_scan_ccusage") {
        ccusageCalls += 1;
        return sampleScan({ totalTokens: 2_400 });
      }
      if (cmd === "hub_cmd") {
        const command = (args as { args?: string[] } | undefined)?.args ?? [];
        if (command[0] === "usage" && command[1] === "scan-sessions") {
          transcriptCalls += 1;
          await new Promise<void>((resolve) => { transcriptGate.release = resolve; });
          return { success: true, output: JSON.stringify({ ok: true, rows_written: 0, rows_frozen: 0, files_scanned: 0, files_skipped: 0, bytes_read: 0, sessions_unregistered: 0, stopped_on: null, errors: [], malformed_rows_dropped: 0, last_scan_at: null }) };
        }
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    const header = headerScanButton();
    const breakdown = within(screen.getByLabelText("Harness breakdown")).getByRole("button", { name: /^Scan$/ });
    await Promise.all([userEvent.click(header), userEvent.click(breakdown)]);
    await waitFor(() => expect(ccusageCalls).toBe(1));
    await waitFor(() => expect(transcriptCalls).toBe(1));
    // Re-query after the process-store update: ScanButton may have rendered a
    // fresh node while the ccusage phase handed off to transcript capture.
    expect(headerScanButton()).toBeDisabled();
    expect(within(screen.getByLabelText("Harness breakdown")).getByRole("button", { name: /^Scan$/ })).toBeDisabled();

    transcriptGate.release?.();
    await waitFor(() => expect(transcriptCalls).toBe(1));
  });

  it("respects the Range chip for the chart instead of a fixed window", async () => {
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

    const { container } = renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Spend over time");
    // Default "all" → all 5 columns.
    expect(container.querySelectorAll(".chart-col").length).toBe(5);

    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    // Only the three within-7-days columns remain.
    expect(container.querySelectorAll(".chart-col").length).toBe(3);
  });

  it("narrows the KPIs, sessions, and chart columns together when the Range changes", async () => {
    const recent = dayRow(isoDaysAgo(1), 500);
    const old = dayRow(isoDaysAgo(20), 2000);
    const session = [
      {
        agent: "claude",
        period: "recent-session",
        startedAt: isoDaysAgo(1),
        inputTokens: 500,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 500,
        totalCost: 1,
        modelsUsed: ["claude-sonnet-4"],
      },
      {
        agent: "claude",
        period: "old-session",
        startedAt: isoDaysAgo(20),
        inputTokens: 2000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 2000,
        totalCost: 4,
        modelsUsed: ["claude-sonnet-4"],
      },
    ];
    const scan: UsageScan = {
      scanned_at: FRESH_SCANNED_AT,
      source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
      raw: "",
      parsed: {
        daily: [recent, old],
        session,
        totals: { totalTokens: 2500, totalCost: 5 },
      },
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? scan : null));

    const { container } = renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Cached usage summary");
    const tokensTile = () =>
      (container.querySelector(".usage-kpis .stat-card:nth-child(2)") as HTMLElement) ?? null;
    expect(within(tokensTile()).getByText(formatCompact(2500))).toBeInTheDocument();
    expect(container.querySelectorAll(".chart-col").length).toBe(2);
    expect(within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row")).toHaveLength(2);

    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));

    expect(within(tokensTile()).getByText(formatCompact(500))).toBeInTheDocument();
    expect(container.querySelectorAll(".chart-col").length).toBe(1);
    expect(within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row")).toHaveLength(1);
  });

  it("filters the KPIs, chart legend, and session list when a harness chip is picked, and persists it", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan({ includeCodexSession: true }) : null,
    );
    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const tokensTile = () => container.querySelector(".usage-kpis .stat-card:nth-child(2)") as HTMLElement;
    // Every harness: claude (1200) + codex (500) + pi (350) = 2050.
    expect(within(tokensTile()).getByText(formatCompact(2050))).toBeInTheDocument();
    expect(within(screen.getByLabelText("Spend over time")).getByText("Claude Code")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Spend over time")).getByText("Codex")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row")).toHaveLength(3);

    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));

    expect(within(tokensTile()).getByText(formatCompact(500))).toBeInTheDocument();
    // The spend chart's legend is built from the harness ids still present
    // in the (harness-filtered) daily points, and only renders at all with
    // 2+ series — one harness left means no legend and one column segment.
    expect(within(screen.getByLabelText("Spend over time")).queryByText("Claude Code")).not.toBeInTheDocument();
    const seg = container.querySelector(".chart-col-seg") as HTMLElement;
    expect(seg).toHaveAttribute("data-series", "codex");
    expect(container.querySelectorAll(".chart-col-seg")).toHaveLength(1);
    const rows = within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Codex investigation");

    expect(localStorage.getItem("st:usage:harness")).toBe("codex");
  });

  it("all-time + a harness filter trusts the snapshot's own per-harness totals, not a recompute from sessions", async () => {
    // The mock codex session carries `modelsUsed` but no per-model
    // `modelBreakdowns`, so the snapshot's own `harness.modelBreakdown`
    // records that model at ZERO usage (presence-only) — a real ccusage
    // gap `scopeAllTimeForHarness` deliberately does not paper over by
    // falling back to a recompute, which would instead divide the (single)
    // codex session's ~500 tokens / $0.90 evenly across its one model.
    // `UsageModelsCard` drops zero-usage rows, so the empty state is the
    // tell that the snapshot's own totals won, not a recomputed row.
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan({ includeCodexSession: true }) : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));

    expect(
      within(screen.getByLabelText("Top models")).getByText("No model usage in this range."),
    ).toBeInTheDocument();
    expect(within(screen.getByLabelText("Top models")).queryByText("gpt-5.5")).not.toBeInTheDocument();
  });

  it("a stored harness id the snapshot no longer detects falls back to All, never hiding every session", async () => {
    localStorage.setItem("st:usage:harness", "does-not-exist");
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan({ includeCodexSession: true }) : null,
    );
    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    const tokensTile = container.querySelector(".usage-kpis .stat-card:nth-child(2)") as HTMLElement;
    expect(within(tokensTile).getByText(formatCompact(2050))).toBeInTheDocument();
    expect(within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row")).toHaveLength(3);
  });

  it("each harness chip carries the glyph and an accessible name equal to the harness name", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan({ includeCodexSession: true }) : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const codexOption = screen.getByRole("radio", { name: "Codex" }).closest("label")!;
    expect(codexOption.querySelector(".chip-icon")).toBeTruthy();
    expect(codexOption).toHaveAttribute("title", "Codex");

    const allOption = screen.getByRole("radio", { name: "All" }).closest("label")!;
    expect(allOption.querySelector(".chip-icon")).toBeNull();
  });

  it("converts every visible cost to EUR, persists the choice, and falls back on an invalid stored rate", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? sampleScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    const costTile = (await screen.findByText("Estimated cost")).closest(".stat-card") as HTMLElement;
    expect(within(costTile).getByText(/\$/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "EUR" }));

    expect(within(costTile).getByText(/€/)).toBeInTheDocument();
    expect(within(costTile).queryByText(/\$/)).not.toBeInTheDocument();
    expect(localStorage.getItem("st:usage:currency")).toBe("EUR");

    const sessionRow = within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row")[0];
    expect(within(sessionRow).getByText(/€/)).toBeInTheDocument();

    const rateInput = screen.getByLabelText("EUR per USD") as HTMLInputElement;
    expect(rateInput.value).toBe("0.86");
    const before = costTile.textContent;
    fireEvent.change(rateInput, { target: { value: "0.5" } });
    expect(costTile.textContent).not.toBe(before);
    expect(localStorage.getItem("st:usage:eurRate")).toBe("0.5");
  });

  it("falls back to the default EUR rate when the stored value is invalid", async () => {
    localStorage.setItem("st:usage:eurRate", "999");
    useUsagePreferences.setState(readUsagePreferences());
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? sampleScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("radio", { name: "EUR" }));

    expect((screen.getByLabelText("EUR per USD") as HTMLInputElement).value).toBe("0.86");
  });

  it("keeps the rate field in the band while USD is selected (disabled), so switching currency never reflows the controls", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? sampleScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const rate = screen.getByLabelText("EUR per USD") as HTMLInputElement;
    expect(rate).toBeDisabled();
    expect(rate.closest(".usage-rate-field")).toHaveAttribute("data-inactive", "true");
    expect(rate.value).toBe("0.86");

    await userEvent.click(screen.getByRole("radio", { name: "EUR" }));
    expect(screen.getByLabelText("EUR per USD")).toBeEnabled();
    expect(rate.closest(".usage-rate-field")).not.toHaveAttribute("data-inactive");
  });

  it("defaults a wide (>60 day) range to weekly bars and labels the chart accordingly", async () => {
    const daily = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      return dayRow(d, 100 + i);
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);

    const chart = await screen.findByLabelText("Spend over time");
    const colCount = container.querySelectorAll(".chart-col").length;
    expect(colCount).toBeGreaterThan(0);
    expect(colCount).toBeLessThan(70); // week-bucketed → fewer columns than input days
    expect(chart).toHaveTextContent("Tokens by week");
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
  });

  it("lets the viewer override the default bucket, and remembers the pick", async () => {
    const daily = [dayRow("2026-07-10", 500), dayRow("2026-07-11", 400), dayRow("2026-07-12", 300)];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const { unmount } = renderWithProviders(<LocalAgentUsage />);
    const chart = await screen.findByLabelText("Spend over time");
    expect(chart).toHaveTextContent("Tokens by day");

    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(chart).toHaveTextContent("Tokens by month");
    expect(localStorage.getItem("st:usage:bucket")).toBe("month");

    unmount();
    renderWithProviders(<LocalAgentUsage />);
    const chart2 = await screen.findByLabelText("Spend over time");
    expect(chart2).toHaveTextContent("Tokens by month");
    expect(screen.getByRole("radio", { name: "Month" })).toBeChecked();
  });

  it("falls back to the derived default when the stored bucket is garbage", async () => {
    // `st:usage:bucket` is hand-editable text; an unknown word must read as
    // "no explicit pick", not crash the screen or stick as a bucket name.
    localStorage.setItem("st:usage:bucket", "fortnight");
    const daily = [dayRow(isoDaysAgo(0), 500), dayRow(isoDaysAgo(1), 400), dayRow(isoDaysAgo(2), 300)];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const chart = await screen.findByLabelText("Spend over time");
    expect(chart).toHaveTextContent("Tokens by day");
    expect(screen.getByRole("radio", { name: "Day" })).toBeChecked();
  });

  it.each(["7 days", "30 days"])("chooses daily buckets when narrowing to %s", async (range) => {
    localStorage.setItem("st:usage:bucket", "month");
    localStorage.setItem("st:usage:bucketRange", "all");
    const daily = [dayRow(isoDaysAgo(0), 500), dayRow(isoDaysAgo(2), 400), dayRow(isoDaysAgo(20), 300)];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const chart = await screen.findByLabelText("Spend over time");
    expect(chart).toHaveTextContent("Tokens by month");

    await userEvent.click(screen.getByRole("radio", { name: range }));
    expect(chart).toHaveTextContent("Tokens by day");
    expect(screen.getByRole("radio", { name: "Day" })).toBeChecked();
    expect(screen.getByLabelText("Skills used")).toHaveTextContent("by day");
    expect(screen.getByLabelText("Tool activity")).toHaveTextContent("by day");
  });

  it.each(["7d", "30d"])("replaces a legacy monthly bucket for %s but remembers a new explicit choice", async (range) => {
    localStorage.setItem("st:usage:range", range);
    localStorage.setItem("st:usage:bucket", "month");
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([dayRow(isoDaysAgo(1), 500)]) : null,
    );
    const view = renderWithProviders(<LocalAgentUsage />);
    expect(await screen.findByLabelText("Spend over time")).toHaveTextContent("Tokens by day");
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    view.unmount();
    renderWithProviders(<LocalAgentUsage />);
    expect(await screen.findByLabelText("Spend over time")).toHaveTextContent("Tokens by month");
  });

  it("F7a keeps scope controls separate from the static currency row", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([dayRow(isoDaysAgo(1), 500)]) : null,
    );
    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    const scope = container.querySelector(".usage-controls-scope") as HTMLElement;
    const currency = container.querySelector(".usage-controls-currency-row") as HTMLElement;
    expect(within(scope).getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
    expect(within(scope).getByRole("radiogroup", { name: "Bucket" })).toBeInTheDocument();
    expect(within(scope).getByRole("radiogroup", { name: "Harness filter" })).toBeInTheDocument();
    expect(within(currency).getByRole("radiogroup", { name: "Currency" })).toBeInTheDocument();
    expect(within(currency).getByRole("button", { name: /Prices/ })).toBeInTheDocument();
    expect(within(scope).queryByRole("radiogroup", { name: "Currency" })).not.toBeInTheDocument();
    expect(within(scope).queryByRole("button", { name: /Prices/ })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Spend over time")).queryByRole("radio", { name: "Week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Year" })).not.toBeInTheDocument();
  });

  it("keeps a legend item when Measure switches to Tokens / session", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    const chart = await screen.findByLabelText("Spend over time");
    await userEvent.click(screen.getByRole("radio", { name: "Tokens / session" }));
    expect(chart.querySelector(".chart-legend-label")).toHaveTextContent("Tokens / session");
  });

  it("F7b reads stored ranges and derives a stored year bucket without rewriting it", async () => {
    localStorage.setItem("st:usage:bucket", "year");
    localStorage.setItem("st:usage:range", "90d");
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([dayRow(isoDaysAgo(1), 500)]) : null,
    );
    const { unmount } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByRole("radio", { name: "90 days" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
    expect(localStorage.getItem("st:usage:bucket")).toBe("year");
    unmount();

    localStorage.setItem("st:usage:range", "1y");
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByRole("radio", { name: "1 year" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
  });

  it("F7c updates all over-time copy when Month is picked", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([dayRow(isoDaysAgo(1), 500)]) : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(screen.getByLabelText("Spend over time")).toHaveTextContent("Tokens by month");
    expect(screen.getByLabelText("Skills used")).toHaveTextContent("by month");
    expect(screen.getByLabelText("Model mix")).toHaveTextContent("Cost share by month · percent");
  });

  it("F7d derives day, week, and month at the 60/61/401-day boundaries", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([dayRow(isoDaysAgo(0), 500)]) : null,
    );
    for (const [count, heading] of [[60, "Tokens by day"], [61, "Tokens by week"], [401, "Tokens by month"]] as const) {
      localStorage.clear();
      const rows = Array.from({ length: count }, (_, index) => dayRow(isoDaysAgo(index), 500));
      vi.mocked(invoke).mockImplementation(async (cmd: string) =>
        cmd === "usage_load_latest_ccusage" ? dailyScan(rows) : null,
      );
      const view = renderWithProviders(<LocalAgentUsage />);
      await screen.findByLabelText("Cached usage summary");
      expect(screen.getByLabelText("Spend over time")).toHaveTextContent(heading);
      view.unmount();
    }
  });

  it("scales chart segment heights proportionally to the visible max", async () => {
    const daily = [dayRow("2026-07-10", 1000), dayRow("2026-07-11", 100), dayRow("2026-07-12", 100)];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan(daily);
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Spend over time");
    const heights = Array.from(container.querySelectorAll<HTMLElement>(".chart-col-seg")).map((el) =>
      parseFloat(el.style.height),
    );
    expect(Math.max(...heights)).toBeCloseTo(100, 0);
    expect(Math.min(...heights)).toBeLessThan(100);
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

    const { container } = renderWithProviders(<LocalAgentUsage />);

    const chart = await screen.findByLabelText("Spend over time");
    // Only the 3 parseable rows render as columns; "Unknown date" is dropped.
    expect(container.querySelectorAll(".chart-col").length).toBe(3);
    expect(chart).not.toHaveTextContent("Unknown date");
    // The session (parsed separately) is still visible in the sessions list.
    expect(screen.getByLabelText("Sessions")).toHaveTextContent("Claude Code");
  });

  it("makes chart columns keyboard-focusable with an accessible label and no native title on segments", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan([dayRow("2026-07-10", 500)]);
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Spend over time");
    const col = container.querySelector(".chart-col") as HTMLElement;
    expect(col).not.toBeNull();
    expect(col.getAttribute("tabindex")).toBe("0");
    // The column's aria-label carries the full tooltip date (short month,
    // day, year) — no longer the bare "2026-07-10" ISO string.
    expect(col.getAttribute("aria-label")).toMatch(/Jul 10, 2026/);
    expect(container.querySelector(".chart-col-seg")?.getAttribute("title")).toBeNull();
  });

  it("shows the chart tooltip inside the chart on column hover", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return dailyScan([dayRow("2026-07-10", 500), dayRow("2026-07-11", 600)]);
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Spend over time");
    const tooltip = container.querySelector(".chart-tooltip") as HTMLElement;
    expect(tooltip).not.toBeNull();
    expect(tooltip.closest(".chart")).not.toBeNull();

    const col = container.querySelector(".chart-col") as HTMLElement;
    fireEvent.mouseEnter(col);
    expect(tooltip.className).toContain("is-visible");
  });

  it("filters sessions by free-text search and updates the count label", async () => {
    // 14 claude + 6 codex = 20 sessions.
    const session = [...makeSessions("claude", 14, 0), ...makeSessions("codex", 6, 100)];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sessionsScan(session);
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    expect(sessions).toHaveTextContent("Showing 10 of 20 sessions");

    await userEvent.type(screen.getByPlaceholderText("Search sessions…"), "codex");
    // 6 codex sessions match — narrowed below the collapsed cap, so all show
    // and the "Showing X of Y" footer disappears.
    expect(sessions).not.toHaveTextContent("Showing 10 of 20 sessions");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(6);
    rows.forEach((row) => expect(row).toHaveTextContent("Codex"));
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

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    // The option reads the display name ("Opus 4.8") — the value underneath
    // stays the raw ccusage id, so the filter still matches by that id.
    pickSelectOption("Model", "Opus 4.8");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(3);
  });

  it("expands the sessions list up to the 100 cap and drops the dead 'Show more' button", async () => {
    const session = makeSessions("claude", 105, 0);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sessionsScan(session);
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    expect(sessions).toHaveTextContent("Showing 10 of 105 sessions");
    const showMore = screen.getByRole("button", { name: /Show 90 more/i });

    await userEvent.click(showMore);

    // Now shownSessions === expandTarget (100): the button must be gone, not
    // stuck on a dead "Show 0 more", and only the ceiling note remains.
    expect(within(sessions).getAllByTestId("usage-session-row")).toHaveLength(100);
    expect(screen.queryByRole("button", { name: /Show \d+ more/i })).not.toBeInTheDocument();
    expect(sessions).toHaveTextContent("Showing the first 100 matches");
  });

  it("never searches full paths even with full paths revealed", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);

    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(headerScanButton());
    await waitFor(() => expect(screen.getByLabelText("Show full paths")).toBeEnabled());
    await userEvent.click(screen.getByLabelText("Show full paths"));
    // The full path is now shown…
    expect(await screen.findByText("/Users/alice/private/skill-tree")).toBeInTheDocument();

    // …but searching for a fragment of that path finds nothing, because the
    // search haystack uses the anonymized label only.
    await userEvent.type(screen.getByPlaceholderText("Search sessions…"), "skill-tree");
    const sessions = screen.getByLabelText("Sessions");
    expect(within(sessions).queryAllByTestId("usage-session-row")).toHaveLength(0);
    expect(sessions).toHaveTextContent("No sessions match the selected filters");
  });

  it("shows a session's title and a working PR link", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    expect(within(sessions).getByText("Snippets screen redesign")).toBeInTheDocument();
    const prButton = within(sessions).getByRole("button", { name: /PR #90/ });
    await userEvent.click(prButton);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/skill-tree/pull/90");
  });

  it("shows a fallback name for a titleless session", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);

    const sessions = await screen.findByLabelText("Sessions");
    expect(within(sessions).getByText(/Claude Code session/)).toBeInTheDocument();
    expect(within(sessions).getByText(shortId("sess-2-scratch"))).toBeInTheDocument();
  });

  it("sorts sessions by tool calls", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    const sessions = await screen.findByLabelText("Sessions");

    pickSelectOption("Sort", "Tool calls");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows[0]).toHaveTextContent("Claude Code session"); // s2, 300 tool calls
    expect(rows[1]).toHaveTextContent("Codex investigation"); // s3, 50 tool calls
  });

  it("sorts sessions by most recent activity", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    const sessions = await screen.findByLabelText("Sessions");

    pickSelectOption("Sort", "Most recent");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows[0]).toHaveTextContent("Pi session notes");
  });

  it("matches session search against a session's title", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    const sessions = await screen.findByLabelText("Sessions");

    await userEvent.type(screen.getByPlaceholderText("Search sessions…"), "Snippets");
    const rows = within(sessions).getAllByTestId("usage-session-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Snippets screen redesign");
  });

  it("lists the hub project label on the Projects card", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "usage_load_latest_ccusage" ? richSessionsScan() : null));

    renderWithProviders(<LocalAgentUsage />);
    const projects = await screen.findByLabelText("Projects");
    expect(projects).toHaveTextContent("skill-tree");
  });

  it("marks the cost tile approximate and names the unpriced model count", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? unpricedModelScan() : null,
    );

    renderWithProviders(<LocalAgentUsage />);
    const costTile = (await screen.findByText("Estimated cost")).closest(".stat-card") as HTMLElement;
    expect(within(costTile).getByText("~$5.00")).toBeInTheDocument();
    expect(within(costTile).getByText(/1 model unpriced/)).toBeInTheDocument();
    // The title still carries the exact figure, never the "~" prefix.
    expect(within(costTile).getByText("~$5.00")).toHaveAttribute("title", "$5.00");

    // The card's own `<section>` and the `HorizontalBarList` it wraps both
    // carry this aria-label once real rows exist — the outer one is first.
    const models = screen.getAllByLabelText("Top models")[0];
    expect(within(models).getByText("unpriced")).toBeInTheDocument();
    expect(within(models).getByText(/1 model in this range have no price/)).toBeInTheDocument();
  });

  it("opens the Prices popover from the controls band and lists the override rates", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_pricing_info") return pricingInfoFixture();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    await userEvent.click(screen.getByRole("button", { name: "Prices" }));
    const dialog = await screen.findByRole("dialog", { name: "Price sources" });
    // The query is gated on `open` (REVIEW-W1 #7) — its first paint can be
    // the pending state, so wait for the real source line before any sync
    // assertion inside the panel.
    await within(dialog).findByText(/ccusage 20\.0\.17/);

    expect(within(dialog).getByText(/embedded price table · offline/)).toBeInTheDocument();
    // The override path folds a leading /Users/<name> to ~ (REVIEW-A #11).
    expect(within(dialog).getByText("~/.skill-hub/ccusage-pricing.json")).toBeInTheDocument();
    expect(within(dialog).getByText("Sonnet 5")).toBeInTheDocument();
    expect(within(dialog).getByTitle("gpt-6-astra")).toBeInTheDocument();
    expect(
      within(dialog).getByText("in 2.00 · out 10.00 · write 2.50 · read 0.20 $/MTok"),
    ).toBeInTheDocument();
    // REVIEW-W1 #8: the network-fetch consent note is conditional — the
    // toggle defaults off, and off makes no network call.
    expect(
      within(dialog).getByText(/Off: every scan uses the embedded price table and makes no network call/),
    ).toBeInTheDocument();
  });

  it("lists the unpriced models of the current range in the Prices popover", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return unpricedModelScan();
      if (cmd === "usage_pricing_info") return pricingInfoFixture();
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    await userEvent.click(screen.getByRole("button", { name: "Prices" }));
    const dialog = await screen.findByRole("dialog", { name: "Price sources" });

    expect(await within(dialog).findByText("Unpriced in this range")).toBeInTheDocument();
    expect(within(dialog).getByText("Opus 5")).toBeInTheDocument();
  });

  it("persists the online-pricing opt-in and passes it to the next scan", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_pricing_info") return pricingInfoFixture();
      if (cmd === "usage_scan_ccusage") return sampleScan({ totalTokens: 2_000 });
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    // Off: the header pill claims the private default.
    expect(screen.getByText("Runs locally · No raw prompts uploaded")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Prices" }));
    const dialog = await screen.findByRole("dialog", { name: "Price sources" });
    await within(dialog).findByRole("checkbox", { name: "Fetch the public price list when scanning" });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Fetch the public price list when scanning" }),
    );
    expect(localStorage.getItem("st:usage:onlinePricing")).toBe("true");

    // On: the pill names the network fetch instead — never the old "no raw
    // prompts uploaded" claim, which stops covering the whole truth once a
    // scan can leave the machine.
    expect(screen.getByText("Runs locally · fetches public prices")).toBeInTheDocument();
    expect(screen.queryByText("Runs locally · No raw prompts uploaded")).not.toBeInTheDocument();

    await userEvent.click(headerScanButton());
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage", { onlinePricing: true }),
    );
  });

  it("invalidates the price-source popover after a scan, so it reflects the new online/offline mode", async () => {
    // REVIEW-W1 #2: nothing previously invalidated `usagePricingInfo`, so a
    // scan that really did flip to online pricing left the popover naming
    // the stale offline mode for the rest of the session.
    let scanned = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_pricing_info") return pricingInfoFixture({ offline: !scanned });
      if (cmd === "usage_scan_ccusage") {
        scanned = true;
        return sampleScan({ totalTokens: 2_000 });
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    const pricesButton = screen.getByRole("button", { name: "Prices" });
    await userEvent.click(pricesButton);
    expect(await screen.findByText(/embedded price table · offline/)).toBeInTheDocument();
    await userEvent.click(pricesButton); // close — Popover unmounts, query goes inactive

    await userEvent.click(headerScanButton());
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_scan_ccusage", { onlinePricing: false }),
    );

    await userEvent.click(pricesButton); // reopen — invalidated, so it refetches
    expect(await screen.findByText(/public price list fetched on the last scan/)).toBeInTheDocument();
  });

  it("keeps the unpriced list when usage_pricing_info rejects", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return unpricedModelScan();
      if (cmd === "usage_pricing_info") return Promise.reject(new Error("boom"));
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    await userEvent.click(screen.getByRole("button", { name: "Prices" }));
    const dialog = await screen.findByRole("dialog", { name: "Price sources" });

    expect(await within(dialog).findByText("Price sources are unavailable.")).toBeInTheDocument();
    // The unpriced list comes from the scoped models, not the failed IPC —
    // a failing disclosure must not hide the part of itself that still works.
    expect(within(dialog).getByText("Opus 5")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", { name: "Fetch the public price list when scanning" }),
    ).toBeInTheDocument();
  });
});

function sampleScan({ totalTokens = 1200, includeCodexSession = false } = {}): UsageScan {
  const session: Record<string, unknown>[] = [
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
  const dailyAgents: Record<string, unknown>[] = [
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
  ];
  let totalsTokens = totalTokens;
  let totalsCost = 0.42;

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
      metadata: {
        projectPath: "/Users/alice/private/codex-lab",
        title: "Codex investigation",
        titleSource: "ai",
        gitBranch: "fix/codex",
        toolCalls: 63,
      },
    });
    session.push({
      agent: "pi",
      period: "2026-07-14T22:00:00Z",
      inputTokens: 300,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 350,
      totalCost: 0.3,
      modelsUsed: ["pi-model"],
      metadata: {
        projectPath: "/Users/alice/private/pi-lab",
        title: "Pi housekeeping",
        titleSource: "custom",
        toolCalls: 12,
        hubProject: "pi-lab",
      },
    });
    dailyAgents.push(
      { agent: "codex", inputTokens: 400, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 500, totalCost: 0.9, modelsUsed: ["gpt-5.5"] },
      { agent: "pi", inputTokens: 300, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 350, totalCost: 0.3, modelsUsed: ["pi-model"] },
    );
    totalsTokens += 850;
    totalsCost += 1.2;
  }

  return {
    scanned_at: FRESH_SCANNED_AT,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: {
      daily: [{ period: "2026-07-14", totalTokens: totalsTokens, totalCost: totalsCost, agents: dailyAgents }],
      session,
      totals: {
        inputTokens: totalTokens - 200,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: totalsTokens,
        totalCost: totalsCost,
      },
    },
  };
}

/** A `usage_pricing_info` fixture: one override row (rounds to clean
 *  $/MTok figures — in 2.00 · out 10.00 · write 2.50 · read 0.20) and a
 *  home-dir-shaped `overrides_path` so REVIEW-A #11's fold is exercised. */
function pricingInfoFixture(
  overrides: Partial<{
    ccusage_version: string | null;
    offline: boolean;
    overrides_path: string | null;
    overrides: Array<{ model: string; input: number; output: number; cache_write: number; cache_read: number }>;
  }> = {},
) {
  return {
    ccusage_version: "20.0.17",
    offline: true,
    overrides_path: "/Users/alice/.skill-hub/ccusage-pricing.json",
    overrides: [
      { model: "claude-sonnet-5", input: 0.000002, output: 0.00001, cache_write: 0.0000025, cache_read: 0.0000002 },
      { model: "gpt-6-astra", input: 0.00001, output: 0.00005, cache_write: 0.0000125, cache_read: 0.000001 },
    ],
    ...overrides,
  };
}

/** One day, one harness, two models: `claude-sonnet-5` priced at $5 and
 *  `claude-opus-5` carrying real tokens but $0 cost — a price-table gap, not
 *  a free model. The day agent's own `totalCost` (5) is what the KPI cost
 *  tile shows; only the model-level split feeds `Top models`/unpriced
 *  detection. */
function unpricedModelScan(): UsageScan {
  const dayAgent = {
    agent: "claude",
    inputTokens: 800,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 1_000,
    totalCost: 5,
    modelBreakdowns: [
      {
        modelName: "claude-sonnet-5",
        inputTokens: 800,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1_000,
        cost: 5,
      },
      {
        modelName: "claude-opus-5",
        inputTokens: 400,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 500,
        cost: 0,
      },
    ],
  };
  return {
    scanned_at: FRESH_SCANNED_AT,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: {
      daily: [{ period: "2026-07-14", totalTokens: 1_000, totalCost: 5, agents: [dayAgent] }],
      session: [
        {
          agent: "claude",
          period: "2026-07-14T20:00:00Z",
          inputTokens: 800,
          outputTokens: 200,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 1_000,
          totalCost: 5,
          modelsUsed: ["claude-sonnet-5"],
          metadata: { projectPath: "/Users/alice/private/skill-tree" },
        },
      ],
      totals: {
        inputTokens: 800,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1_000,
        totalCost: 5,
      },
    },
  };
}

function emptyScan(): UsageScan {
  return {
    scanned_at: FRESH_SCANNED_AT,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: { daily: [], session: [], totals: { totalTokens: 0, totalCost: 0 } },
  };
}

/** Four sessions across three harnesses, carrying the enrichment metadata
 *  (title, branch, PR, tool calls, hub project) — used by the title/PR/sort/
 *  search/projects tests. */
function richSessionsScan(): UsageScan {
  const session = [
    {
      agent: "claude",
      period: "sess-1-snippets",
      lastActivity: isoDaysAgo(2),
      inputTokens: 90_000,
      outputTokens: 10_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 100_000,
      totalCost: 14.28,
      modelsUsed: ["claude-sonnet-4"],
      metadata: {
        projectPath: "/Users/alice/private/skill-tree",
        title: "Snippets screen redesign",
        titleSource: "custom",
        gitBranch: "design/snippets",
        prNumber: 90,
        prUrl: "https://github.com/acme/skill-tree/pull/90",
        toolCalls: 10,
        hubProject: "skill-tree",
      },
    },
    {
      agent: "claude",
      period: "sess-2-scratch",
      lastActivity: isoDaysAgo(5),
      inputTokens: 45_000,
      outputTokens: 5_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 50_000,
      totalCost: 5,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { projectPath: "/Users/alice/private/scratch-notes", toolCalls: 300 },
    },
    {
      agent: "codex",
      period: "sess-3-codex",
      lastActivity: isoDaysAgo(10),
      inputTokens: 18_000,
      outputTokens: 2_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 20_000,
      totalCost: 2,
      modelsUsed: ["gpt-5.5"],
      metadata: {
        projectPath: "/Users/alice/private/codex-lab",
        title: "Codex investigation",
        titleSource: "ai",
        toolCalls: 50,
      },
    },
    {
      agent: "pi",
      period: "sess-4-pi",
      lastActivity: isoDaysAgo(0),
      inputTokens: 4_500,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 5_000,
      totalCost: 0.5,
      modelsUsed: ["pi-model"],
      metadata: {
        projectPath: "/Users/alice/private/notes-vault",
        title: "Pi session notes",
        titleSource: "custom",
        toolCalls: 5,
        hubProject: "notes-vault",
      },
    },
  ];

  return {
    scanned_at: FRESH_SCANNED_AT,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: {
      daily: [],
      session,
      totals: {
        inputTokens: 157_500,
        outputTokens: 17_500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 175_000,
        totalCost: 21.78,
      },
    },
  };
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
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
    scanned_at: FRESH_SCANNED_AT,
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
    scanned_at: FRESH_SCANNED_AT,
    source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
    raw: "",
    parsed: { daily: [], session, totals: { totalTokens: 100_000, totalCost: 5 } },
  };
}

/** Findings from the adversarial review of the redesign, each pinned here. */
describe("LocalAgentUsage — review regressions", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    localStorage.clear();
    vi.mocked(openUrl).mockClear();
  });

  it("keeps an undated session in a narrowed range's session LIST, but out of the daily-derived KPI cost", async () => {
    // Documented trade-off, revised for wave 2b (see docs/USAGE.md): the KPI
    // cost/token tiles are now ALWAYS daily-derived (history, or the scan's
    // own `daily` as a fallback) — never a session recompute, even under a
    // narrowed range. An undated session has no `daily` row to be counted
    // under, so it drops out of the KPI's own cost while staying fully
    // visible in the session list below (session filtering never drops an
    // undatable row — see `isWithinRange`).
    const scan: UsageScan = {
      scanned_at: FRESH_SCANNED_AT,
      source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
      raw: "",
      parsed: {
        daily: [dayRow(isoDaysAgo(1), 500, 1)],
        session: [
          {
            agent: "claude",
            period: isoDaysAgo(1),
            inputTokens: 500,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 500,
            totalCost: 1,
            modelsUsed: ["claude-sonnet-5"],
          },
          {
            // The shape ccusage uses when it has no date for a session — and
            // the one `new Date()` alone mis-reads as March 2001.
            agent: "claude",
            period: "claude-session-3",
            inputTokens: 300,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 300,
            totalCost: 3,
            modelsUsed: ["claude-sonnet-5"],
          },
        ],
        totals: { totalTokens: 800, totalCost: 4 },
      },
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? scan : null,
    );

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));

    // Both sessions survive the narrowing in the LIST…
    expect(
      within(screen.getByLabelText("Sessions")).getAllByTestId("usage-session-row"),
    ).toHaveLength(2);
    // …but the KPI cost reads ONLY the one daily row ($1) — the undated
    // session's $3 has no day to be counted under.
    const costTile = screen.getByText("Estimated cost").closest(".stat-card") as HTMLElement;
    expect(within(costTile).getByText("$1.00")).toBeInTheDocument();
    // The chart only has the one datable day too — the same source as the KPI.
    expect(container.querySelector(".usage-spend-card")?.querySelectorAll(".chart-col")).toHaveLength(1);
  });

  it("keeps a harness's identity hue when another harness leaves the range", async () => {
    // Colour follows the entity, not its rank: Codex is --id-1 whether or not
    // Claude has any usage in the active window.
    const claudeDay = {
      period: isoDaysAgo(20),
      totalTokens: 900,
      totalCost: 2,
      agents: [{ agent: "claude", totalTokens: 900, totalCost: 2, modelsUsed: ["claude-sonnet-5"] }],
    };
    const codexDay = {
      period: isoDaysAgo(1),
      totalTokens: 400,
      totalCost: 1,
      agents: [{ agent: "codex", totalTokens: 400, totalCost: 1, modelsUsed: ["gpt-5"] }],
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? dailyScan([claudeDay, codexDay]) : null,
    );

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Spend over time");

    const codexSeg = () =>
      container.querySelector<HTMLElement>('.chart-col-seg[data-series="codex"]')!;
    expect(codexSeg().style.background).toBe("var(--id-1)");

    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));

    // Claude is gone from the scope; Codex must NOT slide into --id-0.
    expect(container.querySelector('[data-series="claude"]')).toBeNull();
    expect(codexSeg().style.background).toBe("var(--id-1)");
  });

  it("renders a ccusage agent outside the harness map with no brand glyph and no crash", async () => {
    const geminiDay = {
      period: isoDaysAgo(1),
      totalTokens: 700,
      totalCost: 2,
      agents: [{ agent: "gemini", totalTokens: 700, totalCost: 2, modelsUsed: ["gemini-3-pro"] }],
    };
    const scan: UsageScan = {
      scanned_at: FRESH_SCANNED_AT,
      source: { command: "ccusage", args: ["--json"], resolved_from: "test-runner" },
      raw: "",
      parsed: {
        daily: [geminiDay],
        session: [
          {
            agent: "gemini",
            period: isoDaysAgo(1),
            inputTokens: 700,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 700,
            totalCost: 2,
            modelsUsed: ["gemini-3-pro"],
          },
        ],
        totals: { totalTokens: 700, totalCost: 2 },
      },
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? scan : null,
    );

    const { container } = renderWithProviders(<LocalAgentUsage />);
    const breakdown = await screen.findByLabelText("Harness breakdown");

    // The row is there, named, with the neutral placeholder instead of a
    // guessed brand mark.
    // ccusage names the agent, but it is outside the hub harness map, so
    // there is no brand mark to draw.
    expect(within(breakdown).getByText("Gemini CLI")).toBeInTheDocument();
    expect(breakdown.querySelector(".usage-harness-glyph-fallback")).toBeInTheDocument();
    expect(breakdown.querySelector(".harness-glyph.has-icon")).toBeNull();
    // It still gets one of the open identity slots, never an out-of-ramp index.
    const fill = breakdown.querySelector<HTMLElement>(".usage-share-fill")!;
    expect(fill.style.background).toMatch(/^var\(--id-[4-7]\)$/);
    // And the session row degrades to a monogram rather than throwing.
    expect(container.querySelector('.harness-glyph[data-harness="gemini"]')).toBeInTheDocument();
  });

  it("accepts a comma decimal in the EUR rate", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("radio", { name: "EUR" }));

    const rate = screen.getByLabelText("EUR per USD") as HTMLInputElement;
    fireEvent.change(rate, { target: { value: "0,9" } });

    // The typed text stands, and the comma is understood as a decimal point
    // rather than parsed as a bare "0" (out of band → default 0.86).
    expect(rate.value).toBe("0,9");
    expect(localStorage.getItem("st:usage:eurRate")).toBe("0.9");
  });

  it("lets the rate be retyped digit by digit without substituting a default", async () => {
    // The controlled-number bug: "0" is out of band and "0." is unparseable,
    // so typing "0.95" over "0.86" used to snap the field back or replace the
    // value with the default on the very first keystroke.
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    await userEvent.click(screen.getByRole("radio", { name: "EUR" }));
    const rate = screen.getByLabelText("EUR per USD") as HTMLInputElement;

    for (const step of ["0", "0.", "0.9", "0.95"]) {
      fireEvent.change(rate, { target: { value: step } });
      expect(rate.value).toBe(step);
    }
    expect(localStorage.getItem("st:usage:eurRate")).toBe("0.95");
  });

  it("never silently swaps an out-of-band rate for the default", async () => {
    localStorage.setItem("st:usage:eurRate", "0.5");
    useUsagePreferences.setState(readUsagePreferences());
    localStorage.setItem("st:usage:currency", "EUR");
    useUsagePreferences.setState(readUsagePreferences());
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    const rate = screen.getByLabelText("EUR per USD") as HTMLInputElement;
    expect(rate.value).toBe("0.5");

    fireEvent.change(rate, { target: { value: "9" } });
    // 9 is outside the accepted band: the stored rate holds at 0.5 rather
    // than being replaced by 0.86.
    expect(localStorage.getItem("st:usage:eurRate")).toBe("0.5");
    fireEvent.blur(rate);
    expect(rate.value).toBe("0.5");
  });

  it("hydrates straight into EUR with no USD first paint", async () => {
    localStorage.setItem("st:usage:currency", "EUR");
    useUsagePreferences.setState(readUsagePreferences());
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    const costTile = (await screen.findByText("Estimated cost")).closest(".stat-card") as HTMLElement;
    expect(within(costTile).getByText(/€/)).toBeInTheDocument();
    expect(within(costTile).queryByText(/\$/)).not.toBeInTheDocument();
    // PLAN §5.2 — the hero tile names the rate it converted at.
    expect(within(costTile).getByText(/converted at 0\.86 EUR\/USD/)).toBeInTheDocument();
  });

  it("says 'across 1 harness', not '1 harnesses'", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    const tile = container.querySelector(".usage-kpis .stat-card:nth-child(3)") as HTMLElement;
    expect(within(tile).getByText("Sessions")).toBeInTheDocument();
    expect(within(tile).getByText("across 1 harness")).toBeInTheDocument();
  });

  it("never prints a dangling id fragment in a fallback session name", async () => {
    // shortId cuts at 8 chars, which can land mid-separator ("2026-07-14"
    // → "2026-07-"); and a period with nothing showable drops the id clause.
    expect(shortId("2026-07-14T20:00:00Z")).toBe("2026-07");
    expect(shortId("----")).toBe("");

    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sampleScan() : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    const row = (
      await within(await screen.findByLabelText("Sessions")).findAllByTestId("usage-session-row")
    )[0];
    expect(within(row).getByText("2026-07")).toBeInTheDocument();
    // The row's accessible name is built from the same helper, so the two
    // cannot drift.
    expect(row.getAttribute("aria-label")).toContain("Claude Code session 2026-07");
  });

  it("puts undated sessions last under 'Most recent', deterministically", async () => {
    const rows = [
      { agent: "claude", period: "claude-session-a", totalTokens: 100, totalCost: 1, modelsUsed: ["m"], inputTokens: 100, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { agent: "claude", period: isoDaysAgo(5), totalTokens: 200, totalCost: 2, modelsUsed: ["m"], inputTokens: 200, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { agent: "claude", period: "claude-session-b", totalTokens: 300, totalCost: 3, modelsUsed: ["m"], inputTokens: 300, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { agent: "claude", period: isoDaysAgo(1), totalTokens: 400, totalCost: 4, modelsUsed: ["m"], inputTokens: 400, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "usage_load_latest_ccusage" ? sessionsScan(rows) : null,
    );
    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Sessions");

    pickSelectOption("Sort", "Most recent");

    const names = within(screen.getByLabelText("Sessions"))
      .getAllByTestId("usage-session-row")
      .map((row) => row.getAttribute("aria-label") ?? "");
    // The two datable sessions first, newest first; the two undated ones
    // last, in a stable (id-tiebroken) order rather than an engine-dependent
    // one — two -Infinity keys used to subtract to NaN.
    expect(names[0]).toContain("400 tokens");
    expect(names[1]).toContain("200 tokens");
    expect(names.slice(2).every((n) => /100 tokens|300 tokens/.test(n))).toBe(true);
  });
});

describe("Cache hit rate tile — hint overlay copy", () => {
  it("grounds the explainer in the scope's own numbers and the 10% cache-read pricing fact", async () => {
    const { UsageKpiRow } = await import("@/screens/usage/UsageKpiRow");
    const { container } = renderWithProviders(
      <UsageKpiRow
        costUsd={100}
        currency="USD"
        eurRate={0.86}
        tokens={{ input: 500, output: 100, cacheCreation: 200, cacheRead: 4300, total: 5100 }}
        sessions={3}
        toolCalls={40}
        cacheHitRate={0.92}
        harnesses={[]}
      />,
    );
    const tile = [...container.querySelectorAll(".stat-card")].find((el) =>
      el.textContent?.includes("Cache hit rate"),
    )!;
    const tooltip = tile.querySelector(".stat-hint")!;
    expect(tooltip).toBeTruthy();
    // input(500) + cacheRead(4300) + cacheCreation(200) = 5000 prompt tokens,
    // of which 4300 were cache reads — formatCompact renders "4.3k of 5k".
    expect(tooltip.textContent).toContain("4.3k of 5k prompt tokens were cache reads");
    expect(tooltip.textContent).toContain("10% of the input price");
    expect(tooltip.textContent).toContain("Sources: Anthropic prompt caching docs · OpenAI prompt caching guide");
  });
});

describe("LocalAgentUsage — durable usage history (wave 2b)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    localStorage.clear();
    // `Processes` is module-level (a real app has one process tray) — a
    // FAILED process from an earlier test does not auto-dismiss, so a later
    // test's `Processes.list().find(...)` could otherwise match a stale one.
    for (const p of Processes.list()) Processes.dismiss(p.id);
  });

  it("reads history for the chart and KPI tokens tile when history holds days", async () => {
    const payload = historyPayload({
      days: [historyDay("2026-08-20", 50_000)],
      counts: { days: 1, rows: 1, backfilled_days: 0, frozen_days: 0, scanned_days: 1 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_200 });
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    // ONE column, for the history-only day — not the scan's own 2026-07-14.
    expect(container.querySelector(".usage-spend-card")?.querySelectorAll(".chart-col")).toHaveLength(1);
    const tokensTile = container.querySelectorAll(".usage-kpis .stat-card")[1] as HTMLElement;
    expect(within(tokensTile).getByText(formatCompact(50_000))).toBeInTheDocument();
  });

  it("falls back to the scan's own daily when history holds no days", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_200 });
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    const { container } = renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    expect(container.querySelectorAll(".chart-col")).toHaveLength(1);
    const tokensTile = container.querySelectorAll(".usage-kpis .stat-card")[1] as HTMLElement;
    expect(within(tokensTile).getByText(formatCompact(1_200))).toBeInTheDocument();
  });

  it("shows the backfilled legend note, the cost caveat and the blanked cache-hit tile — each on its own condition", async () => {
    const payload = historyPayload({
      days: [historyDay("2026-05-20", 5_000, { provenance: "backfilled" }), historyDay("2026-08-20", 40_000)],
      counts: { days: 2, rows: 2, backfilled_days: 1, frozen_days: 0, scanned_days: 1 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    // Backfilled legend note (default measure = tokens).
    expect(screen.getByText(/1 day from Claude Code's own stats \(tokens only\)/)).toBeInTheDocument();
    // KPI cost caveat.
    expect(screen.getByText(/cost excludes 1 backfilled day/)).toBeInTheDocument();
    // Cache-hit tile blanked with an explaining title.
    const cacheHitTile = screen.getByText("Cache hit rate").closest(".stat-card") as HTMLElement;
    expect(within(cacheHitTile).getByText("—")).toBeInTheDocument();
    // Composition card's own split-unavailable caption.
    expect(screen.getByText(/Split unavailable for 1 backfilled day/)).toBeInTheDocument();
  });

  it("shows none of the backfilled caveats when every day in scope is scanned", async () => {
    const payload = historyPayload({
      days: [historyDay("2026-08-20", 40_000)],
      counts: { days: 1, rows: 1, backfilled_days: 0, frozen_days: 0, scanned_days: 1 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");

    expect(screen.queryByText(/from Claude Code's own stats \(tokens only\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cost excludes/)).not.toBeInTheDocument();
    const cacheHitTile = screen.getByText("Cache hit rate").closest(".stat-card") as HTMLElement;
    expect(within(cacheHitTile).queryByText("—")).not.toBeInTheDocument();
  });

  it("shows the ledger_note banner after a live scan carries one, and not before", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return { ...sampleScan(), ledger_note: "hub usage record exited non-zero" };
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(screen.queryByText(/Usage history was not updated for this scan/)).not.toBeInTheDocument();

    await userEvent.click(headerScanButton());
    expect(
      await screen.findByText(/Usage history was not updated for this scan — hub usage record exited non-zero/),
    ).toBeInTheDocument();
  });

  it("shows the sessions provenance note exactly once", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(
      screen.getAllByText(/Sessions, projects and tool calls come from the latest scan/),
    ).toHaveLength(1);
  });

  it("shows the Claude Code stats import CTA only when importable_days > 0, and clicking it imports + refreshes history", async () => {
    let claudeStats = { available: true, path: "~/.claude/stats-cache.json", importable_days: 12, last_computed: "2026-05-31" };
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      if (cmd === "hub_cmd") {
        const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
          return { success: true, output: JSON.stringify(historyPayload({ claude_stats: claudeStats })) };
        }
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "import-claude-stats") {
          claudeStats = { ...claudeStats, importable_days: 0 };
          return {
            success: true,
            output: JSON.stringify({
              path: "~/.claude/stats-cache.json",
              skipped_existing: 0,
              skipped_ccusage_days: 0,
              dry_run: false,
              inserted: 12,
              warnings: [],
            }),
          };
        }
        return { success: true, output: "" };
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const importButton = await screen.findByRole("button", {
      name: /Import 12 days from Claude Code's own stats/i,
    });

    await userEvent.click(importButton);

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
        args: ["usage", "import-claude-stats", "--json"],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Import \d+ days? from Claude Code's own stats/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("capture-on-open: fires the scan once on mount when there is no cached scan at all", async () => {
    const scanCalls: number[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return null;
      if (cmd === "usage_scan_ccusage") {
        scanCalls.push(Date.now());
        return sampleScan();
      }
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await waitFor(() => expect(scanCalls.length).toBe(1));
    await screen.findByLabelText("Cached usage summary");
    expect(scanCalls.length).toBe(1);
  });

  it("capture-on-open: does not fire for a cache 59m old", async () => {
    const scanCalls: number[] = [];
    const freshCache = sampleScan({ totalTokens: 999 });
    freshCache.scanned_at = Math.floor(Date.now() / 1000) - 59 * 60;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return freshCache;
      if (cmd === "usage_scan_ccusage") {
        scanCalls.push(Date.now());
        return sampleScan();
      }
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(scanCalls.length).toBe(0);
  });

  it("capture-on-open: fires once for a cache 2h old, and a re-render does not fire it again", async () => {
    const scanCalls: number[] = [];
    const staleCache = sampleScan({ totalTokens: 999 });
    staleCache.scanned_at = Math.floor(Date.now() / 1000) - 2 * 3600;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return staleCache;
      if (cmd === "usage_scan_ccusage") {
        scanCalls.push(Date.now());
        return sampleScan();
      }
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    const { rerender } = renderWithProviders(<LocalAgentUsage />);
    await waitFor(() => expect(scanCalls.length).toBe(1));

    rerender(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(scanCalls.length).toBe(1);
  });

  it("C2: a successful scan invalidates the durable history query, so the header scan updates the chart", async () => {
    let historyCalls = 0;
    let daysNow = [historyDay("2026-08-20", 50_000)];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan({ totalTokens: 1_200 });
      if (cmd === "usage_scan_ccusage") {
        // The ledger GREW as a result of this scan (mirrors the Rust
        // post-scan `hub usage record` hook) — the next `usage history`
        // fetch must see it.
        daysNow = [historyDay("2026-08-20", 50_000), historyDay("2026-08-21", 999_000)];
        return sampleScan({ totalTokens: 999_000 });
      }
      if (cmd === "hub_cmd") {
        const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
          historyCalls += 1;
          return {
            success: true,
            output: JSON.stringify(
              historyPayload({
                days: daysNow,
                counts: {
                  days: daysNow.length,
                  rows: daysNow.length,
                  backfilled_days: 0,
                  frozen_days: 0,
                  scanned_days: daysNow.length,
                },
              }),
            ),
          };
        }
        return { success: true, output: "" };
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(screen.getByLabelText("Spend over time").querySelectorAll(".chart-col")).toHaveLength(1);
    const callsBeforeRefresh = historyCalls;

    await userEvent.click(headerScanButton());

    // The false-green this pins against: a mock whose `usage_scan_ccusage`
    // resolves but whose history query is never re-fetched would leave the
    // chart at 1 column forever.
    await waitFor(() => expect(historyCalls).toBeGreaterThan(callsBeforeRefresh));
    await waitFor(() =>
      expect(screen.getByLabelText("Spend over time").querySelectorAll(".chart-col")).toHaveLength(2),
    );
  });

  it("C3: a failing import-claude-stats surfaces a FAILED process, never a fake 'imported 0 days' success", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      if (cmd === "hub_cmd") {
        const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
          return {
            success: true,
            output: JSON.stringify(
              historyPayload({
                claude_stats: {
                  available: true,
                  path: "~/.claude/stats-cache.json",
                  importable_days: 12,
                  last_computed: "2026-05-31",
                },
              }),
            ),
          };
        }
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "import-claude-stats") {
          // The CLI's OWN failure shape (`_usage_fail`): a non-zero exit
          // that still prints one parseable `{"ok": false, ...}` object.
          return {
            success: false,
            output: JSON.stringify({ ok: false, error: "no Claude stats cache at ~/.claude/stats-cache.json" }),
          };
        }
        return { success: true, output: "" };
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const importButton = await screen.findByRole("button", {
      name: /Import 12 days from Claude Code's own stats/i,
    });
    await userEvent.click(importButton);

    await waitFor(() => {
      const proc = Processes.list().find((p) => p.target === USAGE_IMPORT_TARGET);
      expect(proc?.status).toBe("error");
      expect(proc?.body).toMatch(/no Claude stats cache at/);
    });
    // Nothing was actually imported, so the CTA must still be reachable —
    // the pre-fix bug reported success and left `importable_days` untouched
    // too, but for the wrong reason (it never even read the failure).
    expect(screen.getByRole("button", { name: /Import 12 days from Claude Code's own stats/i })).toBeInTheDocument();
  });

  it("W4: a successful import with warnings appends 'N warnings' to the process success body", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "usage_scan_ccusage") return sampleScan();
      if (cmd === "hub_cmd") {
        const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
          return {
            success: true,
            output: JSON.stringify(
              historyPayload({
                claude_stats: {
                  available: true,
                  path: "~/.claude/stats-cache.json",
                  importable_days: 5,
                  last_computed: "2026-05-31",
                },
              }),
            ),
          };
        }
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "import-claude-stats") {
          return {
            success: true,
            output: JSON.stringify({
              path: "~/.claude/stats-cache.json",
              skipped_existing: 0,
              skipped_ccusage_days: 0,
              dry_run: false,
              inserted: 5,
              warnings: ["stats-cache: duplicate date '2026-05-20' — using the last occurrence"],
            }),
          };
        }
        return { success: true, output: "" };
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    const importButton = await screen.findByRole("button", {
      name: /Import 5 days from Claude Code's own stats/i,
    });
    await userEvent.click(importButton);

    await waitFor(() => {
      const proc = Processes.list().find((p) => p.target === USAGE_IMPORT_TARGET);
      expect(proc?.status).toBe("success");
      expect(proc?.body).toBe("imported 5 days, 1 warning");
    });
  });

  it("C4: reading useLocalAgentUsage() from a second consumer never fires a second scan", async () => {
    // Regression for review C4 — capture-on-open used to live INSIDE
    // `useLocalAgentUsage()`, so every consumer of that hook (the NavPanel's
    // Agents glance, `useProjectActivity`) fired its own scan as a side
    // effect of merely reading the cache. Mounting a second, bare consumer
    // of the hook alongside the Usage screen must add zero scans.
    const scanCalls: number[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return null;
      if (cmd === "usage_scan_ccusage") {
        scanCalls.push(Date.now());
        return sampleScan();
      }
      const hub = await historyHubCmd(historyPayload())(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    function BareSecondConsumer() {
      useLocalAgentUsage();
      return null;
    }

    renderWithProviders(
      <>
        <LocalAgentUsage />
        <BareSecondConsumer />
      </>,
    );
    await waitFor(() => expect(scanCalls.length).toBe(1));
    await screen.findByLabelText("Cached usage summary");
    // Give any stray effect a chance to fire before asserting the final count.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanCalls.length).toBe(1);
  });

  it("W3: a failed auto-scan renders the SAME error state a manual scan would (no new UI state), and is not retried on remount", async () => {
    let scanAttempts = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return null;
      if (cmd === "usage_scan_ccusage") {
        scanAttempts += 1;
        return Promise.reject({ kind: "process_failure", message: "ccusage could not finish the scan." });
      }
      return null;
    });

    const { rerender } = renderWithProviders(<LocalAgentUsage />);
    await waitFor(() => expect(scanAttempts).toBe(1));
    // No snapshot exists either way, so this is the exact `UsageErrorState`
    // a MANUAL scan failure already renders (`classifyError` → "ccusage") —
    // review W3 explicitly does not ask for a new state, only for the retry
    // loop to stop.
    await screen.findByText("ccusage could not finish the scan");

    rerender(<LocalAgentUsage />);
    rerender(<LocalAgentUsage />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanAttempts).toBe(1);
  });

  it("capture-on-open: permits one new attempt after the per-cache-key hour", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleCache = sampleScan();
    staleCache.scanned_at = now - 2 * 3600;
    let scanAttempts = 0;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") return staleCache;
      if (cmd === "usage_scan_ccusage") {
        scanAttempts += 1;
        return Promise.reject({ kind: "process_failure", message: "scan failed" });
      }
      return null;
    });

    const { unmount } = renderWithProviders(<LocalAgentUsage />);
    await waitFor(() => expect(scanAttempts).toBe(1));
    vi.spyOn(Date, "now").mockReturnValue((now + 3601) * 1000);
    unmount();
    renderWithProviders(<LocalAgentUsage />);
    await waitFor(() => expect(scanAttempts).toBe(2));
    vi.restoreAllMocks();
  });

  it("W1: a populated ledger renders the dashboard even when the latest scan is empty, with the zero-scan copy demoted to a banner", async () => {
    const payload = historyPayload({
      days: [historyDay("2026-08-20", 50_000)],
      counts: { days: 1, rows: 1, backfilled_days: 0, frozen_days: 0, scanned_days: 1 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // ccusage found nothing THIS scan — the pre-fix bug hid the ledger
      // entirely behind this exact snapshot shape.
      if (cmd === "usage_load_latest_ccusage") return emptyScan();
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    expect(await screen.findByLabelText("Cached usage summary")).toBeInTheDocument();
    expect(screen.queryByText("No local harness usage was detected yet")).not.toBeInTheDocument();
    expect(
      screen.getByText(/ccusage did not find local harness usage in the latest scan/),
    ).toBeInTheDocument();
  });

  it("W1: the import CTA renders in the zero-usage state too, when Claude Code's own stats are importable", async () => {
    const payload = historyPayload({
      claude_stats: {
        available: true,
        path: "~/.claude/stats-cache.json",
        importable_days: 30,
        last_computed: "2026-05-31",
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return emptyScan();
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    expect(await screen.findByText("No local harness usage was detected yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Import 30 days from Claude Code's own stats/i }),
    ).toBeInTheDocument();
  });

  it("W6: a failing history query shows one InfoBanner over the scan-only fallback", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      if (cmd === "hub_cmd") {
        const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
        if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
          return { success: false, output: "hub usage history exited non-zero (no output)" };
        }
        return { success: true, output: "" };
      }
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(
      await screen.findByText(/Usage history is unavailable — showing the latest scan only\./),
    ).toBeInTheDocument();
  });

  it("W6: ledger-line warnings append 'N ledger lines were skipped' to the same banner", async () => {
    const payload = historyPayload({
      days: [historyDay("2026-08-20", 50_000)],
      counts: { days: 1, rows: 1, backfilled_days: 0, frozen_days: 0, scanned_days: 1 },
      warnings: ["state/usage/history.jsonl:12: dropped malformed usage row"],
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "usage_load_latest_ccusage") return sampleScan();
      const hub = await historyHubCmd(payload)(cmd, args);
      if (hub !== undefined) return hub;
      return null;
    });

    renderWithProviders(<LocalAgentUsage />);
    await screen.findByLabelText("Cached usage summary");
    expect(await screen.findByText(/1 ledger line was skipped\./)).toBeInTheDocument();
  });
});
