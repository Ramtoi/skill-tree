import type { UsageCurrency } from "@/screens/usage/usageFormat";

export const USAGE_PREFERENCE_KEYS = {
  currency: "st:usage:currency",
  eurRate: "st:usage:eurRate",
  onlinePricing: "st:usage:onlinePricing",
} as const;
const CURRENCY_KEY = USAGE_PREFERENCE_KEYS.currency;
const RATE_KEY = USAGE_PREFERENCE_KEYS.eurRate;
const ONLINE_PRICING_KEY = USAGE_PREFERENCE_KEYS.onlinePricing;

/** A reference EUR-per-USD rate, bundled offline — see the plan's currency
 *  note. Editable inline; never fetched over the network. */
export const DEFAULT_EUR_RATE = 0.86;
/** The accepted band. Exported so the rate field's own bounds and the
 *  validator can never drift apart. */
export const EUR_RATE_MIN = 0.1;
export const EUR_RATE_MAX = 5;

function readCurrency(): UsageCurrency {
  try {
    const value = localStorage.getItem(CURRENCY_KEY);
    return value === "EUR" ? "EUR" : "USD";
  } catch {
    return "USD";
  }
}

export function isValidEurRate(value: number): boolean {
  return Number.isFinite(value) && value >= EUR_RATE_MIN && value <= EUR_RATE_MAX;
}

/**
 * Parses a hand-typed rate. `Number.parseFloat` alone accepts a comma
 * decimal's integer head only ("0,9" → 0), so a German keyboard would
 * silently enter 0 — outside the band, and the caller would then fall back to
 * the default. The comma is normalized first, and a value with any trailing
 * junk is refused outright rather than truncated.
 */
export function parseEurRate(raw: string): number | undefined {
  const text = raw.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(text)) return undefined;
  const value = Number.parseFloat(text);
  return isValidEurRate(value) ? value : undefined;
}

function readRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (raw == null) return DEFAULT_EUR_RATE;
    return parseEurRate(raw) ?? DEFAULT_EUR_RATE;
  } catch {
    return DEFAULT_EUR_RATE;
  }
}

/** Opt-in only — absent or corrupt storage reads `false`, the private
 *  default (every scan stays offline). */
function readOnlinePricing(): boolean {
  try {
    return localStorage.getItem(ONLINE_PRICING_KEY) === "true";
  } catch {
    return false;
  }
}

export function readUsagePreferences() {
  return { currency: readCurrency(), eurRate: readRate(), onlinePricing: readOnlinePricing() };
}

export function writeUsagePreference(key: keyof typeof USAGE_PREFERENCE_KEYS, value: string | number | boolean): string | null {
  try {
    localStorage.setItem(USAGE_PREFERENCE_KEYS[key], String(value));
    return null;
  } catch {
    return "Could not save Usage preferences. Changes apply for this session only.";
  }
}
