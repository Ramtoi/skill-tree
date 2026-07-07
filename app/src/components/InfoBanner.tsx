import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  children: ReactNode;
  /** Leading icon (default "warning"). Always rendered in the blue tone. */
  icon?: string;
  /** Extra class(es) for spacing/layout tweaks per caller. */
  className?: string;
  /** Inline style for per-caller margin (the visual look lives in the class). */
  style?: CSSProperties;
}

/** The one blue info/status banner: a blue-bordered card with a blue icon +
 *  message. `role="status"` so it's announced (a non-blocking heads-up, not an
 *  alert). Shared by the bootstrap "no harness installed" and Harnesses "no
 *  active harness" notices — see App.css `.info-banner`. */
export function InfoBanner({ children, icon = "warning", className, style }: Props) {
  return (
    <div
      className={className ? `info-banner ${className}` : "info-banner"}
      role="status"
      style={style}
    >
      <Icon name={icon} size={14} tone="blue" className="info-banner-icon" />
      <span>{children}</span>
    </div>
  );
}
