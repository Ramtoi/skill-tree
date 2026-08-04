import { type ReactNode } from "react";
import { StatusBadge, type BadgeChannel } from "./StatusBadge";

export type StatePillState = "unsaved" | "readonly" | "saved" | "info";

export interface StatePillProps {
  state: StatePillState;
  /** Optional leading glyph (e.g. `link` for read-only, `check` for saved). */
  icon?: string;
  children: ReactNode;
}

/** Domain enum → StatusBadge channel (never brand violet). */
const STATE_PILL_CHANNEL: Record<StatePillState, BadgeChannel> = {
  unsaved: "warn",
  readonly: "neutral",
  saved: "ok",
  info: "neutral",
};

/**
 * Inline mono status badge pinned to the right of a screen title, passed
 * through the `state` slot of `<ScreenHeader>`. Informational only — now a thin
 * preset of the shared `StatusBadge` base.
 *
 *   unsaved  — amber, "UNSAVED"
 *   readonly — neutral + link icon, "READ-ONLY"
 *   saved    — green, "✓ saved"
 *   info     — generic mute
 */
export function StatePill({ state, icon, children }: StatePillProps) {
  return (
    <StatusBadge
      channel={STATE_PILL_CHANNEL[state]}
      icon={icon}
      className={`state-pill state-pill-${state}`}
    >
      {children}
    </StatusBadge>
  );
}
