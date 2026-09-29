import { describe, expect, it } from "vitest";
import {
  ledgerSessionIdFor,
  segmentEvents,
  segmentMetrics,
  summaryLine,
  TIMELINE_EVENTS_PER_SEGMENT_CAP,
  TIMELINE_SEGMENT_CAP,
} from "@/screens/usage/usageTimelineModel";
import type { UsageEvent, UsageSessionPayload } from "@/features/usage/usageAnalyticsTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";

const ZERO_ACTIVITY = {
  read: 0,
  edit: 0,
  verify: 0,
  operate: 0,
  delegate: 0,
  skill: 0,
  external: 0,
} as const;

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    kind: "human_turn",
    at: "2026-09-05T09:00:00.000Z",
    token_delta: 0,
    tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    thinking_len: 0,
    output_text_len: 0,
    name: null,
    model: null,
    invoker: "you",
    activity: { ...ZERO_ACTIVITY },
    edited_without_verify: false,
    ...overrides,
  };
}

describe("segmentEvents", () => {
  it("a list opening with a slash_command opens its own segment", () => {
    const events = [
      event({ kind: "slash_command", invoker: "you", name: "brainstorm" }),
      event({ kind: "skill", invoker: "model", name: "brainstorm" }),
    ];
    const segments = segmentEvents(events);
    expect(segments).toHaveLength(1);
    expect(segments[0].opener).toBe(events[0]);
    expect(segments[0].events).toEqual([events[1]]);
  });

  it("a subagent event before any human turn opens a segment with a null opener", () => {
    const events = [
      event({ kind: "subagent", invoker: "model", name: "orch-planner" }),
      event({ kind: "human_turn", invoker: "you" }),
      event({ kind: "skill", invoker: "model", name: "brainstorm" }),
    ];
    const segments = segmentEvents(events);
    expect(segments).toHaveLength(2);
    expect(segments[0].opener).toBeNull();
    expect(segments[0].events).toEqual([events[0]]);
    expect(segments[1].opener).toBe(events[1]);
    expect(segments[1].events).toEqual([events[2]]);
  });

  it("groups strictly by array order — it does not sort by timestamp", () => {
    // The later event's `at` is EARLIER than the one before it. The ledger
    // sorts upstream; the renderer must not assume it always will, and must
    // not silently re-sort on its own either.
    const events = [
      event({ kind: "human_turn", at: "2026-09-05T09:05:00.000Z" }),
      event({ kind: "skill", name: "a", at: "2026-09-05T09:00:00.000Z" }),
      event({ kind: "human_turn", at: "2026-09-05T09:01:00.000Z" }),
      event({ kind: "skill", name: "b", at: "2026-09-05T09:06:00.000Z" }),
    ];
    const segments = segmentEvents(events);
    expect(segments).toHaveLength(2);
    expect(segments[0].opener).toBe(events[0]);
    expect(segments[0].events).toEqual([events[1]]);
    expect(segments[1].opener).toBe(events[2]);
    expect(segments[1].events).toEqual([events[3]]);
  });
});

describe("segmentMetrics", () => {
  it("derives cache_ratio and thinking_share from the segment's own events", () => {
    const opener = event({ kind: "human_turn" });
    const skillEvent = event({
      kind: "skill",
      name: "brainstorm",
      tokens: { input: 2, output: 80, cache_creation: 300, cache_read: 600 },
      thinking_len: 40,
      output_text_len: 80,
    });
    const metrics = segmentMetrics({ opener, events: [skillEvent] });
    expect(metrics.cache_ratio).toBeCloseTo(600 / (2 + 300 + 600));
    expect(metrics.thinking_share).toBeCloseTo(40 / 80);
  });

  it("both ratios are null — never 0 — when their denominator is 0", () => {
    const opener = event({ kind: "human_turn" });
    const scriptEvent = event({
      kind: "script",
      name: "unslop",
      tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
      thinking_len: 0,
      output_text_len: 0,
    });
    const metrics = segmentMetrics({ opener, events: [scriptEvent] });
    expect(metrics.cache_ratio).toBeNull();
    expect(metrics.thinking_share).toBeNull();
  });

  it("an empty segment (no events between two openers) is also null, never 0", () => {
    const metrics = segmentMetrics({ opener: event({ kind: "human_turn" }), events: [] });
    expect(metrics.cache_ratio).toBeNull();
    expect(metrics.thinking_share).toBeNull();
  });
});

