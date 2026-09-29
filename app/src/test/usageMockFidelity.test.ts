import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@/mocks/tauriCore";

// The `?usageBig=1` scene multiplies the hand-written 14-day fixture so the
// Usage screen can be reviewed — and screenshotted — at the magnitudes a real
// corpus produces (tens of billions of tokens, thousands of dollars) without a
// second fixture to keep in sync. That only holds while the scaling is
// FAITHFUL: same field names as the real ccusage envelope, counts still whole
// numbers, nested per-model rows scaled with their parent, and the `totals`
// block still consistent with the sum of the daily rows. A scale that misses a
// field would put a KPI an order of magnitude away from the bars under it, and
// the frame would be reviewed as a layout bug that does not exist.

const FACTOR = 5_600;

interface AgentRow {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  cost?: number;
  modelBreakdowns?: AgentRow[];
  metadata?: Record<string, unknown>;
}
interface Scan {
  parsed: {
    daily: Array<{ period: string; totalTokens: number; totalCost: number; agents: AgentRow[] }>;
    session: AgentRow[];
    totals: { totalTokens: number; totalCost: number };
  };
}

function withSearch(search: string) {
  window.history.replaceState({}, "", search);
}

async function loadScan(search: string): Promise<Scan> {
  withSearch(search);
  return (await invoke<Scan>("usage_load_latest_ccusage")) as Scan;
}

describe("the usageBig scene's fixture scaling", () => {
  let base: Scan;
  let big: Scan;

  beforeEach(async () => {
    base = await loadScan("/");
    big = await loadScan("/?usageBig=1");
  });
  afterEach(() => withSearch("/"));

  it("scales every token count by the factor and keeps it a whole number", () => {
    const b = base.parsed.daily[0].agents[0];
    const s = big.parsed.daily[0].agents[0];
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "totalTokens",
    ] as const) {
      expect(s[key]).toBe(Math.round(b[key] * FACTOR));
      expect(Number.isInteger(s[key])).toBe(true);
    }
  });

  it("scales costs WITHOUT rounding them to an integer dollar", () => {
    const b = base.parsed.daily[0].agents[0];
    const s = big.parsed.daily[0].agents[0];
    expect(s.totalCost).toBeCloseTo(b.totalCost * FACTOR, 6);
    // A $6.00 → $33,600 hero is the point of the scene; rounding costs the
    // way counts are rounded would be harmless here but silently wrong for a
    // sub-dollar model row.
    expect(big.parsed.totals.totalCost).toBeCloseTo(base.parsed.totals.totalCost * FACTOR, 4);
  });

  it("reaches nested modelBreakdowns, not just the top-level agent row", () => {
    const findSplit = (scan: Scan) =>
      scan.parsed.session.find((s) => (s.modelBreakdowns?.length ?? 0) > 1);
    const b = findSplit(base);
    const s = findSplit(big);
    expect(b?.modelBreakdowns).toBeDefined();
    expect(s?.modelBreakdowns).toBeDefined();
    const bm = b!.modelBreakdowns![0];
    const sm = s!.modelBreakdowns![0];
    expect(sm.totalTokens).toBe(Math.round(bm.totalTokens * FACTOR));
    // `modelBreakdowns` rows carry `cost`, not `totalCost` — the one field
    // name a key-set-driven walk is easiest to miss.
    expect(sm.cost).toBeCloseTo(bm.cost! * FACTOR, 6);
  });

  it("scales the session metadata counters and leaves durations alone", () => {
    const b = base.parsed.session[0];
    const s = big.parsed.session[0];
    for (const key of ["toolCalls", "linesAdded", "linesRemoved"] as const) {
      expect(s.metadata![key]).toBe(Math.round((b.metadata![key] as number) * FACTOR));
    }
    // A duration is not a magnitude the scene is about; scaling it would put
    // a 5,000-hour session on the screen.
    expect(s.metadata!.durationMs).toBe(b.metadata!.durationMs);
    expect(s.metadata!.projectPath).toBe(b.metadata!.projectPath);
  });

  it("keeps totals within rounding drift of the sum of the daily rows", () => {
    const summed = big.parsed.daily.reduce(
      (sum, day) => sum + day.agents.reduce((a, agent) => a + agent.totalTokens, 0),
      0,
    );
    // Each row rounds independently, so the two can differ — but by at most
    // half a token per row, never by an order of magnitude.
    const rows = big.parsed.daily.reduce((n, day) => n + day.agents.length, 0);
    const drift = Math.abs(summed - big.parsed.totals.totalTokens);
    expect(drift).toBeLessThanOrEqual(rows);
    expect(big.parsed.totals.totalTokens).toBeGreaterThan(1e9); // the scene's whole point
  });

  it("leaves a non-scaled envelope field untouched", () => {
    expect((big as unknown as { scanned_at: number }).scanned_at).toBe(
      (base as unknown as { scanned_at: number }).scanned_at,
    );
  });
});

// ─── `hub usage history --json` fixture fidelity (wave 2b) ────────────────
// The default `usage-success` scene's numbers must not move now that the
// screen reads history instead of the scan: `usageHistoryPayload()` builds
// its default (non-backfilled) days off the SAME `visualUsageScan()` fixture
// `usage_load_latest_ccusage` returns, not a second hand-written one. This
// pins that the two never drift apart.

interface HistoryDayFixture {
  date: string;
  provenance: "scanned" | "frozen" | "backfilled";
  tokens: { total: number };
  costUsd: number;
}
interface HistoryPayloadFixture {
  days: HistoryDayFixture[];
  claude_stats: { available: boolean; importable_days: number };
}

