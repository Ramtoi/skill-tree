import type { CSSProperties, DragEvent, ReactNode } from "react";
import { Icon } from "./Icon";
import { ResourceCard } from "./ResourceRow";
import { InvocationBadge } from "./InvocationBadge";
import { KindMark, ScopeBadge } from "./Tag";
import { clickSink } from "@/lib/pressable";
import type { LibraryClassificationSummary } from "@/lib/libraryClassification";
import { ClassificationContributions } from "./skillEditor/ClassificationContributions";

export type SkillCardKind = "claude-skill" | "mcp-server" | "SKILL" | "MCP";
export type SkillCardScope =
  | "global"
  | "portable"
  | "project-specific"
  | "project";

export interface SkillCardProps {
  name: string;
  /**
   * A marked-up render of `name` (e.g. matched characters wrapped in
   * `<mark>`) shown in place of the plain string. `title` keeps reading the
   * plain `name` — only the visible glyph changes.
   */
  nameNode?: ReactNode;
  /**
   * A marked-up render of `description`, in place of the plain string. Falls
   * back to `description` when omitted.
   */
  descNode?: ReactNode;
  /** The Library's content-search "why this row matched" line — a body-only
   *  hit's excerpt. Pass-through to `ResourceCard.excerpt`. */
  excerpt?: ReactNode;
  kind?: SkillCardKind;
  scope: SkillCardScope;
  description?: string;
  equipped?: boolean;
  via?: "bundle" | null;
  dim?: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onUnequipped?: () => void;
  equipToggleTitle?: string;
  /** Accessible name for the unequip button (G12) — a bare `title` leaves an
   *  icon-only button's ONLY name generic ("Remove from android" with no
   *  skill named) in a grid of otherwise-identical buttons. Falls back to
   *  `equipToggleTitle`, then "Unequip". */
  equipToggleLabel?: string;
  source?: ReactNode;
  leadingBadge?: ReactNode;
  /** Registry invocation mirror — renders a deviation-only InvocationBadge. */
  invocation?: string;
  /** Per-project triggering override control (workspace cards). Renders
   *  inline in `meta` (always visible), alongside the kind mark and
   *  invocation badge. */
  invocationControl?: ReactNode;
  version?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Passed straight to `ResourceCard.badges` — the library grid's
   * equipped-pip, the loadout's override badge, the bundle grid's linked
   * lock.
   */
  badges?: ReactNode;
  /**
   * Extra hover-revealed action content, rendered in its own `.card-actions`
   * cluster ahead of the unequip ✕.
   */
  actions?: ReactNode;
  /** Second-tier detail body — pass-through to `ResourceCard.detail`. */
  detail?: ReactNode;
  /** Usage trail, rendered as the first footer line. */
  trail?: ReactNode;
  /** Controlled mode pass-through to `ResourceCard` — pass both or neither. */
  detailOpen?: boolean;
  onDetailToggle?: () => void;
  /** Pass-through to `ResourceCard.tabIndex` — `-1` when a roving-list
   *  wrapper (e.g. Library's grid `.lib-nav-row`) owns the one tab stop. */
  tabIndex?: number;
  classification?: LibraryClassificationSummary;
  workingMode?: "inline" | "delegator" | "mixed";
  interactionStyle?: string;
  maturity?: string;
  onClassificationInspect?: (field: "classes" | "outputs", value: string) => void;
}

/**
 * Skill-domain preset of `ResourceCard` (D5). Maps skill identity/provenance
 * onto the shared card anatomy; `invocationControl` renders inline in `meta`
 * (always visible), `actions` and the corner unequip control share one
 * hover-revealed `.card-actions` cluster (COMPONENTS.md §Skill card), and
 * source · version is the card `footer`.
 */
export function SkillCard({
  name,
  nameNode,
  descNode,
  excerpt,
  kind,
  scope,
  description,
  equipped,
  via,
  dim,
  draggable,
  onDragStart,
  onClick,
  onUnequipped,
  equipToggleTitle,
  equipToggleLabel,
  source,
  leadingBadge,
  invocation,
  invocationControl,
  version,
  className,
  style,
  badges,
  actions,
  detail,
  trail,
  detailOpen,
  onDetailToggle,
  tabIndex,
  classification,
  workingMode,
  interactionStyle,
  maturity,
  onClassificationInspect,
}: SkillCardProps) {
  const showSourceRow = source !== undefined || version !== undefined;
  const showFooter = showSourceRow || trail !== undefined;
  const showUnequip = onUnequipped && via !== "bundle";

  return (
    <ResourceCard
      className={`skill-card ${className ?? ""}`.trim()}
      title={name}
      style={style}
      tabIndex={tabIndex}
      draggable={draggable}
      onDragStart={onDragStart as React.DragEventHandler}
      onClick={onClick}
      dataset={{ equipped, via: via || undefined, dim, "has-trail": trail !== undefined }}
      glyph={
        <>
          {leadingBadge}
          <ScopeBadge scope={scope} />
        </>
      }
      name={nameNode ?? name}
      meta={
        <>
          <KindMark kind={kind ?? "SKILL"} />
          {classification?.classes.length ? <span className="skill-classification-compact">{classification.classes.map((item) => item.value).join(" · ")}</span> : null}
          {workingMode && <Icon name={`working-${workingMode}`} size={16} />}
          <InvocationBadge invocation={invocation} />
          {invocationControl}
        </>
      }
      desc={descNode ?? description}
      excerpt={excerpt}
      badges={badges}
      detail={detail ?? (classification && (classification.outputs.length > 0 || interactionStyle || maturity) ? <ClassificationContributions outputs={classification.outputs} interactionStyle={interactionStyle} maturity={maturity} onInspect={onClassificationInspect} /> : undefined)}
      detailOpen={detailOpen}
      onDetailToggle={onDetailToggle}
      footer={
        showFooter ? (
          <>
            {trail}
            {showSourceRow && (
              <span className="skill-card-source-row">
                <span>{source}</span>
                {version !== undefined && <span>v{version}</span>}
              </span>
            )}
          </>
        ) : undefined
      }
      actions={
        actions || showUnequip ? (
          <>
            {actions && (
              <span className="card-actions" {...clickSink()}>
                {actions}
              </span>
            )}
            {showUnequip && (
              <button
                type="button"
                className="equip-toggle"
                title={equipToggleTitle ?? "Unequip"}
                aria-label={equipToggleLabel ?? equipToggleTitle ?? "Unequip"}
                data-testid="skill-card-unequip"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnequipped?.();
                }}
              >
                <Icon name="x" size={11} />
              </button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
