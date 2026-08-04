import { type CSSProperties } from "react";
import { ICONS } from "./icons";

export type IconTone =
  | "violet"
  | "amber"
  | "green"
  | "red"
  | "blue"
  | "cyan"
  | "mute"
  | "dim"
  | "strong";

const TONE_VAR: Record<IconTone, string> = {
  violet: "var(--violet-2)",
  amber: "var(--amber)",
  green: "var(--green)",
  red: "var(--red)",
  blue: "var(--blue)",
  cyan: "var(--cyan)",
  mute: "var(--fg-mute)",
  dim: "var(--fg-dim)",
  strong: "var(--fg-strong)",
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  tone?: IconTone;
}

export function Icon({ name, size = 16, className, style, title, tone }: IconProps) {
  const body = ICONS[name] ?? ICONS[name.toLowerCase()];
  if (!body) return null;
  const mergedStyle: CSSProperties = {
    ...(tone ? { color: TONE_VAR[tone] } : null),
    ...style,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={mergedStyle}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {body}
    </svg>
  );
}
