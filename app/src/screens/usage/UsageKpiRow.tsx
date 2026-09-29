import { formatCapturedCount } from "./usageFormat";
import { StatCard } from "@/components/StatCard";
import type { UsageTokenCounts } from "@/features/usage/usageTypes";
import { plural } from "@/lib/plural";
import type { HarnessTotal, ScopedCoverage } from "./usageAggregate";
import { formatCompact, formatCount, formatMoney, formatPercent, type UsageCurrency } from "./usageFormat";

export interface UsageKpiRowProps {
  costUsd: number;
  tokens: UsageTokenCounts;
  sessions: number;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
  cacheHitRate: number;
  harnesses: HarnessTotal[];
  currency: UsageCurrency;
  eurRate: number;
  /** Backfilled-day counts for the active scope — adds the "cost excludes N
   *  backfilled days" clause to the cost tile, and blanks the cache-hit tile
   *  to "—" (with an explaining title) when the token split is unknown for
   *  any day in scope. Optional so a caller with no ledger concept at all
   *  (a plain `recomputeScopedUsage` result, a standalone spec fixture)
   *  need not fabricate one — absent reads as "every day known". */
  coverage?: ScopedCoverage;
  /** Names of every model in scope that carries real tokens but no price —
   *  marks the cost tile approximate (a leading `~`) and names the count, so
   *  the hero number never quietly under-states what it actually covers. */
  unpricedModels?: string[];
}

const NO_UNKNOWN_COVERAGE: ScopedCoverage = { days: 0, costUnknownDays: 0, splitUnknownDays: 0 };

/** The five headline `StatCard`s: cost, tokens, sessions, tool calls, cache
 *  hit rate. Every number here reflects the active Range scope. */
export function UsageKpiRow({
  costUsd,
  tokens,
  sessions,
  toolCalls,
  toolCallsKnown = true,
  toolCallsUnknownSessions = 0,
  cacheHitRate,
  harnesses,
  currency,
  eurRate,
  coverage = NO_UNKNOWN_COVERAGE,
  unpricedModels = [],
}: UsageKpiRowProps) {
  const outputPct = tokens.total > 0 ? tokens.output / tokens.total : 0;
  const cacheReadPct = tokens.total > 0 ? tokens.cacheRead / tokens.total : 0;
  const harnessesWithToolCalls = harnesses.filter((h) => h.toolCalls > 0);
  const toolCallsClauses =
    toolCalls > 0 && harnessesWithToolCalls.length > 0
      ? harnessesWithToolCalls.map((h) => h.name)
      : ["not reported"];
  if (!toolCallsKnown) toolCallsClauses.push(`partial or unavailable for ${toolCallsUnknownSessions} ${plural(toolCallsUnknownSessions, "session")}`);
  // The denominator prompt caching itself is measured against: every prompt
  // token that either landed fresh (input) or moved through the cache
  // (a read or a write), grounding the tile's own numbers in the explainer.
  const cachePromptTotal = tokens.input + tokens.cacheRead + tokens.cacheCreation;

  const costClauses =
    currency === "EUR"
      ? ["API-equivalent", `converted at ${eurRate} EUR/USD`]
      : ["API-equivalent", "not an invoice"];
  if (coverage.costUnknownDays > 0) {
    costClauses.push(`cost excludes ${coverage.costUnknownDays} backfilled ${plural(coverage.costUnknownDays, "day")}`);
  }
  const hasUnpriced = unpricedModels.length > 0;
  if (hasUnpriced) {
    costClauses.push(`${unpricedModels.length} ${plural(unpricedModels.length, "model")} unpriced`);
  }
  const costValue = formatMoney(costUsd, currency, eurRate);

  // A backfilled day has no real token split (see `docs/USAGE.md`), so the
  // rate below would otherwise silently understate cache reads against a
  // partly-zero-filled denominator — blanking the tile is more honest than
  // a wrong percentage.
  const cacheHitBlank = coverage.splitUnknownDays > 0;
  const cacheHitTitle = cacheHitBlank
    ? `Cache split unavailable for ${coverage.splitUnknownDays} backfilled ${plural(coverage.splitUnknownDays, "day")} in this range`
    : undefined;

  return (
    <div className="usage-kpis tile-row">
      <StatCard
        accent
        label="Estimated cost"
        value={hasUnpriced ? `~${costValue}` : costValue}
        title={costValue}
        // PLAN §5.2: while EUR is active the hero tile names the rate it was
        // converted at, so a number nobody can reconcile never appears.
        clauses={costClauses}
      />
      <StatCard
        label="Tokens"
        value={formatCompact(tokens.total)}
        title={formatCount(tokens.total)}
        clauses={[`${formatPercent(outputPct)} output`, `${formatPercent(cacheReadPct)} cache read`]}
      />
      <StatCard
        label="Sessions"
        value={formatCount(sessions)}
        clauses={[`across ${harnesses.length} ${plural(harnesses.length, "harness", "harnesses")}`]}
      />
      <StatCard
        label="Tool calls"
        value={formatCapturedCount(toolCalls, toolCallsKnown, true)}
        title={formatCapturedCount(toolCalls, toolCallsKnown)}
        clauses={toolCallsClauses}
      />
      <StatCard
        label="Cache hit rate"
        value={cacheHitBlank ? "—" : formatPercent(cacheHitRate)}
        title={cacheHitTitle}
        clauses={["of prompt tokens read from cache"]}
        hint={{
          title: "Why a high cache hit rate is good",
          body: (
            <>
              <p>
                Cache hit rate is the share of prompt tokens the provider re-served from its
                prompt cache instead of processing again: cache reads ÷ (input + cache reads +
                cache writes). In this scope: {formatCompact(tokens.cacheRead)} of{" "}
                {formatCompact(cachePromptTotal)} prompt tokens were cache reads.
              </p>
              <p>
                Anthropic bills a cache read at about 10% of the input price (a cache write at
                1.25×, or 2× for the 1-hour cache) and reports up to 90% lower cost and up to 85%
                lower latency on long prompts. OpenAI discounts cached input by 50–90% depending
                on the model, automatically for prompts over 1,024 tokens.
              </p>
              <p>
                A coding agent re-sends its whole context every turn, so a rate above 90% is
                normal and healthy. A drop usually means the context changed between turns (an
                edited system prompt, reordered tools) or the cache expired between turns.
              </p>
              <p className="stat-hint-sources">
                Sources: Anthropic prompt caching docs · OpenAI prompt caching guide
              </p>
            </>
          ),
        }}
      />
    </div>
  );
}
