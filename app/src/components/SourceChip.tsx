import { type CSSProperties, type ReactNode } from "react";
import type { SourceStatus, SourceView } from "@/types";
import { sourceAccent } from "@/lib/skillSource";
import { Icon } from "./Icon";

export interface SourceStatusDotProps {
  status: SourceStatus | undefined;
  accent?: string;
  title?: string;
}

/** Small colored dot used in source chips and source cards to convey state at
 *  a glance. Matches the prototype's traffic-light vocabulary. */
export function SourceStatusDot({ status, accent, title }: SourceStatusDotProps) {
  const fill = (() => {
    switch (status) {
      case "update-available":
        return "var(--amber)";
      case "error":
        return "var(--red)";
      case "syncing":
        return "var(--blue)";
      case "up-to-date":
        return "var(--green)";
      default:
        return accent ?? "var(--fg-mute)";
    }
  })();
  return (
    <span
      className="source-status-dot"
      title={title}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 8,
        background: fill,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

export interface SourceChipProps {
  source: Pick<SourceView, "id" | "name" | "type" | "status">;
  compact?: boolean;
  /** Optional trailing node (e.g., a count). */
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}

/** Identifier-style chip naming a skill's owning source. Always shows a
 *  status dot so external skills with updates available stand out from local
 *  skills at a glance. */
export function SourceChip({
  source,
  compact,
  trailing,
  onClick,
  className,
  style,
}: SourceChipProps) {
  const accent = sourceAccent(source.id);
  const isExternal = source.type === "git" || source.type === "litellm";
  const cls = `source-chip${compact ? " source-chip-sm" : ""}${className ? ` ${className}` : ""}`;
  const typeIcon = (() => {
    switch (source.type) {
      case "git": return "source.git";
      case "starter": return "source.starter";
      case "litellm": return "source.litellm";
      case "local": return "source.local";
      default: return null;
    }
  })();
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      data-source={source.id}
      data-source-type={source.type}
      title={`Source: ${source.name}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: compact ? "1px 6px" : "2px 8px",
        background: `color-mix(in oklab, ${accent} 14%, transparent)`,
        color: `color-mix(in oklab, ${accent} 70%, var(--fg))`,
        border: `1px solid color-mix(in oklab, ${accent} 30%, transparent)`,
        borderRadius: "var(--radius-sm, 4px)",
        fontFamily: "var(--font-mono)",
        fontSize: compact ? 10 : 11,
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      <SourceStatusDot status={source.status} accent={accent} />
      {typeIcon && <Icon name={typeIcon} size={compact ? 10 : 11} />}
      <span>{source.name}</span>
      {isExternal && <Icon name="link" size={10} />}
      {trailing}
    </button>
  );
}
