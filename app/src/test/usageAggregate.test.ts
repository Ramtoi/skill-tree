import { describe, expect, it, vi } from "vitest";
import type { UsageDailyPoint, UsageSessionRow } from "@/features/usage/usageTypes";
import {
  cacheHitRateOf,
  filterDailyByHarness,
  filterDailyByRange,
  filterSessionsByHarness,
  filterSessionsByRange,
  foldTopModels,
  isWithinRange,
  parseUsageDate,
  rangeScopedDaily,
  rangeBounds,
  windowBounds,
  recomputeScopedUsage,
  scopeFromDaily,
  sessionTimeMs,
  zeroTokens,
  type ModelTotal,
} from "@/screens/usage/usageAggregate";
import { buildStackedColumns } from "@/screens/usage/usageChartColumns";
import {
  HARNESS_FIXED_ORDER,
  harnessColorIndex,
  orderHarnessIds,
} from "@/screens/usage/harnessIdentity";

function tokens(overrides: Partial<{ input: number; output: number; cacheCreation: number; cacheRead: number; total: number }> = {}) {
  const base = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, ...overrides };
  if (overrides.total === undefined) {
    base.total = base.input + base.output + base.cacheCreation + base.cacheRead;
  }
  return base;
}

function session(overrides: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return {
    id: overrides.id ?? "session-1",
    period: overrides.period ?? "2026-07-14T10:00:00Z",
    harnessId: overrides.harnessId ?? "claude",
    harnessName: overrides.harnessName ?? "Claude Code",
    models: overrides.models ?? ["claude-sonnet-5"],
    modelBreakdown: overrides.modelBreakdown ?? [],
    tokens: overrides.tokens ?? tokens({ input: 100, output: 20, total: 120 }),
    estimatedCost: overrides.estimatedCost ?? { usd: 1, label: "Estimated API-equivalent cost" },
    ...overrides,
  };
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

describe("parseUsageDate", () => {
  it("accepts a ccusage date and a full ISO timestamp", () => {
    expect(parseUsageDate("2026-07-14")).toBe(new Date("2026-07-14").getTime());
    expect(parseUsageDate("2026-07-14T20:00:00Z")).toBe(new Date("2026-07-14T20:00:00Z").getTime());
  });

  it("refuses an id-shaped period that V8 would happily invent a date from", () => {
    // Regression: `new Date("claude-session-3")` is 1 March 2001 and
    // `new Date("sess-12")` is December 2001 — V8's legacy fallback parser.
    // Both used to read as real, very old dates, so every id-shaped session
    // fell out of the 7-day and 30-day ranges and its spend vanished from
    // the KPIs.
    expect(new Date("claude-session-3").getTime()).not.toBeNaN(); // the trap
    expect(parseUsageDate("claude-session-3")).toBeUndefined();
    expect(parseUsageDate("codex-session-0")).toBeUndefined();
    expect(parseUsageDate("sess-12")).toBeUndefined();
    expect(parseUsageDate("2026/02/19/rollout-abc")).toBeUndefined();
    expect(parseUsageDate(undefined)).toBeUndefined();
    expect(parseUsageDate("")).toBeUndefined();
  });
});

describe("isWithinRange", () => {
  it("R1 uses one inclusive UTC calendar rule for daily rows and sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T22:30:00Z"));
    try {
      const daily = [
        { date: "2026-09-03", harnesses: [], tokens: zeroTokens(), estimatedCost: { usd: 0, label: "x" as never } },
        { date: "2026-09-02", harnesses: [], tokens: zeroTokens(), estimatedCost: { usd: 0, label: "x" as never } },
        { date: "2026-09-10", harnesses: [], tokens: zeroTokens(), estimatedCost: { usd: 0, label: "x" as never } },
      ];
      const sessions = daily.map((point, index) => session({ id: String(index), period: point.date }));
      expect(isWithinRange("2026-09-03", "7d")).toBe(true);
      expect(isWithinRange("2026-09-02", "7d")).toBe(false);
      expect(isWithinRange("2026-09-10", "7d")).toBe(false);
      expect(filterDailyByRange(daily, "7d").map((point) => point.date)).toEqual(["2026-09-03"]);
      expect(filterSessionsByRange(sessions, "7d").map((row) => row.id)).toEqual(["0"]);
      expect(rangeBounds("7d").since).toBe("2026-09-03");
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports the 90-day and one-year windows", () => {
    expect(isWithinRange(isoDaysAgo(89), "90d")).toBe(true);
    expect(isWithinRange(isoDaysAgo(91), "90d")).toBe(false);
    expect(isWithinRange(isoDaysAgo(364), "1y")).toBe(true);
    expect(isWithinRange(isoDaysAgo(366), "1y")).toBe(false);
  });
  it("keeps an id-shaped period in a narrowed range instead of dating it to 2001", () => {
    expect(isWithinRange("claude-session-3", "7d")).toBe(true);
    expect(isWithinRange("sess-12", "30d")).toBe(true);
  });

  it("always passes for 'all'", () => {
    expect(isWithinRange(isoDaysAgo(400), "all")).toBe(true);
    expect(isWithinRange(undefined, "all")).toBe(true);
  });

  it("passes a missing or unparseable date through (never drops it)", () => {
    expect(isWithinRange(undefined, "7d")).toBe(true);
    expect(isWithinRange("not-a-date", "30d")).toBe(true);
  });

  it("narrows to the last N days for 7d/30d", () => {
    expect(isWithinRange(isoDaysAgo(2), "7d")).toBe(true);
    expect(isWithinRange(isoDaysAgo(10), "7d")).toBe(false);
    expect(isWithinRange(isoDaysAgo(20), "30d")).toBe(true);
    expect(isWithinRange(isoDaysAgo(40), "30d")).toBe(false);
  });
});

