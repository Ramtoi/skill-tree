import { StatusBadge, type BadgeChannel } from "./StatusBadge";
import {
  INVOCATION_CONFLICTED_TOOLTIP,
  INVOCATION_CONSEQUENCE,
  INVOCATION_LABEL,
  type InvocationValue,
} from "@/lib/invocation";

interface InvocationMeta {
	label: string;
	requestedLabel: string;
  channel: BadgeChannel;
  icon?: string;
  tooltip: string;
}

/** Library deviations stay compact; explicit project overrides also include Auto. */
const INVOCATION_META: Record<InvocationValue | "auto", InvocationMeta> = {
  auto: {
    label: "AUTO",
    requestedLabel: "Auto requested",
    channel: "neutral",
    tooltip: INVOCATION_CONSEQUENCE.auto,
  },
  "user-only": {
    label: "/ ONLY",
	requestedLabel: "User-only requested",
    channel: "info",
    tooltip: INVOCATION_CONSEQUENCE["user-only"],
  },
  "model-only": {
    label: "MODEL",
	requestedLabel: "Model-only requested",
    channel: "neutral",
    tooltip: INVOCATION_CONSEQUENCE["model-only"],
  },
  conflicted: {
    label: "CONFLICT",
	requestedLabel: "Conflict",
    channel: "warn",
    icon: "warning",
    tooltip: INVOCATION_CONFLICTED_TOOLTIP,
  },
};

export interface InvocationBadgeProps {
  /** Registry mirror value; Auto renders only for an explicit requested override. */
	invocation?: string;
	/** Project cards use the explicit wording to distinguish intent from delivery. */
	requested?: boolean;
	className?: string;
}

/**
 * Compact triggering badge — a `StatusBadge` preset (status hues, never brand
 * violet). Renders **nothing** for the `auto` default so only deviations show.
 */
export function InvocationBadge({ invocation, requested, className }: InvocationBadgeProps) {
  if (!invocation || (invocation === "auto" && !requested)) return null;
  const meta = INVOCATION_META[invocation as InvocationValue | "auto"];
  if (!meta) return null;
	const title = requested
		? `${INVOCATION_LABEL[invocation as "auto" | "user-only" | "model-only"] ?? "Conflicted"} requested. ${meta.tooltip}`
		: `${meta.tooltip}${invocation === "conflicted" ? " (contradiction)" : ""}`;
	return (
    <StatusBadge
      channel={meta.channel}
      icon={meta.icon}
	  title={title}
	  className={`invocation-badge${className ? ` ${className}` : ""}`}
	>
	  {requested ? meta.requestedLabel : meta.label}
    </StatusBadge>
  );
}
