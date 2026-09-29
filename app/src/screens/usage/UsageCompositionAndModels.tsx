import { HorizontalBarList, type BarRow } from "@/components/charts/HorizontalBarList";
import { Tag } from "@/components/Tag";
import type { UsageTokenCounts } from "@/features/usage/usageTypes";
import { plural } from "@/lib/plural";
import { ModelName } from "./ModelName";
import { isUnpriced, unpricedModelNames } from "./pricing";
import { TokenCompositionBars } from "./TokenCompositionBars";
import { foldTopModels, type ModelTotal, type ScopedCoverage } from "./usageAggregate";
import { formatCompact, formatCount, formatMoney, type UsageCurrency } from "./usageFormat";

const TOP_MODELS_LIMIT = 6;

export interface UsageCompositionCardProps {
  tokens: UsageTokenCounts;
  /** When any day in scope has no known token split, the bar's own
   *  denominator is partial — a caption under it says how many days that
   *  covers rather than letting the bar quietly read as complete. Optional:
   *  absent reads as "every day known" (no caption). */
  coverage?: ScopedCoverage;
}

const NO_UNKNOWN_COVERAGE: ScopedCoverage = { days: 0, costUnknownDays: 0, splitUnknownDays: 0 };

/** "Token composition" — a 100%-stacked bar of input/output/cache read/cache
 *  write, one hue (sequential steps) since this encodes magnitude, not
 *  identity. */
export function UsageCompositionCard({ tokens, coverage = NO_UNKNOWN_COVERAGE }: UsageCompositionCardProps) {
  return (
    <section className="usage-card" aria-label="Token composition">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Token composition</span>
          <h3>Input, output and cache</h3>
        </div>
      </div>
      <TokenCompositionBars
        tokens={tokens}
        ariaLabel="Token composition"
        note={
          coverage.splitUnknownDays > 0 ? (
            <p className="usage-note">
              Split unavailable for {coverage.splitUnknownDays} backfilled{" "}
              {plural(coverage.splitUnknownDays, "day")}.
            </p>
          ) : undefined
        }
      />
    </section>
  );
}

export interface UsageModelsCardProps {
  models: ModelTotal[];
  currency: UsageCurrency;
  eurRate: number;
}

/** "Top models" — a `HorizontalBarList` ranked by estimated cost, the tail
 *  past the top 6 folded into one `Other (N)` row. An unpriced model (real
 *  tokens, no cost) sinks below every priced one — a `$0.00` row would
 *  otherwise misreport it as free — and among unpriced models the ranking
 *  falls back to total tokens, so several of them still order sensibly. */
export function UsageModelsCard({ models, currency, eurRate }: UsageModelsCardProps) {
  // A model with neither tokens nor cost in this range is noise, not a rank.
  const active = models.filter((m) => m.tokens.total > 0 || m.costUsd > 0);
  const ranked = [...active].sort((a, b) => {
    const aUnpriced = isUnpriced(a);
    const bUnpriced = isUnpriced(b);
    if (aUnpriced !== bUnpriced) return aUnpriced ? 1 : -1;
    // Both priced: the incoming order is already cost-sorted descending
    // (`ScopedUsage.models`) — a comparator returning 0 for that pair keeps
    // it, since `Array.prototype.sort` is stable.
    return aUnpriced ? b.tokens.total - a.tokens.total : 0;
  });
  const folded = foldTopModels(ranked, TOP_MODELS_LIMIT);
  const rows: BarRow[] = folded.map((model) => {
    const unpriced = isUnpriced(model);
    return {
      key: model.modelName,
      label: <ModelName model={model.modelName} />,
      sub: `${formatCompact(model.tokens.total)} tokens`,
      value: model.costUsd,
      display: unpriced ? <Tag size="sm">unpriced</Tag> : formatMoney(model.costUsd, currency, eurRate),
      // The row's `sub` is the only compacted figure here; the hover recovers
      // the exact token count the "29.5B" rounds away, beside the same cost.
      titleText: unpriced
        ? "No price for this model in the current price table"
        : `${formatMoney(model.costUsd, currency, eurRate)} · ${formatCount(model.tokens.total)} tokens`,
    };
  });
  const unpricedNames = unpricedModelNames(active);

  return (
    <section className="usage-card" aria-label="Top models">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Models</span>
          <h3>By estimated cost</h3>
        </div>
      </div>
      {rows.length > 0 ? (
        <HorizontalBarList rows={rows} ariaLabel="Top models" />
      ) : (
        <p className="usage-note">No model usage in this range.</p>
      )}
      {unpricedNames.length > 0 && (
        <p className="usage-note">
          {unpricedNames.length} {plural(unpricedNames.length, "model")} in this range have no price.
          Open Prices to see which.
        </p>
      )}
    </section>
  );
}
