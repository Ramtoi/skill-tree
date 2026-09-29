import { hasCompleteToolCount } from "@/features/usage/usageNative";
import type {
  UsageDailyPoint,
  UsageModelBreakdown,
  UsageSessionRow,
  UsageTokenCounts,
} from "@/features/usage/usageTypes";
import type { UsageRange } from "./useUsagePrefs";

/** A ccusage date is always ISO-shaped: "YYYY-MM-DD", or a full timestamp
 *  starting with one. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/;

/**
 * Epoch ms for a usage date, or `undefined` when the value is not a date at
 * all.
 *
 * **Never call `new Date(value)` on a period directly.** A session's `period`
 * is a date only when ccusage reports one; otherwise it is an opaque id, and
 * V8's legacy fallback parser happily invents a date out of one:
 * `new Date("claude-session-3")` is 1 March **2001**, `new Date("sess-12")`
 * is December 2001. That silently pushed every id-shaped session out of the
 * 7-day and 30-day ranges as "too old" — real spend disappearing from every
 * narrowed view — and sorted it as 25 years old under "Most recent". So the
 * shape is checked before anything is parsed.
 */
export function parseUsageDate(value: string | undefined): number | undefined {
  if (!value || !ISO_DATE_PREFIX.test(value)) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

/** Same rule the daily chart and the sessions list share: a missing or
 *  undatable value always passes (never silently drops a row the caller
 *  can't otherwise date), "all" always passes, otherwise the UTC date must
 *  fall within the inclusive calendar bounds for the range. */
export function isWithinRange(
  dateLike: string | undefined,
  range: UsageRange,
): boolean {
  if (range === "all") return true;
  const time = parseUsageDate(dateLike);
  if (time === undefined) return true;
  const key = new Date(time).toISOString().slice(0, 10);
  const { since, until } = rangeBounds(range);
  return since !== null && until !== null && since <= key && key <= until;
}

export function rangeBounds(range: UsageRange, now = new Date()): { since: string | null; until: string | null } {
  if (range === "all") return { since: null, until: null };
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (range === "7d" ? 6 : range === "30d" ? 29 : range === "90d" ? 89 : 364));
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

export function windowBounds(window: 7 | 30 | 90, now = new Date()): { since: string; until: string } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (window - 1));
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

export function filterDailyByRange(
  daily: UsageDailyPoint[],
  range: UsageRange,
): UsageDailyPoint[] {
  return daily.filter((point) => isWithinRange(point.date, range));
}

/** Narrows every daily point to one harness's own per-harness entry, `null`
 *  passing every point through unchanged. A point is always **kept**, never
 *  dropped — a day with no activity from the picked harness becomes a zero
 *  point (its own `harnesses` list emptied, `tokens`/`estimatedCost` zeroed)
 *  so the spend chart's x-axis stays continuous instead of gapping out. */
export function filterDailyByHarness(
  daily: UsageDailyPoint[],
  harnessId: string | null,
): UsageDailyPoint[] {
  if (harnessId === null) return daily;
  return daily.map((point) => {
    const kept = point.harnesses.filter((h) => h.id === harnessId);
    const tokens = kept.reduce(
      (acc, h) => addTokens(acc, h.tokens),
      zeroTokens(),
    );
    const costUsd = kept.reduce((sum, h) => sum + h.estimatedCost.usd, 0);
    const knownSessions = kept.filter((h) => h.sessionsKnown === true && h.sessions !== undefined);
    return {
      ...point,
      harnesses: kept,
      tokens,
      estimatedCost: { ...point.estimatedCost, usd: costUsd },
      sessions: knownSessions.reduce((sum, h) => sum + (h.sessions ?? 0), 0),
      sessionsKnown: knownSessions.length === kept.length,
    };
  });
}

