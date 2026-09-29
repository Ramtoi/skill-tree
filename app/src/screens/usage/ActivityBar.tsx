import type { ReactNode } from "react";
import { CompositionBar, type Segment } from "@/components/charts/CompositionBar";
import { identityColor } from "@/components/charts/chartColors";
import type {
  UsageActivityClass,
  UsageActivityCounts,
} from "@/features/usage/usageAnalyticsTypes";

export interface ActivityBarProps {
  activity: UsageActivityCounts;
  ariaLabel: string;
  /** Rendered under the bar — e.g. the all-projects median or the thinking
   *  share caption a caller needs beside the mix (design D14.6/D14.7). */
  note?: ReactNode;
}

/** Fixed class → identity-ramp index (design D14.9, G20). The index is a
 *  property of the CLASS, never of its rank in the bar on screen — a class
 *  dropping to zero must not re-hue every class that follows it. Seven
 *  classes into the eight-slot `--id-0..7` ramp: no fold, no collision. */
export const ACTIVITY_COLOR_INDEX: Record<UsageActivityClass, number> = {
  read: 0,
  edit: 1,
  verify: 2,
  operate: 3,
  delegate: 4,
  skill: 5,
  external: 6,
};

/** Render order — also the order the color-index table above documents. */
const ACTIVITY_ORDER: readonly UsageActivityClass[] = [
  "read",
  "edit",
  "verify",
  "operate",
  "delegate",
  "skill",
  "external",
];

function activityLabel(cls: UsageActivityClass): string {
  return cls.charAt(0).toUpperCase() + cls.slice(1);
}

/** A plain, honest number for the legend value column — this bar renders
 *  both integer event counts (a session's `summary.activity`, design D14.7's
 *  "exact counts") and [0,1] fractional shares (a project's
 *  `outcomes.activity`, design D14.6) depending on the caller, so the
 *  formatter must not assume either shape. */
function formatActivityValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

/**
 * A thin `CompositionBar` wrapper for the activity-mix segments (design
 * D14.9). Lives in `screens/usage/`, not `components/`, for the same reason
 * `TokenCompositionBars.tsx` does: it encodes ONE screen family's fixed
 * segment order, not a general primitive.
 *
 * Zero-count classes are dropped from the array passed to `CompositionBar`
 * — the bar itself already skips a zero-value segment when drawing the
 * stacked strip, but its legend renders every segment it is GIVEN, so
 * dropping here is what keeps the strip and the legend agreeing about which
 * classes exist. The color index is looked up from the fixed
 * `ACTIVITY_COLOR_INDEX` table, never from the filtered array's own
 * position, so a color can never mean two different things.
 */
export function ActivityBar({ activity, ariaLabel, note }: ActivityBarProps) {
  const segments: Segment[] = ACTIVITY_ORDER.filter((cls) => activity[cls] > 0).map((cls) => ({
    id: cls,
    label: activityLabel(cls),
    value: activity[cls],
    color: identityColor(ACTIVITY_COLOR_INDEX[cls]),
  }));

  return (
    <div className="usage-activity-bar">
      <CompositionBar segments={segments} format={formatActivityValue} ariaLabel={ariaLabel} />
      {note}
    </div>
  );
}
