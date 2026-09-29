import { formatPercent } from "@/screens/usage/usageFormat";

/**
 * Legend percentages for a composition of `values` that sum to `total` (a
 * caller with a genuinely partial composition — `values` summing to less
 * than `total` — gets the honest, unrounded-up remainder: see rule 4) — the
 * shared rule behind `CompositionBar`'s legend and the Usage screen's
 * two-level zoom bar (docs/changes/DESIGN-usage-numbers/PLAN.md §R1). Applied in order:
 *
 * 1. A non-positive or non-finite `total` degrades to `"0%"` for every entry.
 * 2. `value === 0` (or negative/non-finite) reads `"0%"` — the only thing
 *    allowed to.
 * 3. A share under 1% renders through the existing {@link formatPercent}:
 *    `"0.1%"` down to `"<0.1%"`.
 * 4. Every remaining share (≥ 1%) is a whole number, assigned by largest
 *    remainder so the whole-number set sums to exactly
 *    `min(100 - round(sum of the sub-1% shares), round(sum of the whole-
 *    bucket shares))` — never each share rounded independently, which would
 *    otherwise let the visible numbers overstate or understate 100 by the
 *    very margin this bar exists to be honest about. REVIEW-W1 #5: the
 *    `min(...)` is the clamp — without it, a genuinely partial composition
 *    (`values` summing to less than `total`) had its whole-bucket shares
 *    inflated to fill the rounding budget the sub-1% bucket left behind,
 *    printing MORE than each share's own real percentage (measured:
 *    `compositionPercents([50, 25], 100)` → `["51%", "26%"]`, not the
 *    `["50%", "25%"]` the real 50%/25% shares are). Every caller in this
 *    codebase passes `values` that already sum to `total` exactly, so the
 *    clamp changes nothing for any of them — it only stops a future
 *    partial-composition caller from inheriting an invented percentage.
 */
export function compositionPercents(values: number[], total: number): string[] {
  if (!(total > 0) || !Number.isFinite(total)) return values.map(() => "0%");

  const out: string[] = values.map(() => "0%");
  const wholeIndices: number[] = [];
  let subOnePercentSum = 0;

  values.forEach((value, i) => {
    if (!(value > 0) || !Number.isFinite(value)) return; // stays "0%"
    const share = value / total;
    const pct = share * 100;
    if (pct < 1) {
      out[i] = formatPercent(share);
      subOnePercentSum += pct;
    } else {
      wholeIndices.push(i);
    }
  });

  const exact = wholeIndices.map((i) => (values[i] / total) * 100);
  const sumOfWholeShares = exact.reduce((a, b) => a + b, 0);
  const wholeTotal = Math.max(
    0,
    Math.min(100 - Math.round(subOnePercentSum), Math.round(sumOfWholeShares)),
  );
  const floors = exact.map((v) => Math.floor(v));
  let remainder = wholeTotal - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, k) => ({ k, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.k - b.k);
  const wholeValues = [...floors];
  for (const { k } of order) {
    if (remainder <= 0) break;
    wholeValues[k] += 1;
    remainder -= 1;
  }
  wholeIndices.forEach((i, k) => {
    out[i] = `${wholeValues[k]}%`;
  });

  return out;
}
