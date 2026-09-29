import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { UsageSessionTimeline } from "@/screens/usage/UsageSessionTimeline";
import {
	TIMELINE_EVENTS_PER_SEGMENT_CAP,
	TIMELINE_SEGMENT_CAP,
} from "@/screens/usage/usageTimelineModel";
import { ScanButton } from "@/screens/usage/UsageScanAction";
import { Processes } from "@/store/processes";
import { renderWithProviders } from "./helpers";
import type {
  UsageEvent,
  UsageEventTokens,
  UsageSessionPayload,
  UsageSessionSummary,
  UsageScanResult,
} from "@/features/usage/usageAnalyticsTypes";

const ZERO_TOKENS: UsageEventTokens = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };

const ZERO_SUMMARY: UsageSessionSummary = {
  tokens_total: 0,
  cache_hit_ratio: 0,
  steering_count: 0,
  duration_minutes: 0,
  activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 0, skill: 0, external: 0 },
  thinking_text_share: 0,
  subagent_token_share: 0,
  loadout_assumed: false,
};

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    kind: "human_turn",
    at: "2026-09-05T09:00:00.000Z",
    token_delta: 0,
    tokens: ZERO_TOKENS,
    thinking_len: 0,
    output_text_len: 0,
    name: null,
    model: null,
    invoker: null,
    activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 0, skill: 0, external: 0 },
    edited_without_verify: false,
    ...overrides,
  };
}

function payload(overrides: Partial<UsageSessionPayload>): UsageSessionPayload {
  return {
    ok: true,
    session_id: "cccccccc-4444-4444-8444-444444444444",
    harness: "claude-code",
    project: "kinds",
    window: null,
    last_scan_at: "2026-09-07T12:00:00.000Z",
    transcript_present: true,
    summary: { ...ZERO_SUMMARY, tokens_total: 1001, steering_count: 3, duration_minutes: 2 },
    intent_excerpt: "Ship this please.",
    events: [],
    subagents: [],
    ...overrides,
  };
}

/** Installs a `hub_cmd` mock that answers `usage session …` with `response`
 *  and `usage scan-sessions …` with a settled, successful scan — recording
 *  every `hub_cmd` call's args for assertion. */
function mockSession(
  response: UsageSessionPayload | ((args: string[]) => UsageSessionPayload),
  scanResponse: UsageScanResult | Promise<UsageScanResult> = {
    ok: true,
    rows_written: 3,
    rows_frozen: 0,
    frozen_appended: 0,
    files_scanned: 1,
    files_skipped: 0,
    bytes_read: 100,
    sessions_unregistered: 0,
    stopped_on: null,
    errors: [],
    malformed_rows_dropped: 0,
    last_scan_at: "2026-09-07T12:00:00.000Z",
  },
) {
  const calls: string[][] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown): Promise<unknown> => {
    if (cmd !== "hub_cmd") return { success: true, output: "" };
    const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
    calls.push(cmdArgs);
    if (cmdArgs[0] === "usage" && cmdArgs[1] === "session") {
      const body = typeof response === "function" ? response(cmdArgs) : response;
      return { success: true, output: JSON.stringify(body) };
    }
    if (cmdArgs[0] === "usage" && cmdArgs[1] === "scan-sessions") {
      const result = await scanResponse;
      return {
        success: true,
        output: JSON.stringify(result),
      };
    }
    return { success: true, output: "" };
  });
  return calls;
}

