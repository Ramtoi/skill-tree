import { type CSSProperties, type ReactNode } from "react";
import type { SourceStatus, SourceView } from "@/types";
import { isExternalSource, sourceAccent } from "@/lib/skillSource";
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
  /** Overrides the chip's accent (dot + frame), ignoring the source's own
   *  identity-hash colour AND its live sync status. Pass `"var(--banner-
   *  accent)"` when the chip sits inside a `Plaque`'s `chip` slot: the
   *  plaque's register (`accent="anchor"` for an external source) is what the
   *  chip must read, never a per-source identity colour or an "update
   *  available" amber that would fight the plaque's own corner ticks
   *  (COMPONENTS.md §Plaque / §Accents). */
  accentOverride?: string;
}

/** Identifier-style chip naming a skill's owning source. Always shows a
 *  status dot so external skills with updates available stand out from local
 *  skills at a glance — unless `accentOverride` is set, in which case the dot
 *  is that fixed accent regardless of status (see `accentOverride`). */
export function SourceChip({
  source,
  compact,
  trailing,
  onClick,
  className,
  style,
  accentOverride,
}: SourceChipProps) {
  const accent = accentOverride ?? sourceAccent(source.id);
  const isExternal = isExternalSource(source);
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
        // A definite box + line-height 1 so the chip's ink is centred on its
        // own border box. Without this the chip inherits the ambient 1.45
        // leading and sits optically low next to the taller header chips
        // (.scope-badge ~21px / .tag ~22px) it shares a row with.
        height: compact ? 18 : 20,
        lineHeight: 1,
        padding: compact ? "0 6px" : "0 8px",
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
      <SourceStatusDot status={accentOverride ? undefined : source.status} accent={accent} />
      {typeIcon && <Icon name={typeIcon} size={compact ? 10 : 11} />}
      <span>{source.name}</span>
      {isExternal && <Icon name="link" size={10} />}
      {trailing}
    </button>
  );
}