describe("summaryLine", () => {
  it("returns an empty string when the payload carries no summary", () => {
    const payload: UsageSessionPayload = {
      ok: false,
      reason: "not_found",
      session_id: "x",
      window: null,
    };
    expect(summaryLine(payload)).toBe("");
  });

  it("names tokens, cache hit ratio, steering count, duration, sub-agent share and loadout state", () => {
    const payload: UsageSessionPayload = {
      ok: true,
      session_id: "cccccccc-4444-4444-8444-444444444444",
      harness: "claude-code",
      project: "kinds",
      window: null,
      last_scan_at: "2026-09-07T12:00:00.000Z",
      transcript_present: true,
      summary: {
        tokens_total: 1001,
        cache_hit_ratio: 0.66,
        steering_count: 1,
        duration_minutes: 2,
        activity: { ...ZERO_ACTIVITY },
        thinking_text_share: 0,
        subagent_token_share: 0,
        loadout_assumed: true,
        compactions: 2,
        parent_session_id: "11111111-2222-4333-8444-555555555555",
      },
      intent_excerpt: "Please help me ship this.",
      events: [],
      subagents: [],
    };
    const line = summaryLine(payload);
    expect(line).toContain("1,001");
    expect(line).toContain("66%");
    expect(line).toContain("1 steering turn");
    expect(line).toContain("2 minutes");
    expect(line).toContain("current loadout assumed");
    expect(line).toContain("part of 11111111");
    expect(line).toContain("2 compactions");
  });

  it("omits parent and compaction text when the optional fields are absent", () => {
    const payload: UsageSessionPayload = {
      ok: true,
      session_id: "x",
      window: null,
      summary: {
        tokens_total: 1,
        cache_hit_ratio: 0,
        steering_count: 0,
        duration_minutes: 0,
        activity: { ...ZERO_ACTIVITY },
        thinking_text_share: 0,
        subagent_token_share: 0,
        loadout_assumed: false,
      },
    };
    expect(summaryLine(payload)).not.toContain("part of");
    expect(summaryLine(payload)).not.toContain("compaction");
  });
});

describe("ledgerSessionIdFor", () => {
  function row(overrides: Partial<UsageSessionRow>): UsageSessionRow {
    return {
      id: "fallback",
      period: "fallback",
      harnessId: "claude-code",
      harnessName: "Claude Code",
      models: [],
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      estimatedCost: { usd: 0, label: "Estimated API-equivalent cost" },
      ...overrides,
    };
  }

  it("returns row.id when it is a full-string UUID", () => {
    const r = row({ id: "591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f", period: "not-a-uuid" });
    expect(ledgerSessionIdFor(r)).toBe("591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f");
  });

  it("falls back to row.period when it is a full-string UUID and id is not", () => {
    const r = row({ id: "claude:some-label:2", period: "1dae0a69-6f00-4109-ab1c-873861269996" });
    expect(ledgerSessionIdFor(r)).toBe("1dae0a69-6f00-4109-ab1c-873861269996");
  });

  it("returns null for a NORMALIZED codex row — its period is a display label, not a UUID", () => {
    // `normalizeUsage.ts:189` replaces a path-shaped period with a display
    // string ("<label> session") before it reaches the row; the raw
    // ccusage period (a rollout path embedding a UUID) never reaches here.
    const r = row({
      id: "codex:Local project session:3",
      period: "Local project session",
      harnessId: "codex",
      harnessName: "Codex",
    });
    expect(ledgerSessionIdFor(r)).toBeNull();
  });

  it("returns null for a fallback composite id with no UUID anywhere", () => {
    const r = row({ id: "agent:session-4:4", period: "session-4" });
    expect(ledgerSessionIdFor(r)).toBeNull();
  });
});

describe("render caps", () => {
  it("are the fixed values design D14.7 specifies", () => {
    expect(TIMELINE_SEGMENT_CAP).toBe(200);
    expect(TIMELINE_EVENTS_PER_SEGMENT_CAP).toBe(50);
  });
});
