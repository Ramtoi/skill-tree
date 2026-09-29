import type { UsageTokenCounts } from "@/features/usage/usageTypes";
import type { ModelTotal } from "./usageAggregate";

/**
 * A model carries real tokens but a non-positive cost — the price table has
 * nothing for it, it is not literally free (docs/changes/DESIGN-usage-numbers/PLAN.md
 * §R3). A model with neither tokens nor cost is absent, not unpriced; the
 * caller's own zero-usage filter already drops that case before this ever
 * runs.
 *
 * REVIEW-W1 #1: `costUsd <= 0` alone cannot tell "the price table has
 * nothing for this model" apart from "this day's cost was never computed at
 * all" — a backfilled-only model (`hub usage import-claude-stats`) is
 * `costUsd`-0-filled with `costKnown: false`, and it already has its own
 * honest explanation ("cost excludes N backfilled days"). `costKnown` is
 * absent (not `false`) for every other caller — a session's own breakdown,
 * a live scan's day rows — so only an EXPLICIT `false` opts a row out.
 */
export function isUnpriced(m: { tokens: UsageTokenCounts; costUsd: number; costKnown?: boolean }): boolean {
  return m.tokens.total > 0 && m.costUsd <= 0 && m.costKnown !== false;
}

/** Names of every unpriced model in `models`, in their given order. */
export function unpricedModelNames(models: ModelTotal[]): string[] {
  return models.filter(isUnpriced).map((m) => m.modelName);
}
