import { useEffect, useMemo, useState } from "react";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import type { UsageHarnessSummary } from "@/features/usage/usageTypes";
import { ccusageToHubHarness, orderHarnessIds } from "./harnessIdentity";
import { PricesPopover } from "./PricesPopover";
import type { UsageCurrency } from "./usageFormat";
import {
  EUR_RATE_MAX,
  EUR_RATE_MIN,
  parseEurRate,
  type UsageRange,
} from "./useUsagePrefs";
import type { ChartBucket } from "./usageChartColumns";

const RANGE_OPTIONS = [
  { value: "7d" as const, label: "7 days" },
  { value: "30d" as const, label: "30 days" },
  { value: "90d" as const, label: "90 days" },
  { value: "1y" as const, label: "1 year" },
  { value: "all" as const, label: "All time" },
];

const CURRENCY_OPTIONS = [
  { value: "USD" as const, label: "USD" },
  { value: "EUR" as const, label: "EUR" },
];

/** The harness `ChipRadios`' own "no filter" value — never a real ccusage
 *  harness id, so it can share the group's `value: string` shape instead of
 *  the group juggling `string | null` (translated at the props boundary,
 *  see {@link UsageControlsProps.harness}). */
const ALL_HARNESSES = "all";

export interface UsageControlsProps {
  range: UsageRange;
  onRangeChange: (value: UsageRange) => void;
  bucket: ChartBucket;
  onBucketChange: (value: ChartBucket) => void;
  /** Harnesses ccusage detected any usage from — the filter's option list.
   *  Range-independent (comes from the snapshot, not the filtered
   *  sessions), so picking a harness never itself changes which harnesses
   *  are offered. */
  harnesses: UsageHarnessSummary[];
  /** The active harness filter (a ccusage id), or `null` for "All". */
  harness: string | null;
  onHarnessChange: (value: string | null) => void;
  currency: UsageCurrency;
  onCurrencyChange: (value: UsageCurrency) => void;
  eurRate: number;
  onEurRateChange: (value: number) => void;
  /** Names of every unpriced model in the active scope — passed straight
   *  through to the Prices popover; this band has no scope concept itself. */
  unpricedModelNames: string[];
  onlinePricing: boolean;
  onOnlinePricingChange: (value: boolean) => void;
}

/**
 * The inline rate field. It holds the typed text itself instead of feeding
 * every keystroke back through `parseFloat`, because a controlled numeric
 * input over a validated number cannot be typed into: the intermediate
 * states of "0.9" are "0" (out of band → replaced by the default) and "0."
 * (unparseable → rejected, so the field snaps back to the old rate). The
 * draft commits only on a valid parse and reverts to the live rate on blur,
 * so a half-typed or out-of-band value is never silently substituted.
 */
function EurRateField({
  eurRate,
  onEurRateChange,
  active,
}: {
  eurRate: number;
  onEurRateChange: (v: number) => void;
  /** False while USD is selected: the field stays in the band at its full
   *  width (disabled, dimmed) so switching currency never reflows the
   *  controls under the pointer. */
  active: boolean;
}) {
  const [draft, setDraft] = useState(() => String(eurRate));

  // Re-sync when the rate changes from anywhere but this field (a fresh
  // mount over a stored value, a fallback after an invalid stored rate).
  useEffect(() => {
    setDraft((current) =>
      parseEurRate(current) === eurRate ? current : String(eurRate),
    );
  }, [eurRate]);

  return (
    <span
      className="usage-rate-field"
      data-inactive={active ? undefined : "true"}
    >
      <input
        type="text"
        inputMode="decimal"
        // `type="text"` on purpose: a `type="number"` field reports "" for
        // anything its own locale cannot parse, so a comma decimal would
        // arrive here as an empty string with the digits lost.
        aria-label="EUR per USD"
        disabled={!active}
        title={active ? undefined : "Switch to EUR to convert at this rate"}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = parseEurRate(next);
          if (parsed !== undefined) onEurRateChange(parsed);
        }}
        onBlur={() => setDraft(String(eurRate))}
      />
      <span
        className="usage-rate-hint"
        title={`Accepted ${EUR_RATE_MIN}–${EUR_RATE_MAX}. Reference rate, Sept 2026 — never fetched.`}
      >
        EUR per USD · ref. Sept 2026
      </span>
    </span>
  );
}

/** The range and harness shelf plus the static currency row directly under
 *  the header — plain flex rows, not a card. */
export function UsageControls({
  range,
  onRangeChange,
  bucket,
  onBucketChange,
  harnesses,
  harness,
  onHarnessChange,
  currency,
  onCurrencyChange,
  eurRate,
  onEurRateChange,
  unpricedModelNames,
  onlinePricing,
  onOnlinePricingChange,
}: UsageControlsProps) {
  const orderedHarnessIds = useMemo(
    () => orderHarnessIds(harnesses.map((h) => h.id)),
    [harnesses],
  );
  const harnessById = useMemo(
    () => new Map(harnesses.map((h) => [h.id, h])),
    [harnesses],
  );
  const harnessOptions = useMemo<ChipRadioOption<string>[]>(
    () => [
      { value: ALL_HARNESSES, label: "All" },
      ...orderedHarnessIds.map((id): ChipRadioOption<string> => {
        const summary = harnessById.get(id)!;
        const hubHarness = ccusageToHubHarness(id);
        return {
          value: id,
          label: summary.name,
          icon: hubHarness ? (
            <HarnessGlyph id={hubHarness} size={14} decorative />
          ) : undefined,
          title: summary.name,
        };
      }),
    ],
    [orderedHarnessIds, harnessById],
  );

  return (
    <>
      <div className="usage-controls-scope">
        <ChipRadios
          name="usage-range"
          label="Range"
          value={range}
          options={RANGE_OPTIONS}
          onChange={onRangeChange}
        />
        <ChipRadios
          name="usage-bucket"
          label="Bucket"
          value={bucket}
          options={[{ value: "day" as const, label: "Day" }, { value: "week" as const, label: "Week" }, { value: "month" as const, label: "Month" }]}
          onChange={onBucketChange}
        />
        <ChipRadios
          name="usage-harness"
          // Not "Harness" — the Sessions card below already owns that exact
          // accessible name on its own per-card harness `<Select>`
          // (`getByLabelText("Harness")` finds that one); two controls with
          // the same accessible name on one page is themselves also a real
          // a11y footgun, not just a test collision.
          label="Harness filter"
          value={harness ?? ALL_HARNESSES}
          options={harnessOptions}
          onChange={(value) =>
            onHarnessChange(value === ALL_HARNESSES ? null : value)
          }
          className="usage-harness-filter"
        />
      </div>
      <div className="usage-controls-currency-row">
        <div className="usage-currency-group">
          <ChipRadios
            name="usage-currency"
            label="Currency"
            value={currency}
            options={CURRENCY_OPTIONS}
            onChange={onCurrencyChange}
          />
          <EurRateField
            eurRate={eurRate}
            onEurRateChange={onEurRateChange}
            active={currency === "EUR"}
          />
          <PricesPopover
            unpricedModelNames={unpricedModelNames}
            onlinePricing={onlinePricing}
            onOnlinePricingChange={onOnlinePricingChange}
          />
        </div>
      </div>
    </>
  );
}
