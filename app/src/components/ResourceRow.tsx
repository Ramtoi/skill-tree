import { type CSSProperties, type ReactNode } from "react";

export interface ResourceRowProps {
  /** Identity: ScopeBadge / section icon / bundle glyph / emoji. */
  glyph?: ReactNode;
  /** Mono proper-noun identifier (rendered in --font-mono). */
  name: ReactNode;
  /** Inline identifiers after the name (KindTag, source chip, count tags). */
  meta?: ReactNode;
  /** One-line description; truncates before the name does. */
  desc?: ReactNode;
  /** Right-aligned status badges (StatusBadge presets). */
  badges?: ReactNode;
  /** Hover/focus-revealed action buttons. */
  actions?: ReactNode;
  /** Card-only footer row (e.g. source · version). */
  footer?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  /** "row" = full-width list line; "card" = grid tile. */
  layout?: "row" | "card";
  title?: string;
  className?: string;
  /** Extra attrs stamped on the root (e.g. draggable/onDragStart via spread). */
  draggable?: boolean;
  onDragStart?: React.DragEventHandler;
  style?: CSSProperties;
  /** Domain data-* attributes for preset state hooks (e.g. equipped/via/dim). */
  dataset?: Record<string, string | boolean | undefined>;
}

/**
 * The single list-surface anatomy: identity glyph · mono name · inline meta ·
 * one-line desc · right-aligned badges · hover-revealed actions · identity-last
 * truncation. `row` = full-width line, `card` = grid tile. SkillRow/SkillCard
 * are the reference presets (D5); the generic owns no domain logic.
 */
export function ResourceRow({
  glyph,
  name,
  meta,
  desc,
  badges,
  actions,
  footer,
  onClick,
  selected,
  layout = "row",
  title,
  className,
  draggable,
  onDragStart,
  style,
  dataset,
}: ResourceRowProps) {
  const cls = `resource-${layout}${className ? ` ${className}` : ""}`;
  const dataAttrs: Record<string, string> = {};
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      if (v !== undefined && v !== false) dataAttrs[`data-${k}`] = v === true ? "true" : v;
    }
  }
  const inner =
    layout === "card" ? (
      <>
        <div className="resource-cardhead">
          {glyph && <span className="resource-glyph">{glyph}</span>}
          <span className="resource-name" title={title}>
            {name}
          </span>
          {meta}
          {badges && <span className="resource-badges">{badges}</span>}
        </div>
        {desc && <div className="resource-desc">{desc}</div>}
        {footer && <div className="resource-footer">{footer}</div>}
        {actions && <div className="resource-actions">{actions}</div>}
      </>
    ) : (
      <>
        {glyph && <span className="resource-glyph">{glyph}</span>}
        <div className="resource-line">
          <span className="resource-name" title={title}>
            {name}
          </span>
          {meta}
          {desc && <span className="resource-desc">{desc}</span>}
        </div>
        {actions && <div className="resource-actions">{actions}</div>}
        {badges && <span className="resource-badges">{badges}</span>}
      </>
    );

  // A clickable row/card holds its own action buttons, so the container must NOT
  // be a native <button> (invalid nested-button DOM). Use a role="button" div
  // with keyboard activation instead, so nested actions stay valid + focusable.
  return (
    <div
      className={cls}
      data-selected={selected || undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      style={style}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (
                (e.key === "Enter" || e.key === " ") &&
                e.target === e.currentTarget
              ) {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      {...dataAttrs}
    >
      {inner}
    </div>
  );
}

export function ResourceCard(props: Omit<ResourceRowProps, "layout">) {
  return <ResourceRow {...props} layout="card" />;
}