describe("windowBounds", () => {
  it("uses inclusive UTC calendar boundaries from a non-midnight now", () => {
    const now = new Date("2026-09-09T22:30:00Z");
    expect(windowBounds(7, now)).toEqual({ since: "2026-09-03", until: "2026-09-09" });
    expect(windowBounds(30, now)).toEqual({ since: "2026-08-11", until: "2026-09-09" });
    expect(windowBounds(90, now)).toEqual({ since: "2026-06-12", until: "2026-09-09" });
  });
});

describe("filterDailyByRange / filterSessionsByRange", () => {
  const daily: UsageDailyPoint[] = [
    { date: isoDaysAgo(1).slice(0, 10), harnesses: [], tokens: zeroTokens(), estimatedCost: { usd: 0, label: "x" as never } },
    { date: isoDaysAgo(40).slice(0, 10), harnesses: [], tokens: zeroTokens(), estimatedCost: { usd: 0, label: "x" as never } },
  ];

  it("filters daily rows by date", () => {
    expect(filterDailyByRange(daily, "all")).toHaveLength(2);
    expect(filterDailyByRange(daily, "30d")).toHaveLength(1);
  });

  it("filters sessions by lastActivity, falling back to startedAt then period", () => {
    const sessions = [
      session({ id: "a", startedAt: isoDaysAgo(1) }),
      session({ id: "b", startedAt: isoDaysAgo(40) }),
      session({ id: "c", lastActivity: isoDaysAgo(2) }),
      session({ id: "d", period: isoDaysAgo(50) }),
    ];
    const within7d = filterSessionsByRange(sessions, "7d").map((s) => s.id);
    expect(within7d).toEqual(["a", "c"]);
  });

  it("dates a long-running session by its last activity, not its start", () => {
    // The row itself prints "1 day ago" (lastActivity) and "Most recent"
    // sorts by it, so a session started 40 days ago but touched yesterday
    // must stay inside the 7-day range rather than vanishing from a screen
    // that says it is a day old.
    const stillActive = session({ id: "long", startedAt: isoDaysAgo(40), lastActivity: isoDaysAgo(1) });
    const abandoned = session({ id: "old", startedAt: isoDaysAgo(1), lastActivity: isoDaysAgo(40) });
    expect(filterSessionsByRange([stillActive, abandoned], "7d").map((s) => s.id)).toEqual(["long"]);
  });

  it("keeps a session with no usable date at all in every range", () => {
    // Documented trade-off (PLAN §5): an undated session is never silently
    // dropped from the totals — losing spend is worse than showing spend the
    // chart cannot bucket. The chart drops the same row (nothing to bucket),
    // so the column sum can read lower than the KPI.
    // "claude-session-3" is the shape `makeSessions` produces and the one
    // V8 mis-parses as 2001 — the exact row this used to drop.
    const undated = session({ id: "u", period: "claude-session-3" });
    expect(filterSessionsByRange([undated], "7d").map((s) => s.id)).toEqual(["u"]);
    expect(filterSessionsByRange([undated], "30d").map((s) => s.id)).toEqual(["u"]);
    expect(filterSessionsByRange([undated], "all").map((s) => s.id)).toEqual(["u"]);
  });
});