async function loadHistory(search: string): Promise<HistoryPayloadFixture> {
  withSearch(search);
  const result = await invoke<{ success: boolean; output: string }>("hub_cmd", {
    args: ["usage", "history", "--json"],
  });
  return JSON.parse(result.output) as HistoryPayloadFixture;
}

describe("the usage history fixture's fidelity to the scan fixture", () => {
  afterEach(() => withSearch("/"));

  it("the default history preserves every scan day exactly, alongside its deterministic calendar", async () => {
    const scan = await loadScan("/");
    const history = await loadHistory("/");
    const scanTotalsByDate = new Map(scan.parsed.daily.map((d) => [d.period, d.totalTokens]));
    for (const scanDay of scan.parsed.daily) {
      const day = history.days.find((candidate) => candidate.date === scanDay.period);
      expect(day?.provenance).toBe("scanned");
      expect(day?.tokens.total).toBe(scanTotalsByDate.get(scanDay.period));
    }
    expect(history.days.length).toBeGreaterThan(scan.parsed.daily.length);
  });

  it("the default fixture offers a real import count; the backfilled scene reports it already imported", async () => {
    const defaultHistory = await loadHistory("/");
    expect(defaultHistory.claude_stats.available).toBe(true);
    expect(defaultHistory.claude_stats.importable_days).toBeGreaterThan(0);

    const backfilledHistory = await loadHistory("/?usageBackfilled=1");
    expect(backfilledHistory.claude_stats.importable_days).toBe(0);
    expect(backfilledHistory.days.some((d) => d.provenance === "backfilled")).toBe(true);
    expect(backfilledHistory.days.some((d) => d.provenance === "frozen")).toBe(true);
    expect(backfilledHistory.days.some((d) => d.provenance === "scanned")).toBe(true);
  });

  // W5: `?usageBig=1` used to leave the history fixture untouched while
  // `usage_load_latest_ccusage` scaled 5,600× — the screen prefers history
  // whenever it holds anything, so `usage-success-big` showed a KPI band
  // reading ~$700 beside a sessions list in the billions.
  it("usageBig scales the history payload by the same factor as the scaled scan", async () => {
    const history = await loadHistory("/?usageBig=1");
    const baseline = await loadHistory("/");
    const baselineTotalsByDate = new Map(baseline.days.map((d) => [d.date, d.tokens.total]));
    expect(history.days.length).toBeGreaterThan(0);
    for (const day of history.days) {
      expect(day.tokens.total).toBe((baselineTotalsByDate.get(day.date) ?? 0) * 5_600);
    }
    expect(history.days.reduce((sum, d) => sum + d.costUsd, 0)).toBeGreaterThan(1000);
    // Day counts (not magnitudes) must NOT be scaled.
    expect(history.days.length).toBe((await loadHistory("/")).days.length);
  });

  it("usageEmpty/usageNoUsage return an empty-days history payload with distinct import counts", async () => {
    const empty = await loadHistory("/?usageEmpty=1");
    expect(empty.days).toHaveLength(0);
    expect(empty.claude_stats.importable_days).toBe(64);

    const noUsage = await loadHistory("/?usageNoUsage=1");
    expect(noUsage.days).toHaveLength(0);
    expect(noUsage.claude_stats.importable_days).toBe(0);
  });
});

// ─── `?pruned=1` fidelity (usage-pruned-transcript.journey.spec.ts) ────────
// usage-pruned-transcript.journey.spec.ts opens
// `/?pruned=1#/usage/session/cccccccc-…` and asserts the pruned banner and
// the summary testids that `UsageSessionTimeline.tsx` renders off
// `transcript_present`. `app/src/mocks/tauriUsageAnalytics.ts`'s
// `usageSessionMock` is the command this route actually calls
// (`hub usage session <id> --json`) and reads `sceneFlag("pruned")` —
// matching the journey's own flag. (A separate, similarly-named
// `usagePruned` flag exists in `app/src/mocks/usageInspection.ts` for the
// captured-inspection retention demo on a DIFFERENT session; that one is
// not in play for this journey's un-captured `cccccccc…` id, which falls
// back to the legacy `UsageSessionTimeline`, so there is no dead-flag
// finding here.)

interface SessionEventFixture {
  excerpt?: string;
}
interface SessionPayloadFixture {
  session_id: string;
  transcript_present?: boolean;
  intent_excerpt?: string;
  events?: SessionEventFixture[];
}

async function loadSession(search: string, id: string): Promise<SessionPayloadFixture> {
  withSearch(search);
  const result = await invoke<{ success: boolean; output: string }>("hub_cmd", {
    args: ["usage", "session", id, "--harness", "claude-code", "--json"],
  });
  return JSON.parse(result.output) as SessionPayloadFixture;
}

describe("the pruned scene's session-payload fidelity", () => {
  const SESSION_ID = "cccccccc-4444-4444-8444-444444444444";
  afterEach(() => withSearch("/"));

  it("marks transcript_present false and blanks every excerpt only when ?pruned=1 is set", async () => {
    const base = await loadSession("/", SESSION_ID);
    expect(base.transcript_present).toBe(true);
    expect(base.events?.some((e) => (e.excerpt ?? "") !== "")).toBe(true);

    const pruned = await loadSession("/?pruned=1", SESSION_ID);
    expect(pruned.transcript_present).toBe(false);
    expect(pruned.intent_excerpt).toBe("");
    expect(pruned.events?.length).toBeGreaterThan(0);
    expect(pruned.events?.every((e) => (e.excerpt ?? "") === "")).toBe(true);
  });
});
