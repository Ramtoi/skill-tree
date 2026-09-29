import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import type { UsageWindow } from "@/features/usage/usageAnalyticsTypes";

const OPTIONS: readonly ChipRadioOption<"7" | "30" | "90">[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export interface UsageWindowSelectorProps {
  window: UsageWindow;
  onChange: (value: UsageWindow) => void;
}

/**
 * The 7/30/90-day `ChipRadios` for the usage drill-down. Rendered by the
 * ROUTE's `ScreenHeader` subheader only — never by `UsageProjectArea` itself
 * (design D14.6, G15): the chrome owns the control, exactly once, so wave
 * 3's project chrome can supply its own over the same shared
 * `useUsageWindow()` state without a surface ever rendering two selectors.
 */
export function UsageWindowSelector({ window, onChange }: UsageWindowSelectorProps) {
  return (
    <ChipRadios
      name="usage-window"
      label="Window"
      value={String(window) as "7" | "30" | "90"}
      options={OPTIONS}
      onChange={(value) => onChange(Number(value) as UsageWindow)}
    />
  );
}
