import type { ReactNode } from "react";
import { CompositionBar, type Segment } from "@/components/charts/CompositionBar";
import { compositionPercents } from "@/components/charts/compositionPercents";
import { sequentialSteps } from "@/components/charts/chartColors";
import type { UsageTokenCounts } from "@/features/usage/usageTypes";
import { formatCompact } from "./usageFormat";

export interface TokenCompositionBarsProps {
  tokens: UsageTokenCounts;
  ariaLabel: string;
  /** Rendered between the two levels — e.g. the "split unavailable for N
   *  backfilled days" caption a partial-coverage range still needs. */
  note?: ReactNode;
  /** Condensed summaries can omit the secondary zoom while retaining exact labels. */
  showZoom?: boolean;
}

/** The share a segment must clear, of the whole, to count as "dominant". */
const ZOOM_DOMINANCE = 0.9;

/**
 * True when the top segment holds 90% or more of the total AND at least two
 * of the remaining segments are non-zero — the shape a ≥95%-cache-read
 * session produces, where a single linear bar renders the expensive slice
 * about a pixel wide (docs/changes/DESIGN-usage-numbers/PLAN.md §R1). A balanced
 * composition, or one with only one other non-zero segment (nothing left to
 * zoom into), never triggers the second level.
 */
export function shouldZoom(segments: Segment[]): boolean {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!(total > 0)) return false;
  const dominant = segments.reduce((max, s) => (s.value > max.value ? s : max), segments[0]);
  if (dominant.value / total < ZOOM_DOMINANCE) return false;
  const othersNonZero = segments.filter((s) => s !== dominant && s.value > 0).length;
  return othersNonZero >= 2;
}

/**
 * The two-level token composition bar. Level one is the full four-segment
 * `CompositionBar` (cache read, input, cache write, output — the fixed order
 * every caller shares, via `sequentialSteps(4)`, so a hue means the same
 * thing everywhere on this screen). Level two — only when {@link shouldZoom}
 * says the top segment would otherwise hide everything else — is the same
 * bar over the non-dominant segments, with its OWN denominator, under a
 * caption naming what it excludes and its share of the whole. Both levels
 * reuse the same segment objects (same id, same color), so a color can never
 * mean two different things at the two zoom levels.
 */
export function TokenCompositionBars({ tokens, ariaLabel, note, showZoom = true }: TokenCompositionBarsProps) {
  const [stepCacheRead, stepInput, stepCacheWrite, stepOutput] = sequentialSteps(4);
  const segments: Segment[] = [
    { id: "cache-read", label: "Cache read", value: tokens.cacheRead, color: stepCacheRead },
    { id: "input", label: "Input", value: tokens.input, color: stepInput },
    { id: "cache-write", label: "Cache write", value: tokens.cacheCreation, color: stepCacheWrite },
    { id: "output", label: "Output", value: tokens.output, color: stepOutput },
  ];

  const zoom = showZoom && shouldZoom(segments);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const dominant = zoom
    ? segments.reduce((max, s) => (s.value > max.value ? s : max), segments[0])
    : undefined;
  const rest = dominant ? segments.filter((s) => s.id !== dominant.id) : [];
  const restTotal = rest.reduce((sum, s) => sum + s.value, 0);

  // REVIEW-W1 #3: the caption's share must come from the SAME
  // `compositionPercents` result the level-one legend renders, per PLAN §R1
  // ("taken from the same compositionPercents result, so the two levels
  // agree by construction") — an independently computed `formatPercent`
  // call can print a different number for the same data (measured: cache
  // read 904/input 4/cacheCreation 48/output 44 rendered a dominant of 91%
  // beside a caption claiming the rest was 10%, summing to 101%). Reading
  // the dominant's own level-one percentage back and taking its complement
  // guarantees the two numbers sum to exactly 100 — `shouldZoom` only fires
  // at ≥90%, which `compositionPercents` always resolves to a whole number,
  // so the parse is safe.
  const levelOnePercents = compositionPercents(
    segments.map((s) => s.value),
    total,
  );
  const dominantIndex = dominant ? segments.findIndex((s) => s.id === dominant.id) : -1;
  const dominantWhole = dominantIndex >= 0 ? Number.parseInt(levelOnePercents[dominantIndex], 10) : NaN;
  const captionPercent = Number.isFinite(dominantWhole) ? `${100 - dominantWhole}%` : "0%";

  return (
    <>
      <CompositionBar segments={segments} format={formatCompact} ariaLabel={ariaLabel} />
      {note}
      {zoom && dominant && (
        <div className="usage-zoom-bar">
          <p className="usage-zoom-caption">
            Excluding {dominant.label.toLowerCase()} · {formatCompact(restTotal)} tokens ·{" "}
            {captionPercent} of all tokens
          </p>
          <CompositionBar
            segments={rest}
            format={formatCompact}
            ariaLabel={`${ariaLabel}, excluding ${dominant.label.toLowerCase()}`}
          />
        </div>
      )}
    </>
  );
}