describe("filterSessionsByHarness / filterDailyByHarness", () => {
  it("filterSessionsByHarness passes everything through for null and narrows to one harness otherwise", () => {
    const sessions = [
      session({ id: "a", harnessId: "claude" }),
      session({ id: "b", harnessId: "codex" }),
      session({ id: "c", harnessId: "claude" }),
    ];
    expect(filterSessionsByHarness(sessions, null).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(filterSessionsByHarness(sessions, "claude").map((s) => s.id)).toEqual(["a", "c"]);
    expect(filterSessionsByHarness(sessions, "codex").map((s) => s.id)).toEqual(["b"]);
    expect(filterSessionsByHarness(sessions, "pi")).toEqual([]);
  });

  function dailyPoint(date: string, harnesses: UsageDailyPoint["harnesses"]): UsageDailyPoint {
    const tokens = harnesses.reduce((acc, h) => ({ ...acc, total: acc.total + h.tokens.total }), zeroTokens());
    const costUsd = harnesses.reduce((sum, h) => sum + h.estimatedCost.usd, 0);
    return { date, harnesses, tokens, estimatedCost: { usd: costUsd, label: "x" as never } };
  }

  it("filterDailyByHarness passes every point through unchanged for null", () => {
    const daily = [dailyPoint("2026-07-01", [{ id: "claude", name: "Claude Code", tokens: tokens({ total: 10 }), estimatedCost: { usd: 1, label: "x" as never } }])];
    expect(filterDailyByHarness(daily, null)).toEqual(daily);
  });

  it("filterDailyByHarness recomputes each point's tokens/cost from only the picked harness's entry", () => {
    const daily = [
      dailyPoint("2026-07-01", [
        { id: "claude", name: "Claude Code", tokens: tokens({ input: 10, total: 10 }), estimatedCost: { usd: 1, label: "x" as never } },
        { id: "codex", name: "Codex", tokens: tokens({ input: 5, total: 5 }), estimatedCost: { usd: 0.5, label: "x" as never } },
      ]),
    ];
    const filtered = filterDailyByHarness(daily, "claude");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].harnesses.map((h) => h.id)).toEqual(["claude"]);
    expect(filtered[0].tokens.total).toBe(10);
    expect(filtered[0].estimatedCost.usd).toBe(1);
  });

  it("filterDailyByHarness keeps a day with no matching-harness activity as a zero point, not dropped", () => {
    const daily = [
      dailyPoint("2026-07-01", [
        { id: "claude", name: "Claude Code", tokens: tokens({ input: 10, total: 10 }), estimatedCost: { usd: 1, label: "x" as never } },
      ]),
      dailyPoint("2026-07-02", [
        { id: "claude", name: "Claude Code", tokens: tokens({ input: 20, total: 20 }), estimatedCost: { usd: 2, label: "x" as never } },
      ]),
    ];
    const filtered = filterDailyByHarness(daily, "codex");
    expect(filtered).toHaveLength(2);
    for (const point of filtered) {
      expect(point.harnesses).toEqual([]);
      expect(point.tokens.total).toBe(0);
      expect(point.estimatedCost.usd).toBe(0);
    }
  });
});

describe("sessionTimeMs", () => {
  it("reads the last-activity-first ladder", () => {
    const at = isoDaysAgo(1);
    expect(sessionTimeMs(session({ lastActivity: at, startedAt: isoDaysAgo(40) }))).toBe(
      new Date(at).getTime(),
    );
    expect(sessionTimeMs(session({ startedAt: at, period: "x" }))).toBe(new Date(at).getTime());
  });

  it("is -Infinity — never NaN — for an undated or unparseable session", () => {
    // `-Infinity - -Infinity` is NaN, and a NaN comparator result is
    // spec-coerced to 0, so two undated sessions would order by engine
    // detail. Callers compare, never subtract.
    const undated = sessionTimeMs(session({ period: "claude-session-3" }));
    expect(undated).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(undated)).toBe(false);
  });
});

