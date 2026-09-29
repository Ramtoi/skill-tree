import { plural } from "@/lib/plural";
import type { UsageEvent, UsageSessionPayload } from "@/features/usage/usageAnalyticsTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { formatCount, formatPercent, shortId } from "./usageFormat";
import { sessionKey } from "@/features/usage/sessionIdentity";

/**
 * Pure grouping/derivation module for the session timeline (design D14.7).
 * Every export here is a plain function over plain data — no DOM, no query
 * — so it is unit-testable without rendering anything, and reusable by both
 * `UsageSessionTimeline.tsx` (unit G) and `UsageSessionsCard.tsx`'s
 * `Timeline` action gate (unit F, via `ledgerSessionIdFor`).
 */

/** One steering turn: the `human_turn`/`slash_command` event that opened it
 *  (its excerpt is the segment's own "steering excerpt"), and every
 *  `skill`/`script`/`subagent` event up to the next opener. `opener` is
 *  `null` for events preceding the session's first steering turn — an
 *  edge case a real transcript should not produce, but the renderer must
 *  not assume it never happens. */
export interface UsageSegment {
  opener: UsageEvent | null;
  events: UsageEvent[];
}

const OPENER_KINDS = new Set<UsageEvent["kind"]>(["human_turn", "slash_command"]);

/**
 * Groups a session's flat event list into segments (design D14.7 bullet 3).
 * Processes the list strictly in ARRAY order — it does not sort by `at`.
 * Sorting is the ledger's job upstream; the renderer must not assume an
 * unsorted list can't reach it.
 */
export function segmentEvents(events: UsageEvent[]): UsageSegment[] {
  const segments: UsageSegment[] = [];
  let current: UsageSegment | null = null;
  for (const event of events) {
    if (OPENER_KINDS.has(event.kind)) {
      current = { opener: event, events: [] };
      segments.push(current);
      continue;
    }
    if (!current) {
      current = { opener: null, events: [] };
      segments.push(current);
    }
    current.events.push(event);
  }
  return segments;
}

/** Renders the **last** N segments (a session's end is what a reader came
 *  for), the control above them reading "Show N earlier segments". */
export const TIMELINE_SEGMENT_CAP = 200;

/** Renders the first N event rows of a segment (inside a segment the order
 *  is causal, so the head is the useful end), the control below them
 *  reading "Show N more events". */
export const TIMELINE_EVENTS_PER_SEGMENT_CAP = 50;

export interface UsageSegmentMetrics {
  /** `cache_read / (input + cache_creation + cache_read)` over the
   *  segment's own events — `null` when that sum is 0, never `0`. */
  cache_ratio: number | null;
  /** `thinking_len / output_text_len` over the segment's own events —
   *  `null` when `output_text_len` sums to 0, never `0`. */
  thinking_share: number | null;
}

/**
 * Sums a segment's `skill`/`script`/`subagent` events' token/thinking
 * fields and derives the two per-segment ratios (design D14.7, G2) — never
 * the session-level `summary.cache_hit_ratio`/`summary.thinking_text_share`
 * figures, which would print one number on every segment and read as a
 * lie. The opener event is excluded from the sums: it is a `human_turn`/
 * `slash_command`, which carries no assistant token usage of its own.
 */
export function segmentMetrics(segment: UsageSegment): UsageSegmentMetrics {
  let input = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let thinkingLen = 0;
  let outputTextLen = 0;
  for (const event of segment.events) {
    input += event.tokens.input;
    cacheCreation += event.tokens.cache_creation;
    cacheRead += event.tokens.cache_read;
    thinkingLen += event.thinking_len;
    outputTextLen += event.output_text_len;
  }
  const cacheDenominator = input + cacheCreation + cacheRead;
  return {
    cache_ratio: cacheDenominator > 0 ? cacheRead / cacheDenominator : null,
    thinking_share: outputTextLen > 0 ? thinkingLen / outputTextLen : null,
  };
}

/**
 * The session timeline's one summary line (story 51): tokens, cache hit
 * ratio, steering count, duration, sub-agent token share, and the loadout
 * state. A pure function so it is unit-testable without a DOM; exact wording
 * is this module's own composition (design D14.7 names the FACTS the line
 * must carry, not its copy).
 */
export function summaryLine(payload: UsageSessionPayload): string {
  const s = payload.summary;
  if (!s) return "";
  const parts = [
    `${formatCount(s.tokens_total)} ${plural(s.tokens_total, "token")}`,
    `${formatPercent(s.cache_hit_ratio)} cache hit`,
    `${s.steering_count} ${plural(s.steering_count, "steering turn")}`,
    `${s.duration_minutes} ${plural(s.duration_minutes, "minute")}`,
    `${formatPercent(s.subagent_token_share)} sub-agent share`,
  ];
  if (s.loadout_assumed) parts.push("current loadout assumed");
  if (s.parent_session_id) parts.push(`part of ${shortId(s.parent_session_id)}`);
  if (s.compactions !== undefined && s.compactions > 0) {
    parts.push(`${s.compactions} ${plural(s.compactions, "compaction")}`);
  }
  return parts.join(" · ");
}

/**
 * The ledger `session_id` a ccusage row corresponds to, or `null` when the
 * row carries no UUID at all (a fallback composite id). Derived, never
 * assumed: `row.id` is tried first, then `row.period`; Codex rollout rows use
 * the trailing rollout UUID as their normalized id. The match is anchored to
 * a FULL-STRING RFC-4122 UUID so a
 * rollout path that still embeds one cannot be mistaken for a session id.
 * A `null` result means the caller renders no `Timeline` action — the
 * affordance is absent rather than landing on nothing (design D14.7,
 * `lib/missingRefs.ts`'s no-client-side-predictive-twin doctrine).
 */
export function ledgerSessionIdFor(row: UsageSessionRow): string | null {
  const key = sessionKey(row.harnessId, row.id) ?? sessionKey(row.harnessId, row.period);
  return key?.slice(key.indexOf(":") + 1) ?? null;
}