describe("UsageSessionTimeline", () => {
  it("renders one segment per steering turn, tagged events, sub-agent rows, and the edit-without-verify marker", async () => {
    const events: UsageEvent[] = [
      event({
        kind: "human_turn",
        invoker: "you",
        excerpt: "Ship this please.",
      }),
      event({
        kind: "skill",
        name: "brainstorm",
        invoker: "model",
        token_delta: 380,
        tokens: { input: 2, output: 80, cache_creation: 300, cache_read: 600 },
        thinking_len: 10,
        output_text_len: 50,
        activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 0, skill: 1, external: 0 },
        edited_without_verify: true,
      }),
      event({
        kind: "slash_command",
        name: "brainstorm",
        invoker: "you",
        excerpt:
          "<command-name>brainstorm</command-name><command-message>Brainstorm</command-message><command-args>the plan</command-args>",
      }),
      event({
        kind: "script",
        name: "unslop",
        invoker: "script",
      }),
      event({ kind: "human_turn", invoker: "you", excerpt: "" }),
      event({
        kind: "subagent",
        name: "orch-planner",
        invoker: "model",
        model: "claude-opus-5",
        token_delta: 5,
        tokens: { input: 2, output: 5, cache_creation: 0, cache_read: 0 },
        output_text_len: 5,
        activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 1, skill: 0, external: 0 },
      }),
      event({ kind: "tool", name: "exec_command", invoker: "model" }),
      event({ kind: "compaction", name: "ContextCompaction", invoker: "model" }),
    ];

    mockSession(
      payload({
        events,
        subagents: [{ type: "planner", model: "claude-opus-5", tokens: 120 }],
      }),
    );

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    const summary = await screen.findByTestId("usage-timeline-summary");
    expect(summary.textContent).not.toBe("");

    const segments = await screen.findAllByTestId("usage-timeline-segment");
    expect(segments).toHaveLength(3);

    // Invoker tags.
    expect(screen.getAllByText("you").length).toBeGreaterThan(0);
    expect(screen.getAllByText("model").length).toBeGreaterThan(0);
    expect(screen.getAllByText("script").length).toBeGreaterThan(0);

    // Sub-agent event row names the model — the subagent event belongs to
    // the THIRD segment (it follows the second human_turn opener).
    expect(within(segments[2]).getByText("orch-planner")).toBeInTheDocument();
    expect(within(segments[2]).getByText("claude-opus-5")).toBeInTheDocument();
    expect(within(segments[2]).getByText("Tool")).toBeInTheDocument();
    expect(within(segments[2]).getByText("Compaction")).toBeInTheDocument();

    // Marker present on the segment whose event carries edited_without_verify,
    // and nowhere else.
    expect(within(segments[0]).getByText(/edit without verify/i)).toBeInTheDocument();
    expect(within(segments[1]).queryByText(/edit without verify/i)).not.toBeInTheDocument();
    expect(within(segments[2]).queryByText(/edit without verify/i)).not.toBeInTheDocument();

    // Segment 2's own tokens are all zero, so both derived ratios are "n/a",
    // never "0%" or an em-dash.
    expect(within(segments[1]).getAllByText("n/a")).toHaveLength(2);

    // An empty (non-pruned) excerpt still renders the dim dash, never a
    // blank quote.
    expect(within(segments[2]).getByText("—")).toBeInTheDocument();

    // Sub-agent rows section.
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("120 tokens")).toBeInTheDocument();
  });

  it("shows the pruned-transcript banner and dims excerpts while every number still renders", async () => {
    mockSession(
      payload({
        transcript_present: false,
        intent_excerpt: "",
        events: [event({ kind: "human_turn", invoker: "you", excerpt: "" })],
      }),
    );

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    const banner = await screen.findByTestId("usage-timeline-pruned");
    expect(banner.textContent).toMatch(/pruned/i);

    // Numbers still render.
    const summary = await screen.findByTestId("usage-timeline-summary");
    expect(summary.textContent).not.toBe("");

    // Every excerpt renders as a dim dash, not an empty quote.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the not_found state naming the short id and offering Scan sessions", async () => {
    const calls = mockSession(
      payload({
        ok: false,
        reason: "not_found",
        last_scan_at: null,
        transcript_present: false,
        events: [],
      }),
    );

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    const notFound = await screen.findByTestId("usage-timeline-not-found");
    expect(within(notFound).getByText(/has not been scanned yet/i)).toBeInTheDocument();
    expect(within(notFound).getByText("cccccccc")).toBeInTheDocument();

    const scanButton = within(notFound).getByRole("button", { name: /scan sessions/i });
    await userEvent.click(scanButton);

    await waitFor(() =>
      expect(calls.some((c) => c[0] === "usage" && c[1] === "scan-sessions")).toBe(true),
    );
  });

  it("renders the not_found state when ok is true but last_scan_at is null", async () => {
    mockSession(payload({ last_scan_at: null, events: [] }));

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    expect(await screen.findByTestId("usage-timeline-not-found")).toBeInTheDocument();
  });

  it("shares the busy state with the route Scan button", async () => {
    let resolveScan: (result: UsageScanResult) => void = () => {};
    const pending = new Promise<UsageScanResult>((resolve) => {
      resolveScan = resolve;
    });
    mockSession(payload({ ok: false, reason: "not_found", last_scan_at: null, events: [] }), pending);

    renderWithProviders(
      <>
        <ScanButton />
        <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />
      </>,
    );

    const notFound = await screen.findByTestId("usage-timeline-not-found");
    await userEvent.click(within(notFound).getByRole("button", { name: "Scan sessions" }));
    await waitFor(() => {
      expect(within(notFound).getByRole("button", { name: "Scan sessions" })).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("button", { name: "Scan" })).toHaveAttribute("aria-busy", "true");
    });

    resolveScan({
      ok: true,
      rows_written: 0,
      rows_frozen: 0,
      frozen_appended: 0,
      files_scanned: 0,
      files_skipped: 0,
      bytes_read: 0,
      sessions_unregistered: 0,
      stopped_on: null,
      errors: [],
      malformed_rows_dropped: 0,
      last_scan_at: "2026-09-07T12:00:00.000Z",
      harnesses: {},
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan" })).not.toHaveAttribute("aria-busy"));
    for (const process of Processes.list()) Processes.dismiss(process.id);
  });

  it("renders the ambiguity chooser instead of an error card", async () => {
    const calls = mockSession((cmdArgs) => {
      const harnessIdx = cmdArgs.indexOf("--harness");
      if (harnessIdx >= 0) {
        return payload({ harness: cmdArgs[harnessIdx + 1], events: [] });
      }
      return payload({ ok: false, reason: "ambiguous", harness: undefined, events: [] });
    });

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    const chooser = await screen.findByTestId("usage-timeline-ambiguous");
    expect(within(chooser).getByText(/two sessions share this id\. open/i)).toBeInTheDocument();

    await userEvent.click(
      within(chooser).getByRole("button", { name: /open the claude-code one/i }),
    );

    await waitFor(() =>
      expect(
        calls.some((c) => c[0] === "usage" && c[1] === "session" && c.includes("--harness") && c[c.indexOf("--harness") + 1] === "claude-code"),
      ).toBe(true),
    );
    // Resolves to the normal timeline once a harness is chosen.
    expect(await screen.findByTestId("usage-timeline")).toBeInTheDocument();
  });

  it("caps rendered segments at TIMELINE_SEGMENT_CAP, keeping the last ones, with a Show-earlier control", async () => {
    const extra = 5;
    const total = TIMELINE_SEGMENT_CAP + extra;
    const events: UsageEvent[] = [];
    for (let i = 0; i < total; i++) {
      events.push(event({ kind: "human_turn", invoker: "you", excerpt: `Turn ${i}` }));
    }
    mockSession(payload({ events }));

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    let segments = await screen.findAllByTestId("usage-timeline-segment");
    expect(segments).toHaveLength(TIMELINE_SEGMENT_CAP);
    // The LAST segments are kept — the earliest turn is not among them.
    expect(screen.queryByText("Turn 0")).not.toBeInTheDocument();
    expect(screen.getByText(`Turn ${total - 1}`)).toBeInTheDocument();

    const showEarlier = screen.getByRole("button", { name: new RegExp(`show ${extra} earlier segments?`, "i") });
    await userEvent.click(showEarlier);

    segments = await screen.findAllByTestId("usage-timeline-segment");
    expect(segments).toHaveLength(total);
    expect(screen.getByText("Turn 0")).toBeInTheDocument();
  });

  it("caps rendered events per segment at TIMELINE_EVENTS_PER_SEGMENT_CAP with a Show-more control", async () => {
    const extra = 1;
    const scriptCount = TIMELINE_EVENTS_PER_SEGMENT_CAP + extra;
    const events: UsageEvent[] = [event({ kind: "human_turn", invoker: "you", excerpt: "Go" })];
    for (let i = 0; i < scriptCount; i++) {
      events.push(event({ kind: "script", name: `script-${i}`, invoker: "script" }));
    }
    mockSession(payload({ events }));

    renderWithProviders(
      <UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />,
    );

    await screen.findByTestId("usage-timeline-segment");
    expect(screen.getByText("script-0")).toBeInTheDocument();
    const lastIndex = scriptCount - 1;
    expect(screen.queryByText(`script-${lastIndex}`)).not.toBeInTheDocument();

    const showMore = screen.getByRole("button", { name: new RegExp(`show ${extra} more event`, "i") });
    await userEvent.click(showMore);

    expect(await screen.findByText(`script-${lastIndex}`)).toBeInTheDocument();
  });

  it("renders a slash-command opener as /name args, never the raw command markup", async () => {
    mockSession(
      payload({
        events: [
          event({
            kind: "slash_command",
            name: "brainstorm",
            invoker: "you",
            excerpt:
              "<command-name>brainstorm</command-name><command-message>Brainstorm</command-message><command-args>the plan</command-args>",
          }),
        ],
      }),
    );
    renderWithProviders(<UsageSessionTimeline sessionId="cccccccc-4444-4444-8444-444444444444" />);
    expect(await screen.findByText("/brainstorm the plan")).toBeInTheDocument();
    expect(screen.queryByText(/<command-name>/)).toBeNull();
  });
});