describe("harnessColorIndex", () => {
  it("gives each named harness its own fixed identity slot", () => {
    expect(HARNESS_FIXED_ORDER.map(harnessColorIndex)).toEqual([0, 1, 2, 3]);
  });

  it("keeps a harness's hue when another harness leaves the scope", () => {
    // The bug this replaces: the caller passed the ARRAY INDEX, so narrowing
    // the range until Claude had no usage promoted Codex to slot 0 and
    // re-hued the whole chart for reasons the data never justified.
    const both = orderHarnessIds(["codex", "claude"]);
    const codexOnly = orderHarnessIds(["codex"]);
    expect(both.indexOf("codex")).toBe(1);
    expect(codexOnly.indexOf("codex")).toBe(0);
    expect(harnessColorIndex("codex")).toBe(harnessColorIndex("codex"));
    expect(harnessColorIndex("codex")).toBe(1);
  });

  it("hashes an unmapped ccusage agent into the open slots, deterministically", () => {
    for (const id of ["gemini", "copilot", "qwen", "goose", "kimi"]) {
      const index = harnessColorIndex(id);
      expect(index).toBeGreaterThanOrEqual(HARNESS_FIXED_ORDER.length);
      expect(index).toBeLessThanOrEqual(7);
      expect(harnessColorIndex(id)).toBe(index);
    }
  });

  it("never returns an index outside the identity ramp", () => {
    for (const id of ["", "a", "an-extremely-long-agent-identifier-nobody-would-type"]) {
      const index = harnessColorIndex(id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(7);
    }
  });
});

describe("cacheHitRateOf", () => {
  it("is 0 when the denominator is 0", () => {
    expect(cacheHitRateOf(zeroTokens())).toBe(0);
  });

  it("divides cacheRead by input+cacheRead+cacheCreation", () => {
    const t = tokens({ input: 60, cacheRead: 30, cacheCreation: 10, output: 5 });
    expect(cacheHitRateOf(t)).toBeCloseTo(30 / 100, 5);
  });
});

describe("recomputeScopedUsage", () => {
  it("sums tokens/cost/toolCalls across sessions", () => {
    const sessions = [
      session({ id: "a", tokens: tokens({ input: 100, output: 20, total: 120 }), estimatedCost: { usd: 1, label: "x" as never }, toolCalls: 5 }),
      session({ id: "b", tokens: tokens({ input: 50, output: 10, total: 60 }), estimatedCost: { usd: 0.5, label: "x" as never }, toolCalls: 3 }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    expect(scoped.tokens.total).toBe(180);
    expect(scoped.costUsd).toBeCloseTo(1.5, 5);
    expect(scoped.toolCalls).toBe(8);
    expect(scoped.sessions).toBe(2);
  });

  it("buckets per-harness totals and picks the most-frequent model as topModel", () => {
    const sessions = [
      session({ id: "a", harnessId: "claude", harnessName: "Claude Code", models: ["claude-sonnet-5"] }),
      session({ id: "b", harnessId: "claude", harnessName: "Claude Code", models: ["claude-sonnet-5"] }),
      session({ id: "c", harnessId: "claude", harnessName: "Claude Code", models: ["claude-opus-5"] }),
      session({ id: "d", harnessId: "codex", harnessName: "Codex", models: ["gpt-5.5"] }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    const claude = scoped.harnesses.find((h) => h.id === "claude")!;
    const codex = scoped.harnesses.find((h) => h.id === "codex")!;
    expect(claude.sessions).toBe(3);
    expect(claude.topModel).toBe("claude-sonnet-5");
    expect(codex.sessions).toBe(1);
    expect(codex.topModel).toBe("gpt-5.5");
  });

  it("splits a multi-model session's tokens/cost evenly across its models", () => {
    const sessions = [
      session({
        id: "a",
        models: ["model-a", "model-b"],
        tokens: tokens({ input: 100, total: 100 }),
        estimatedCost: { usd: 2, label: "x" as never },
      }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    const a = scoped.models.find((m) => m.modelName === "model-a")!;
    const b = scoped.models.find((m) => m.modelName === "model-b")!;
    expect(a.tokens.total).toBeCloseTo(50, 5);
    expect(b.tokens.total).toBeCloseTo(50, 5);
    expect(a.costUsd).toBeCloseTo(1, 5);
    expect(b.costUsd).toBeCloseTo(1, 5);
  });

  it("uses a session's real per-model breakdown when ccusage reported one, instead of splitting evenly", () => {
    const sessions = [
      session({
        id: "a",
        models: ["model-a", "model-b"],
        tokens: tokens({ input: 100, total: 100 }),
        estimatedCost: { usd: 2, label: "x" as never },
        modelBreakdown: [
          {
            modelName: "model-a",
            tokens: tokens({ input: 90, total: 90 }),
            estimatedCost: { usd: 1.8, label: "x" as never },
          },
          {
            modelName: "model-b",
            tokens: tokens({ input: 10, total: 10 }),
            estimatedCost: { usd: 0.2, label: "x" as never },
          },
        ],
      }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    const a = scoped.models.find((m) => m.modelName === "model-a")!;
    const b = scoped.models.find((m) => m.modelName === "model-b")!;
    // Exact, from the real breakdown — NOT the 50/50 even split the
    // aggregate tokens/cost would otherwise produce.
    expect(a.tokens.total).toBe(90);
    expect(b.tokens.total).toBe(10);
    expect(a.costUsd).toBeCloseTo(1.8, 5);
    expect(b.costUsd).toBeCloseTo(0.2, 5);
  });

  it("sums real per-model breakdowns across multiple sessions", () => {
    const sessions = [
      session({
        id: "a",
        models: ["model-a"],
        modelBreakdown: [
          { modelName: "model-a", tokens: tokens({ input: 10, total: 10 }), estimatedCost: { usd: 1, label: "x" as never } },
        ],
      }),
      session({
        id: "b",
        models: ["model-a"],
        modelBreakdown: [
          { modelName: "model-a", tokens: tokens({ input: 5, total: 5 }), estimatedCost: { usd: 0.5, label: "x" as never } },
        ],
      }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    const a = scoped.models.find((m) => m.modelName === "model-a")!;
    expect(a.tokens.total).toBe(15);
    expect(a.costUsd).toBeCloseTo(1.5, 5);
  });

  it("groups projects by the session's project label, folding untagged sessions into 'No project'", () => {
    const sessions = [
      session({ id: "a", project: { label: "skill-tree", anonymized: true } }),
      session({ id: "b", project: { label: "skill-tree", anonymized: true } }),
      session({ id: "c" }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    const skillTree = scoped.projects.find((p) => p.label === "skill-tree")!;
    const noProject = scoped.projects.find((p) => p.label === "No project")!;
    expect(skillTree.sessions).toBe(2);
    expect(noProject.sessions).toBe(1);
  });

  it("groups by the session's hub project key, collapsing two DIFFERENT display labels into one total (design D14.8, G3)", () => {
    // `label` is an anonymized DISPLAY name — two sessions of the SAME real
    // project can carry different labels (a re-anonymized run, a renamed
    // project) while sharing the same `hubProject` key. Grouping on `label`
    // would have split these into two totals; grouping on `hubProject` must
    // not.
    const sessions = [
      session({ id: "a", project: { label: "skill-tree", anonymized: true }, hubProject: "skill-tree" }),
      session({ id: "b", project: { label: "renamed-skill-tree", anonymized: true }, hubProject: "skill-tree" }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    expect(scoped.projects).toHaveLength(1);
    expect(scoped.projects[0].sessions).toBe(2);
    expect(scoped.projects[0].hubProject).toBe("skill-tree");
  });

  it("falls back to the display label when a session carries no hubProject, and never sets hubProject on that total", () => {
    const sessions = [session({ id: "a", project: { label: "skill-tree", anonymized: true } })];
    const scoped = recomputeScopedUsage(sessions);
    const total = scoped.projects.find((p) => p.label === "skill-tree")!;
    expect(total.sessions).toBe(1);
    expect(total.hubProject).toBeUndefined();
  });

  it("keeps two sessions with the SAME label but no hubProject, and two with DIFFERENT hubProjects, as separate totals", () => {
    const sessions = [
      session({ id: "a", project: { label: "moon-base", anonymized: true }, hubProject: "moon-base" }),
      session({ id: "b", project: { label: "moon-base", anonymized: true }, hubProject: "skill-tree" }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    expect(scoped.projects).toHaveLength(2);
    const keys = scoped.projects.map((p) => p.hubProject).sort();
    expect(keys).toEqual(["moon-base", "skill-tree"]);
  });

  it("sorts models and projects by cost descending", () => {
    const sessions = [
      session({ id: "a", models: ["cheap"], estimatedCost: { usd: 0.1, label: "x" as never } }),
      session({ id: "b", models: ["expensive"], estimatedCost: { usd: 9, label: "x" as never } }),
    ];
    const scoped = recomputeScopedUsage(sessions);
    expect(scoped.models[0].modelName).toBe("expensive");
    expect(scoped.models[1].modelName).toBe("cheap");
  });

  it("returns zeroed aggregates for an empty session list", () => {
    const scoped = recomputeScopedUsage([]);
    expect(scoped.tokens.total).toBe(0);
    expect(scoped.sessions).toBe(0);
    expect(scoped.harnesses).toHaveLength(0);
    expect(scoped.cacheHitRate).toBe(0);
  });
});

describe("foldTopModels", () => {
  function model(name: string, costUsd: number): ModelTotal {
    return { modelName: name, tokens: tokens({ total: costUsd * 100 }), costUsd };
  }

  it("returns the list unchanged when at or under the limit", () => {
    const models = [model("a", 3), model("b", 1)];
    expect(foldTopModels(models, 6)).toEqual(models);
  });

  it("keeps the top N by cost and folds the rest into one 'Other (N)' row", () => {
    const models = [model("a", 10), model("b", 8), model("c", 6), model("d", 4), model("e", 2)];
    const folded = foldTopModels(models, 3);
    expect(folded.map((m) => m.modelName)).toEqual(["a", "b", "c", "Other (2)"]);
    const other = folded[3];
    expect(other.costUsd).toBeCloseTo(6, 5); // 4 + 2
    expect(other.tokens.total).toBeCloseTo(600, 5); // 400 + 200
  });
});

// ─── scopeFromDaily / rangeScopedDaily ─────────────────────────────────────

type HistoryHarnessFixture = {
  id: string;
  name: string;
  total: number;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUsd?: number;
  costKnown?: boolean;
  splitKnown?: boolean;
  models?: Array<{ modelName: string; total: number; costUsd: number }>;
};

/** A `UsageDailyPoint` shaped the way `normalizeUsageHistory` produces one —
 *  day-level `tokens.total`/`costUsd` derived from the harness fixtures so
 *  the "day total = sum of harness totals" invariant every real payload
 *  keeps always holds here too. */
function historyPoint(
  date: string,
  provenance: "scanned" | "frozen" | "backfilled",
  harnessFixtures: HistoryHarnessFixture[],
  dayOverrides: { costKnown?: boolean; splitKnown?: boolean } = {},
): UsageDailyPoint {
  const harnesses = harnessFixtures.map((h) => {
    const costKnown = h.costKnown ?? true;
    const splitKnown = h.splitKnown ?? true;
    const costUsd = h.costUsd ?? 0;
    return {
      id: h.id,
      name: h.name,
      tokens: {
        input: h.input ?? 0,
        output: h.output ?? 0,
        cacheCreation: h.cacheCreation ?? 0,
        cacheRead: h.cacheRead ?? 0,
        total: h.total,
      },
      estimatedCost: { usd: costUsd, label: "Estimated API-equivalent cost" as const },
      costKnown,
      splitKnown,
      models: (h.models ?? []).map((m) => ({
        modelName: m.modelName,
        tokens: tokens({ total: m.total }),
        estimatedCost: { usd: m.costUsd, label: "Estimated API-equivalent cost" as const },
      })),
    };
  });
  const dayCostKnown = dayOverrides.costKnown ?? harnesses.every((h) => h.costKnown);
  const daySplitKnown = dayOverrides.splitKnown ?? harnesses.every((h) => h.splitKnown);
  return {
    date,
    provenance,
    costKnown: dayCostKnown,
    splitKnown: daySplitKnown,
    harnesses,
    tokens: {
      input: harnesses.reduce((sum, h) => sum + h.tokens.input, 0),
      output: harnesses.reduce((sum, h) => sum + h.tokens.output, 0),
      cacheCreation: harnesses.reduce((sum, h) => sum + h.tokens.cacheCreation, 0),
      cacheRead: harnesses.reduce((sum, h) => sum + h.tokens.cacheRead, 0),
      total: harnesses.reduce((sum, h) => sum + h.tokens.total, 0),
    },
    estimatedCost: { usd: harnesses.reduce((sum, h) => sum + h.estimatedCost.usd, 0), label: "x" as never },
  };
}

describe("scopeFromDaily / rangeScopedDaily parity", () => {
  function mixedFixture(): UsageDailyPoint[] {
    return [
      // Backfilled — claude only, no cost, no split.
      historyPoint("2026-05-20", "backfilled", [
        { id: "claude", name: "Claude Code", total: 1_000, costUsd: 0, costKnown: false, splitKnown: false },
      ]),
      // Frozen — two harnesses, fully known.
      historyPoint("2026-06-15", "frozen", [
        {
          id: "claude",
          name: "Claude Code",
          total: 2_000,
          input: 1_000,
          output: 600,
          cacheCreation: 100,
          cacheRead: 300,
          costUsd: 5,
        },
        { id: "codex", name: "Codex", total: 500, input: 300, output: 200, costUsd: 1 },
      ]),
      // Scanned — two harnesses, fully known.
      historyPoint("2026-07-01", "scanned", [
        {
          id: "claude",
          name: "Claude Code",
          total: 3_000,
          input: 1_800,
          output: 900,
          cacheCreation: 100,
          cacheRead: 200,
          costUsd: 8,
        },
        { id: "codex", name: "Codex", total: 800, input: 500, output: 300, costUsd: 2 },
      ]),
      // Mixed-provenance — a backfilled claude agent (no cost, no split)
      // beside a cost-known, split-known codex agent on the SAME day. Day-
      // grain `costKnown`/`splitKnown` are false here (not every agent is
      // known — `historyPoint`'s own default), which is exactly the shape
      // review C1/W2 found: gating on the day-grain flags drops codex's real
      // $5 alongside claude's unknown one. `scopeFromDaily` must derive both
      // the KPI total and the coverage counts from the surviving AGENTS, not
      // this day flag — including after a harness filter narrows the day to
      // just codex.
      historyPoint("2026-08-10", "scanned", [
        { id: "claude", name: "Claude Code", total: 400, costUsd: 0, costKnown: false, splitKnown: false },
        { id: "codex", name: "Codex", total: 600, input: 400, output: 200, costUsd: 5 },
      ]),
    ];
  }

  function sumColumnValues(columns: ReturnType<typeof buildStackedColumns>["columns"]): number {
    return columns.reduce(
      (sum, col) => sum + Object.values(col.values).reduce((s, v) => s + v, 0),
      0,
    );
  }

  it("tokens.total and costUsd agree with buildStackedColumns' own sum, all-harness", () => {
    const points = rangeScopedDaily(mixedFixture(), [], "all", null);
    const scope = scopeFromDaily(points);
    const tokenColumns = buildStackedColumns(points, "tokens", "day").columns;
    const costColumns = buildStackedColumns(points, "cost", "day").columns;
    expect(scope.tokens.total).toBeCloseTo(sumColumnValues(tokenColumns), 6);
    expect(scope.costUsd).toBeCloseTo(sumColumnValues(costColumns), 6);
  });

  it("tokens.total and costUsd agree with buildStackedColumns' own sum, harness-filtered", () => {
    const points = rangeScopedDaily(mixedFixture(), [], "all", "claude");
    const scope = scopeFromDaily(points);
    const tokenColumns = buildStackedColumns(points, "tokens", "day").columns;
    const costColumns = buildStackedColumns(points, "cost", "day").columns;
    expect(scope.tokens.total).toBeCloseTo(sumColumnValues(tokenColumns), 6);
    expect(scope.costUsd).toBeCloseTo(sumColumnValues(costColumns), 6);
    // Sanity: the filter actually narrowed something (codex is gone).
    expect(scope.harnesses.map((h) => h.id)).toEqual(["claude"]);
  });

  it("tokens.total and costUsd agree with buildStackedColumns' own sum, filtered to the cost-known agent on a mixed-provenance day (C1/W2 regression)", () => {
    const points = rangeScopedDaily(mixedFixture(), [], "all", "codex");
    const scope = scopeFromDaily(points);
    const tokenColumns = buildStackedColumns(points, "tokens", "day").columns;
    const costColumns = buildStackedColumns(points, "cost", "day").columns;
    expect(scope.tokens.total).toBeCloseTo(sumColumnValues(tokenColumns), 6);
    expect(scope.costUsd).toBeCloseTo(sumColumnValues(costColumns), 6);
    // The regression: codex's real $5 on the mixed day must survive, not
    // read as $0 because claude (dropped by the filter) was backfilled.
    expect(scope.costUsd).toBeGreaterThan(0);
  });

  it("coverage counts are agent-scoped: filtering to the cost-known agent on a mixed day reports nothing unknown", () => {
    const points = rangeScopedDaily(mixedFixture(), [], "all", "codex");
    const scope = scopeFromDaily(points);
    expect(scope.coverage.costUnknownDays).toBe(0);
    expect(scope.coverage.splitUnknownDays).toBe(0);
  });

  it("falls back to the scan's daily points when the ledger is empty", () => {
    const scanDaily = [historyPoint("2026-08-01", "scanned", [{ id: "claude", name: "Claude Code", total: 42 }])];
    const points = rangeScopedDaily([], scanDaily, "all", null);
    expect(points).toEqual(scanDaily);
  });
});

describe("scopeFromDaily coverage", () => {
  it("excludes cost-unknown days from costUsd and counts them in costUnknownDays", () => {
    const points = [
      historyPoint("2026-05-01", "backfilled", [
        { id: "claude", name: "Claude Code", total: 100, costUsd: 0, costKnown: false, splitKnown: false },
      ]),
      historyPoint("2026-07-01", "scanned", [
        { id: "claude", name: "Claude Code", total: 200, input: 200, costUsd: 4 },
      ]),
    ];
    const scope = scopeFromDaily(points);
    expect(scope.costUsd).toBe(4);
    expect(scope.coverage.costUnknownDays).toBe(1);
    expect(scope.coverage.days).toBe(2);
  });

  it("excludes split-unknown days from the token split while tokens.total stays exact", () => {
    const points = [
      historyPoint("2026-05-01", "backfilled", [
        { id: "claude", name: "Claude Code", total: 100, costUsd: 0, costKnown: false, splitKnown: false },
      ]),
      historyPoint("2026-07-01", "scanned", [
        { id: "claude", name: "Claude Code", total: 200, input: 150, output: 50, costUsd: 4 },
      ]),
    ];
    const scope = scopeFromDaily(points);
    // The exact total includes BOTH days' totals — the backfilled day's total
    // is real, never zero-filled.
    expect(scope.tokens.total).toBe(300);
    // The split only sums the split-known day.
    expect(scope.tokens.input).toBe(150);
    expect(scope.tokens.output).toBe(50);
    expect(scope.coverage.splitUnknownDays).toBe(1);
  });

  it("sums per-model tokens and cost across days, sorted by cost descending", () => {
    const points = [
      historyPoint("2026-07-01", "scanned", [
        {
          id: "claude",
          name: "Claude Code",
          total: 200,
          costUsd: 4,
          models: [{ modelName: "claude-sonnet-5", total: 200, costUsd: 4 }],
        },
      ]),
      historyPoint("2026-07-02", "scanned", [
        {
          id: "claude",
          name: "Claude Code",
          total: 950,
          costUsd: 5,
          models: [
            { modelName: "claude-haiku-5", total: 900, costUsd: 1 },
            { modelName: "claude-sonnet-5", total: 50, costUsd: 4 },
          ],
        },
      ]),
    ];
    const scope = scopeFromDaily(points);
    // claude-sonnet-5: 4 + 4 = 8 cost, 250 tokens. claude-haiku-5: 1 cost, 900
    // tokens — a null-cost/low-cost model must never outrank a priced one
    // purely on token volume.
    expect(scope.models.map((m) => m.modelName)).toEqual(["claude-sonnet-5", "claude-haiku-5"]);
    expect(scope.models[0].costUsd).toBeCloseTo(8, 6);
    expect(scope.models[0].tokens.total).toBe(250);
    expect(scope.models[1].costUsd).toBeCloseTo(1, 6);
  });
});