/**
 * The one range-scoped daily-points producer. Chooses the durable ledger's
 * `history` points when it holds anything at all, falling back to the scan's
 * own `scanDaily` when the ledger is still empty (first run, before the
 * first `hub usage record` — see `docs/USAGE.md`) — composed purely from
 * {@link filterDailyByRange} + {@link filterDailyByHarness}, so this adds no
 * new filtering logic of its own. `LocalAgentUsage.tsx` calls this ONCE and
 * hands the same array to both the spend chart and {@link scopeFromDaily},
 * so the chart's column sum and the KPI total can never drift apart.
 */
export function rangeScopedDaily(
  history: UsageDailyPoint[],
  scanDaily: UsageDailyPoint[],
  range: UsageRange,
  harnessId: string | null,
): UsageDailyPoint[] {
  const source = history.length > 0 ? history : scanDaily;
  return filterDailyByHarness(filterDailyByRange(source, range), harnessId);
}

/** How many of the scoped days had to fall back to a 0-filled cost/split —
 *  the count behind every "excludes N backfilled days" caveat on the
 *  screen. `days` is the scope's total day count (for a "N of M" phrasing a
 *  caller may want later; the caveats built today only need the two
 *  unknown counts). */
export type ScopedCoverage = {
  days: number;
  costUnknownDays: number;
  splitUnknownDays: number;
};

/**
 * The token/cost/model/harness-token half of a scope — everything a
 * `UsageDailyPoint[]` (already range- and harness-filtered, see
 * {@link rangeScopedDaily}) can answer on its own. `LocalAgentUsage.tsx`
 * joins this with {@link recomputeScopedUsage}`(filteredSessions)` for the
 * session-only fields (`sessions`, `toolCalls`, `topModel`, `projects`) —
 * see `docs/USAGE.md` for why those two halves can never be answered by one
 * source.
 *
 * `tokens.total` is always exact (a point's own total, the ledger never
 * 0-fills it). `costUsd` and the token-split fields, and the two coverage
 * counts, are derived from the AGENT grain (`point.harnesses[].costKnown`/
 * `splitKnown`) — never the day-grain flags. The day-grain flags go false as
 * soon as ANY agent active that day is backfilled, so gating on them would
 * drop a co-occurring agent's real, known cost (see usageAggregate review
 * C1/W2) — including under a harness filter, where `filterDailyByHarness`
 * has already narrowed `point.harnesses` to the picked one but leaves the
 * day-grain flags computed over the pre-filter day untouched. Summing the
 * surviving harness entries instead makes a filtered scope self-consistent
 * by construction. `coverage` counts the days that had to exclude at least
 * one agent's cost/split so the screen can say so.
 */
