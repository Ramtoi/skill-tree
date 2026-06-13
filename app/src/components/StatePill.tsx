import { type ReactNode } from "react";
import { Icon } from "./Icon";

export type StatePillState = "unsaved" | "readonly" | "saved" | "info";

export interface StatePillProps {
  state: StatePillState;
  /** Optional leading glyph (e.g. `link` for read-only, `check` for saved). */
  icon?: string;
  children: ReactNode;
}

/**
 * Inline mono badge pinned to the right of a screen title, passed through the
 * `state` slot of `<ScreenHeader>`. Informational only.
 *
 *   unsaved  — amber border, "UNSAVED"
 *   readonly — neutral border + link icon, "READ-ONLY"
 *   saved    — green, borderless, "✓ saved"
 *   info     — generic mute
 */
export function StatePill({ state, icon, children }: StatePillProps) {
  return (
    <span className="state-pill" data-state={state}>
      {icon && <Icon name={icon} size={10} />}
      <span>{children}</span>
    </span>
  );
}
