import { type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";

export type TagKind = "soft" | "solid" | "outline";
export type TagSize = "sm" | "md";

export interface TagProps {
  children?: ReactNode;
  color?: string;
  kind?: TagKind;
  size?: TagSize;
  style?: CSSProperties;
  className?: string;
}

export function Tag({
  children,
  color,
  kind = "soft",
  size = "sm",
  style,
  className,
}: TagProps) {
  let computed: CSSProperties;
  if (kind === "solid") {
    computed = {
      background: color ?? "var(--fg)",
      color: "var(--bg-0)",
      border: "0",
    };
  } else if (kind === "outline") {
    computed = {
      background: "transparent",
      color: color ?? "var(--fg-mute)",
      border: `1px solid color-mix(in oklab, ${color ?? "var(--border)"} 50%, transparent)`,
    };
  } else {
    computed = {
      background: `color-mix(in oklab, ${color ?? "var(--fg)"} 14%, transparent)`,
      color: color ?? "var(--fg-mute)",
      border: "0",
    };
  }
  const cls = `tag tag-${size}${className ? ` ${className}` : ""}`;
  return (
    <span className={cls} style={{ ...computed, ...style }}>
      {children}
    </span>
  );
}

export type SkillKindInput = "SKILL" | "MCP" | "claude-skill" | "mcp-server";

export interface KindTagProps {
  kind: SkillKindInput;
}

export function KindTag({ kind }: KindTagProps) {
  const normalized: "SKILL" | "MCP" =
    kind === "MCP" || kind === "mcp-server" ? "MCP" : "SKILL";
  const color = normalized === "MCP" ? "var(--amber)" : "var(--violet)";
  const iconName = normalized === "MCP" ? "mcp" : "skill";
  return (
    <Tag
      color={color}
      style={{
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.05em",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <Icon name={iconName} size={11} />
      {normalized}
    </Tag>
  );
}

export type ScopeInput = "global" | "portable" | "project-specific" | "project";

export type ScopeKey = "global" | "portable" | "project";

export const SCOPE_META: Record<ScopeKey, { label: string; short: string }> = {
  global: { label: "GLOBAL", short: "G" },
  portable: { label: "PORTABLE", short: "P" },
  project: { label: "PROJECT", short: "·" },
};

/** Scope re-framed as *reach* — the full-sentence copy exported for reuse
 *  across the ScopeBadge tooltip, the NewSkillSheet selector, and the editor
 *  scope helper text (design D7). Registry vocabulary is unchanged. */
export const SCOPE_REACH: Record<ScopeKey, string> = {
  global: "Everywhere — active in every project, always on",
  portable: "Per-project — equip it where you need it; reusable across projects",
  project: "Per-project — built for one specific project",
};

/** Portable vs Project carry no mechanical difference — only intent. */
export const SCOPE_INTENT_NOTE =
  "Portable vs Project is an intent label, not a mechanical difference.";

/** Full reach tooltip for a scope: the reach sentence, plus the intent note for
 *  the two per-project scopes so users stop conflating them. */
export function scopeReachTooltip(scope: ScopeInput): string {
  const key = scopeKey(scope);
  return key === "global"
    ? SCOPE_REACH[key]
    : `${SCOPE_REACH[key]}. ${SCOPE_INTENT_NOTE}`;
}

/** Normalize the registry's scope strings to a SCOPE_META key. */
export function scopeKey(scope: ScopeInput): ScopeKey {
  return scope === "project-specific" ? "project" : scope;
}

export interface ScopeBadgeProps {
  scope: ScopeInput;
}

export function ScopeBadge({ scope }: ScopeBadgeProps) {
  const normalized: "global" | "portable" | "project" =
    scope === "project-specific" ? "project" : scope;
  const meta = SCOPE_META[normalized];
  return (
    <span
      className="scope-badge"
      data-scope={normalized}
      title={scopeReachTooltip(scope)}
    >
      {meta.short}
    </span>
  );
}