export function scopeFromDaily(points: UsageDailyPoint[]): {
  tokens: UsageTokenCounts;
  costUsd: number;
  cacheHitRate: number;
  harnesses: Array<Omit<HarnessTotal, "sessions" | "toolCalls">>;
  models: ModelTotal[];
  coverage: ScopedCoverage;
} {
  const tokens = zeroTokens();
  let costUsd = 0;
  let costUnknownDays = 0;
  let splitUnknownDays = 0;

  const harnessOrder: string[] = [];
  const harnesses = new Map<
    string,
    {
      id: string;
      name: string;
      tokens: UsageTokenCounts;
      costUsd: number;
      models: Map<string, ModelAccumulator>;
      sawKnownCost: boolean;
      sawUnknownCost: boolean;
    }
  >();
  const models = new Map<string, ModelAccumulator>();

  for (const point of points) {
    // `tokens.total` is always exact — a point's own total, never 0-filled.
    tokens.total += point.tokens.total;
    // Whether THIS day (after any harness filter already narrowed
    // `point.harnesses`) contributed an unknown cost/split — from the
    // surviving agents, never the day-grain flags (C1/W2).
    let dayHadUnknownCost = false;
    let dayHadUnknownSplit = false;

    for (const harness of point.harnesses) {
      let acc = harnesses.get(harness.id);
      if (!acc) {
        acc = {
          id: harness.id,
          name: harness.name,
          tokens: zeroTokens(),
          costUsd: 0,
          models: new Map(),
          sawKnownCost: false,
          sawUnknownCost: false,
        };
        harnesses.set(harness.id, acc);
        harnessOrder.push(harness.id);
      }
      // Agent-grain flags drive both this harness's own totals AND the
      // scope-wide `tokens`/`costUsd` above: a day with several agents can
      // have one backfilled agent beside a fully-known one, and a harness
      // filter can leave only the known one in `point.harnesses`.
      const harnessSplitKnown = harness.splitKnown !== false;
      acc.tokens.total += harness.tokens.total;
      if (harnessSplitKnown) {
        acc.tokens.input += harness.tokens.input;
        acc.tokens.output += harness.tokens.output;
        acc.tokens.cacheCreation += harness.tokens.cacheCreation;
        acc.tokens.cacheRead += harness.tokens.cacheRead;
        tokens.input += harness.tokens.input;
        tokens.output += harness.tokens.output;
        tokens.cacheCreation += harness.tokens.cacheCreation;
        tokens.cacheRead += harness.tokens.cacheRead;
      } else {
        dayHadUnknownSplit = true;
      }
      if (harness.costKnown !== false) {
        acc.costUsd += harness.estimatedCost.usd;
        acc.sawKnownCost = true;
        costUsd += harness.estimatedCost.usd;
      } else {
        acc.sawUnknownCost = true;
        dayHadUnknownCost = true;
      }
      for (const model of harness.models ?? []) {
        addModelTotal(acc.models, model);
        addModelTotal(models, model);
      }
    }

    if (dayHadUnknownCost) costUnknownDays += 1;
    if (dayHadUnknownSplit) splitUnknownDays += 1;
  }

  const harnessTotals: Array<Omit<HarnessTotal, "sessions" | "toolCalls">> = harnessOrder.map((id) => {
    const acc = harnesses.get(id)!;
    // No session data exists at this grain (sessions are not ledgered), so
    // "top model" here is the harness's highest-token model instead of
    // {@link HarnessTotal.topModel}'s usual "most sessions" — the best
    // signal this aggregate can offer; `LocalAgentUsage.tsx` overrides it
    // with the session-derived value whenever one is available.
    const topModel = topModelByTokens(acc.models);
    return {
      id: acc.id,
      name: acc.name,
      tokens: acc.tokens,
      costUsd: acc.costUsd,
      topModel,
      costPartial: acc.sawKnownCost && acc.sawUnknownCost,
    };
  });

  const modelTotals: ModelTotal[] = Array.from(models.entries())
    .map(([modelName, usage]) => ({
      modelName,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      costKnown: usage.costKnown,
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd || b.tokens.total - a.tokens.total || a.modelName.localeCompare(b.modelName),
    );

  return {
    tokens,
    costUsd,
    cacheHitRate: cacheHitRateOf(tokens),
    harnesses: harnessTotals,
    models: modelTotals,
    coverage: { days: points.length, costUnknownDays, splitUnknownDays },
  };
}

type ModelAccumulator = { tokens: UsageTokenCounts; costUsd: number; costKnown: boolean };

/** REVIEW-W1 #1: `costKnown` accumulates with `||=` — a model's cost counts
 *  as known scope-wide the moment ANY contributing row says so (a session
 *  that ran both backfilled and live days is not "unpriced" just because one
 *  of its days couldn't price it), never flipped back to false by a later
 *  unknown row. */
function addModelTotal(target: Map<string, ModelAccumulator>, model: UsageModelBreakdown) {
  const existing = target.get(model.modelName) ?? { tokens: zeroTokens(), costUsd: 0, costKnown: false };
  addTokens(existing.tokens, model.tokens);
  existing.costUsd += model.estimatedCost.usd;
  existing.costKnown = existing.costKnown || model.costKnown !== false;
  target.set(model.modelName, existing);
}

function topModelByTokens(models: Map<string, ModelAccumulator>): string | undefined {
  let best: string | undefined;
  let bestTokens = -1;
  for (const [name, usage] of models) {
    if (usage.tokens.total > bestTokens) {
      best = name;
      bestTokens = usage.tokens.total;
    }
  }
  return best;
}

/** The date a session is bucketed by: its **last activity**, else its start
 *  time, else its (possibly session-id-shaped, never a real date) `period`.
 *  Last activity leads because that is the timestamp the session row itself
 *  prints and the one "Most recent" sorts by — dating a session by its start
 *  instead would drop a session shown as "1 day ago" out of the 7-day range.
 *  One ladder, so range filtering and sorting can never disagree. */
function sessionRangeKey(session: UsageSessionRow): string | undefined {
  return session.lastActivity ?? session.startedAt ?? session.period;
}

/** {@link sessionRangeKey} as epoch ms, or `-Infinity` when the session
 *  carries no usable date (it sorts last, and is never `NaN` — a `NaN`
 *  comparator result is spec-coerced to 0 and would make the order of two
 *  undated sessions depend on the engine). */
export function sessionTimeMs(session: UsageSessionRow): number {
  return parseUsageDate(sessionRangeKey(session)) ?? Number.NEGATIVE_INFINITY;
}

export function filterSessionsByRange(
  sessions: UsageSessionRow[],
  range: UsageRange,
): UsageSessionRow[] {
  return sessions.filter((session) =>
    isWithinRange(sessionRangeKey(session), range),
  );
}

/** Narrows a session list to one harness's own sessions, `null` passing every
 *  session through unchanged. */
export function filterSessionsByHarness(
  sessions: UsageSessionRow[],
  harnessId: string | null,
): UsageSessionRow[] {
  if (harnessId === null) return sessions;
  return sessions.filter((session) => session.harnessId === harnessId);
}

export function zeroTokens(): UsageTokenCounts {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
}

export function addTokens(
  target: UsageTokenCounts,
  value: UsageTokenCounts,
): UsageTokenCounts {
  target.input += value.input;
  target.output += value.output;
  target.cacheCreation += value.cacheCreation;
  target.cacheRead += value.cacheRead;
  target.total += value.total;
  return target;
}

function scaleTokens(
  value: UsageTokenCounts,
  factor: number,
): UsageTokenCounts {
  return {
    input: value.input * factor,
    output: value.output * factor,
    cacheCreation: value.cacheCreation * factor,
    cacheRead: value.cacheRead * factor,
    total: value.total * factor,
  };
}

export function cacheHitRateOf(tokens: UsageTokenCounts): number {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return denominator > 0 ? tokens.cacheRead / denominator : 0;
}

export interface HarnessTotal {
  id: string;
  name: string;
  tokens: UsageTokenCounts;
  costUsd: number;
  sessions: number;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
  /** The harness's most-used model within this scope, by session count —
   *  not by cost (sessions carry no per-model cost split, see `models` below). */
  topModel?: string;
  /** Set by {@link scopeFromDaily} only: true when this harness has at least
   *  one backfilled (cost-unknown) day in the current scope alongside at
   *  least one cost-known one — the per-row mark `UsageHarnessBreakdown`
   *  reads. `recomputeScopedUsage`'s session-derived totals never set this
   *  (a session always carries a real cost), so a harness row joined purely
   *  from that path reads as `undefined`, never a false positive. */
  costPartial?: boolean;
}

export interface ModelTotal {
  modelName: string;
  tokens: UsageTokenCounts;
  costUsd: number;
  /** `false` only when every contributing row is a backfilled/cost-unknown
   *  one (REVIEW-W1 #1) — absent from `recomputeScopedUsage`'s session-
   *  derived totals, which are always real. `isUnpriced` treats absent the
   *  same as `true`. */
  costKnown?: boolean;
}

export interface ProjectTotal {
  key: string;
  label: string;
  /** The registered hub project key this total's sessions carry — set only
   *  when the session's own `hubProject` is present, never derived from the
   *  (anonymized) display `label`. `UsageProjectsCard` links a row on this,
   *  not on `label`, and only when it names a project the registry actually
   *  has (design D14.8, G3). */
  hubProject?: string;
  sessions: number;
  tokens: UsageTokenCounts;
  costUsd: number;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
}

export interface ScopedUsage {
  tokens: UsageTokenCounts;
  costUsd: number;
  sessions: number;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
  cacheHitRate: number;
  /** Only harnesses with at least one session in scope — in insertion order
   *  (callers reorder with `orderHarnessIds`). */
  harnesses: HarnessTotal[];
  /** Sorted by estimated cost, descending. */
  models: ModelTotal[];
  /** Sorted by estimated cost, descending. */
  projects: ProjectTotal[];
}

/**
 * Recomputes every range-scoped aggregate from a (already range-filtered)
 * session list. For the `models` breakdown, a session's REAL per-model
 * tokens/cost are used whenever ccusage reported one (`session.modelBreakdown`
 * is non-empty) — summed in directly, exact. Only a session whose breakdown
 * came back empty (an older cache, or a harness ccusage didn't split) falls
 * back to dividing that session's aggregate tokens/cost evenly across
 * `session.models`, a best-effort estimate (the same "estimated, not exact"
 * posture the whole screen already carries). Either way this never affects
 * `tokens`/`costUsd`/`harnesses`/`projects`, which sum the session's real
 * totals directly.
 */
export function recomputeScopedUsage(sessions: UsageSessionRow[]): ScopedUsage {
  const harnessOrder: string[] = [];
  const harnesses = new Map<
    string,
    {
      id: string;
      name: string;
      tokens: UsageTokenCounts;
      costUsd: number;
      sessions: number;
      toolCalls: number;
      toolCallsUnknownSessions: number;
      modelCounts: Map<string, number>;
    }
  >();
  const models = new Map<
    string,
    { tokens: UsageTokenCounts; costUsd: number }
  >();
  const projects = new Map<string, ProjectTotal>();

  const tokens = zeroTokens();
  let costUsd = 0;
  let toolCalls = 0;
  let toolCallsUnknownSessions = 0;

  for (const session of sessions) {
    addTokens(tokens, session.tokens);
    costUsd += session.estimatedCost.usd;
    if (!hasCompleteToolCount(session)) toolCallsUnknownSessions += 1;
    toolCalls += session.toolCalls ?? 0;

    let harness = harnesses.get(session.harnessId);
    if (!harness) {
      harness = {
        id: session.harnessId,
        name: session.harnessName,
        tokens: zeroTokens(),
        costUsd: 0,
        sessions: 0,
        toolCalls: 0,
        toolCallsUnknownSessions: 0,
        modelCounts: new Map(),
      };
      harnesses.set(session.harnessId, harness);
      harnessOrder.push(session.harnessId);
    }
    addTokens(harness.tokens, session.tokens);
    harness.costUsd += session.estimatedCost.usd;
    harness.sessions += 1;
    if (!hasCompleteToolCount(session)) harness.toolCallsUnknownSessions += 1;
    harness.toolCalls += session.toolCalls ?? 0;
    for (const modelName of session.models) {
      harness.modelCounts.set(
        modelName,
        (harness.modelCounts.get(modelName) ?? 0) + 1,
      );
    }

    const breakdown = session.modelBreakdown ?? [];
    if (breakdown.length > 0) {
      // Real per-model tokens/cost, straight from ccusage — summed in
      // directly rather than estimated.
      for (const model of breakdown) {
        const existing = models.get(model.modelName) ?? {
          tokens: zeroTokens(),
          costUsd: 0,
        };
        addTokens(existing.tokens, model.tokens);
        existing.costUsd += model.estimatedCost.usd;
        models.set(model.modelName, existing);
      }
    } else {
      // Fallback: no real split available for this session — divide its
      // aggregate tokens/cost evenly across the models it used.
      const modelShare =
        session.models.length > 0 ? 1 / session.models.length : 0;
      for (const modelName of session.models) {
        const existing = models.get(modelName) ?? {
          tokens: zeroTokens(),
          costUsd: 0,
        };
        addTokens(existing.tokens, scaleTokens(session.tokens, modelShare));
        existing.costUsd += session.estimatedCost.usd * modelShare;
        models.set(modelName, existing);
      }
    }

    // `UsageProjectRef.label` (`session.project?.label`) is an ANONYMIZED
    // DISPLAY name, not a registry key — grouping on it collapsed two
    // sessions of the same hub project only when their display labels
    // happened to match. `session.hubProject` is the one field that carries
    // the real registry key, so it is the grouping key whenever the session
    // carries one; `label` still wins the DISPLAY name either way (design
    // D14.8, G3).
    const label = session.project?.label ?? "No project";
    const key = session.hubProject ?? label;
    let project = projects.get(key);
    if (!project) {
      project = {
        key,
        label,
        hubProject: session.hubProject,
        sessions: 0,
        tokens: zeroTokens(),
        costUsd: 0,
        toolCalls: 0,
        toolCallsUnknownSessions: 0,
      };
      projects.set(key, project);
    }
    addTokens(project.tokens, session.tokens);
    project.costUsd += session.estimatedCost.usd;
    project.sessions += 1;
    if (!hasCompleteToolCount(session)) project.toolCallsUnknownSessions = (project.toolCallsUnknownSessions ?? 0) + 1;
    project.toolCalls += session.toolCalls ?? 0;
  }

  const harnessTotals: HarnessTotal[] = harnessOrder.map((id) => {
    const harness = harnesses.get(id)!;
    return {
      id: harness.id,
      name: harness.name,
      tokens: harness.tokens,
      costUsd: harness.costUsd,
      sessions: harness.sessions,
      toolCalls: harness.toolCalls,
      toolCallsKnown: harness.toolCallsUnknownSessions === 0,
      toolCallsUnknownSessions: harness.toolCallsUnknownSessions,
      topModel: mostFrequent(harness.modelCounts),
    };
  });

  const modelTotals: ModelTotal[] = Array.from(models.entries())
    .map(([modelName, usage]) => ({
      modelName,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.tokens.total - a.tokens.total ||
        a.modelName.localeCompare(b.modelName),
    );

  const projectTotals: ProjectTotal[] = Array.from(projects.values()).map((project) => ({
    ...project, toolCallsKnown: (project.toolCallsUnknownSessions ?? 0) === 0,
  })).sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.tokens.total - a.tokens.total ||
      a.label.localeCompare(b.label),
  );

  return {
    tokens,
    costUsd,
    sessions: sessions.length,
    toolCalls,
    toolCallsKnown: toolCallsUnknownSessions === 0,
    toolCallsUnknownSessions,
    cacheHitRate: cacheHitRateOf(tokens),
    harnesses: harnessTotals,
    models: modelTotals,
    projects: projectTotals,
  };
}

function mostFrequent(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** Keeps the top `n` models by cost and folds the remainder into one
 *  `Other (N)` row summing their tokens/cost. A list already at or under
 *  `n` is returned unchanged. */
export function foldTopModels(models: ModelTotal[], n: number): ModelTotal[] {
  if (models.length <= n) return models;
  const top = models.slice(0, n);
  const rest = models.slice(n);
  const otherTokens = rest.reduce<UsageTokenCounts>(
    (acc, model) => addTokens(acc, model.tokens),
    zeroTokens(),
  );
  const otherCost = rest.reduce((sum, model) => sum + model.costUsd, 0);
  return [
    ...top,
    {
      modelName: `Other (${rest.length})`,
      tokens: otherTokens,
      costUsd: otherCost,
    },
  ];
}
