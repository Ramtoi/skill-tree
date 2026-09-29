import { useState } from "react";
import type { ChartBucket } from "./usageChartColumns";
import type { UsageCurrency } from "./usageFormat";
import { useUsagePreferences } from "@/store/usagePreferences";
export { DEFAULT_EUR_RATE, EUR_RATE_MIN, EUR_RATE_MAX, isValidEurRate, parseEurRate } from "@/lib/usagePreferences";

export type UsageRange = "7d" | "30d" | "90d" | "1y" | "all";

const RANGE_KEY = "st:usage:range";
const BUCKET_KEY = "st:usage:bucket";
const BUCKET_RANGE_KEY = "st:usage:bucketRange";
const HARNESS_KEY = "st:usage:harness";

function readRange(): UsageRange {
  try {
    const value = localStorage.getItem(RANGE_KEY);
    return value === "7d" || value === "30d" || value === "90d" || value === "1y" || value === "all" ? value : "all";
  } catch {
    return "all";
  }
}

/** Explicit buckets belong to the range where they were chosen. */
function readBucket(): ChartBucket | null {
  try {
    if (localStorage.getItem(BUCKET_RANGE_KEY) !== readRange()) return null;
    const value = localStorage.getItem(BUCKET_KEY);
    return value === "day" || value === "week" || value === "month" ? value : null;
  } catch {
    return null;
  }
}

/** A ccusage harness id (e.g. `"claude"`), or `null` for "All harnesses". No
 *  validation happens here — {@link readHarness} has no snapshot to check
 *  a stored id against, so an id the current snapshot no longer detects is
 *  sanitized to "all" downstream, by the caller that does hold the
 *  snapshot. */
function readHarness(): string | null {
  try {
    const value = localStorage.getItem(HARNESS_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface UsagePrefs {
  range: UsageRange;
  setRange: (value: UsageRange) => void;
  currency: UsageCurrency;
  setCurrency: (value: UsageCurrency) => void;
  eurRate: number;
  setEurRate: (value: number) => void;
  bucket: ChartBucket | null;
  setBucket: (value: ChartBucket) => void;
  /** The picked harness filter (a ccusage id), or `null` for "All". */
  harness: string | null;
  setHarness: (value: string | null) => void;
  /** Opt-in: the next scan fetches LiteLLM's public price list over the
   *  network instead of staying `--offline`. Default `false`. */
  onlinePricing: boolean;
  setOnlinePricing: (value: boolean) => void;
}

/** Persists the Usage screen's Range/Currency/EUR-rate/Bucket/Harness/
 *  online-pricing picks to localStorage (`st:usage:range`,
 *  `st:usage:currency`, `st:usage:eurRate`, `st:usage:bucket`,
 *  `st:usage:harness`, `st:usage:onlinePricing`). Every read and write is
 *  wrapped in try/catch and an invalid stored value falls back to its
 *  default, so a private window, cleared storage, or a hand-edited value
 *  never breaks the screen. */
export function useUsagePrefs(): UsagePrefs {
  const [range, setRangeState] = useState<UsageRange>(readRange);
  const { currency, setCurrency, eurRate, setEurRate, onlinePricing, setOnlinePricing } = useUsagePreferences();
  const [bucket, setBucketState] = useState<ChartBucket | null>(readBucket);
  const [harness, setHarnessState] = useState<string | null>(readHarness);

  const setRange = (value: UsageRange) => {
    if (value === range) return;
    setRangeState(value);
    setBucketState(null);
    try {
      localStorage.setItem(RANGE_KEY, value);
      localStorage.removeItem(BUCKET_KEY);
      localStorage.removeItem(BUCKET_RANGE_KEY);
    } catch {
      /* best-effort persistence only */
    }
  };

  const setBucket = (value: ChartBucket) => {
    setBucketState(value);
    try {
      localStorage.setItem(BUCKET_KEY, value);
      localStorage.setItem(BUCKET_RANGE_KEY, range);
    } catch {
      /* best-effort persistence only */
    }
  };

  const setHarness = (value: string | null) => {
    setHarnessState(value);
    try {
      if (value === null) {
        localStorage.removeItem(HARNESS_KEY);
      } else {
        localStorage.setItem(HARNESS_KEY, value);
      }
    } catch {
      /* best-effort persistence only */
    }
  };

  return {
    range,
    setRange,
    currency,
    setCurrency,
    eurRate,
    setEurRate,
    bucket,
    setBucket,
    harness,
    setHarness,
    onlinePricing,
    setOnlinePricing,
  };
}
