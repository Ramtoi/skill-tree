import { StatusBadge, type BadgeChannel } from "./StatusBadge";
import {
  INVOCATION_CONFLICTED_TOOLTIP,
  INVOCATION_CONSEQUENCE,
  type InvocationValue,
} from "@/lib/invocation";

interface InvocationMeta {
  label: string;
  channel: BadgeChannel;
  icon?: string;
  tooltip: string;
}

/** Deviation states only — `auto` renders nothing (keeps rows quiet, D7). */
const INVOCATION_META: Record<InvocationValue, InvocationMeta> = {
  "user-only": {
    label: "/ ONLY",
    channel: "info",
    tooltip: INVOCATION_CONSEQUENCE["user-only"],
  },
  "model-only": {
    label: "MODEL",
    channel: "neutral",
    tooltip: INVOCATION_CONSEQUENCE["model-only"],
  },
  conflicted: {
    label: "CONFLICT",
    channel: "warn",
    icon: "warning",
    tooltip: INVOCATION_CONFLICTED_TOOLTIP,
  },
};

export interface InvocationBadgeProps {
  /** Registry mirror value; absent / "auto" render nothing. */
  invocation?: string;
}

/**
 * Compact triggering badge — a `StatusBadge` preset (status hues, never brand
 * violet). Renders **nothing** for the `auto` default so only deviations show.
 */
export function InvocationBadge({ invocation }: InvocationBadgeProps) {
  if (!invocation || invocation === "auto") return null;
  const meta = INVOCATION_META[invocation as InvocationValue];
  if (!meta) return null;
  return (
    <StatusBadge
      channel={meta.channel}
      icon={meta.icon}
      title={meta.tooltip}
      className="invocation-badge"
    >
      {meta.label}
    </StatusBadge>
  );
}
