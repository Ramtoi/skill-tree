import { type ReactNode } from "react";
import { Icon } from "./Icon";

/** Hue register — the three non-brand chroma channels only (never --violet). */
export type BadgeChannel = "ok" | "info" | "warn" | "error" | "neutral";

export interface StatusBadgeProps {
  /** → --green / --blue / --amber / --red / --fg-mid */
  channel: BadgeChannel;
  /** Shape carries the sub-distinction within a channel. */
  shape?: "dot" | "pill" | "ring";
  /** Transitional states use motion, not a stolen hue. Dropped under
   *  prefers-reduced-motion (handled in CSS). */
  motion?: "none" | "pulse";
  icon?: string;
  children?: ReactNode;
  title?: string;
  className?: string;
}

/**
 * The single status-badge base. Every domain badge (StatePill, DriftBadge,
 * RiskBadge, SnippetStatusBadge, …) is a preset that maps its enum to these
 * props. Color is carried by the status channel only — never the brand violet.
 */
export function StatusBadge({
  channel,
  shape = "pill",
  motion = "none",
  icon,
  children,
  title,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={`status-badge${className ? ` ${className}` : ""}`}
      data-channel={channel}
      data-shape={shape}
      data-motion={motion}
      title={title}
    >
      {shape === "dot" ? (
        <span className="status-badge-dot" aria-hidden="true" />
      ) : (
        icon && <Icon name={icon} size={11} />
      )}
      {children != null && <span className="status-badge-label">{children}</span>}
    </span>
  );
}
