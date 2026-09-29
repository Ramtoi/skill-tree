import { create } from "zustand";
import type { UsageCurrency } from "@/screens/usage/usageFormat";
import { DEFAULT_EUR_RATE, isValidEurRate, readUsagePreferences, writeUsagePreference } from "@/lib/usagePreferences";

interface UsagePreferenceStore {
  currency: UsageCurrency;
  eurRate: number;
  onlinePricing: boolean;
  persistenceError: string | null;
  setCurrency: (currency: UsageCurrency) => void;
  setEurRate: (eurRate: number) => void;
  setOnlinePricing: (onlinePricing: boolean) => void;
}

/** Shared display preferences; screen filters remain local to useUsagePrefs. */
export const useUsagePreferences = create<UsagePreferenceStore>((set) => ({
  ...readUsagePreferences(),
  persistenceError: null,
  setCurrency: (currency) => set({ currency, persistenceError: writeUsagePreference("currency", currency) }),
  setEurRate: (value) => {
    const eurRate = isValidEurRate(value) ? value : DEFAULT_EUR_RATE;
    set({ eurRate, persistenceError: writeUsagePreference("eurRate", eurRate) });
  },
  setOnlinePricing: (onlinePricing) => set({ onlinePricing, persistenceError: writeUsagePreference("onlinePricing", onlinePricing) }),
}));
