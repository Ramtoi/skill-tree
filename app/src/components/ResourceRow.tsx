import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

export interface ResourceRowProps {
  /** Identity: ScopeBadge / section icon / bundle glyph / emoji. */
  glyph?: ReactNode;
  /** Mono proper-noun identifier (rendered in --font-mono). */
  name: ReactNode;
  /** Inline identifiers after the name (KindTag, source chip, count tags). */
  meta?: ReactNode;
  /** One-line description; truncates before the name does. */
  desc?: ReactNode;
  /**
   * A one-line "why this row matched" note under the row's main line — the
   * Library's content-search excerpt. Spans the full width at `grid-row: 2`,
   * ahead of the disclosure panel (which moves to `grid-row: 3`). A row
   * without one is byte-identical to before (the implicit track collapses to
   * zero height).
   */
  excerpt?: ReactNode;
  /** Right-aligned status badges (StatusBadge presets). */
  badges?: ReactNode;
  /** Hover/focus-revealed action buttons. */
  actions?: ReactNode;
  /** Card-only footer row (e.g. source · version). */
  footer?: ReactNode;
  /**
   * Second-tier facts behind the one disclosure idiom (COMPONENTS.md §Resource
   * row / card). Renders a chevron button + an expandable panel spanning the
   * row's full width. A row given `detail` must also pass `ariaLabel` — the
   * root is a `role="button"` div, so without an explicit name the chevron's
   * own "Show … details" label folds into the row's accessible name.
   */
  detail?: ReactNode;
  /**
   * Controlled mode: pass BOTH to lift the open state (e.g. ProjectWorkspace
   * owns `expandedAvailable`). Omit both for uncontrolled (the row manages its
   * own open state). Passing exactly one of the pair falls back to
   * uncontrolled and logs a dev warning.
   */
  detailOpen?: boolean;
  onDetailToggle?: () => void;
  /** Chevron `title`/`aria-label` verb. Default: `Show details` / `Hide details`. */
  detailLabel?: string;
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
  /**
   * ARIA role override for the root. Defaults to `onClick ? "button" :
   * undefined`. Needed so a row can be a `menuitem` inside a `menu`, or an
   * `option` inside a `listbox` without inventing a second row shape.
   */
  role?: string;
  /** Root `aria-label` — required on any row that also passes `detail` (see above). */
  ariaLabel?: string;
  /** Root `aria-busy`. */
  ariaBusy?: boolean;
  /**
   * Root `tabIndex` override. Defaults to `onClick ? 0 : undefined`. Roving
   * list nav rides a wrapper div (not this root) — pass `tabIndex={-1}` to
   * take a row out of the tab order when a wrapper owns the roving stop.
   * A negative value IS forwarded to the disclosure chevron too: in a
   * roving list the wrapper is the only tab stop, so the chevron must drop
   * out of the tab order alongside the row root (reach it instead via the
   * list's `ArrowRight`/`ArrowLeft` — see `useListNav`'s `onToggleDetail`).
   * Omit `tabIndex` (or pass `0`) and the chevron keeps its own default tab
   * stop, since the disclosure is then a different action from the row's own
   * click and earns its own stop.
   */
  tabIndex?: number;
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
  excerpt,
  badges,
  actions,
  footer,
  detail,
  detailOpen,
  onDetailToggle,
  detailLabel,
  onClick,
  selected,
  layout = "row",
  title,
  className,
  draggable,
  onDragStart,
  style,
  dataset,
  role,
  ariaLabel,
  ariaBusy,
  tabIndex,
}: ResourceRowProps) {
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = detailOpen !== undefined && onDetailToggle !== undefined;
  const open = controlled ? detailOpen : selfOpen;
  const toggle = controlled ? onDetailToggle! : () => setSelfOpen((v) => !v);
  const detailId = useId();
  const excerptId = useId();

  const halfControlled =
    (detailOpen !== undefined) !== (onDetailToggle !== undefined);
  useEffect(() => {
    if (import.meta.env.DEV && halfControlled) {
      console.warn(
        "ResourceRow: pass BOTH detailOpen and onDetailToggle to control the " +
          "disclosure, or neither. Got one — falling back to uncontrolled.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per
    // mis-wiring, not once per render: only the pairing itself matters.
  }, [halfControlled]);

  const cls = `resource-${layout}${className ? ` ${className}` : ""}`;
  const dataAttrs: Record<string, string> = {};
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      if (v !== undefined && v !== false) dataAttrs[`data-${k}`] = v === true ? "true" : v;
    }
  }

  const effectiveRole = role ?? (onClick ? "button" : undefined);
  const effectiveTabIndex =
    tabIndex !== undefined ? tabIndex : onClick ? 0 : undefined;
  // The disclosure follows the row's OWN tab stop when the caller takes the
  // row out of the tab order (roving list nav owns a wrapper stop instead) —
  // otherwise it keeps its own default tab stop, since it is then a
  // different action from the row's own click and earns its own stop.
  const chevronTabIndex =
    tabIndex !== undefined && tabIndex < 0 ? tabIndex : undefined;

  const disclosureButton = detail ? (
    <button
      type="button"
      className="resource-disclosure"
      aria-expanded={open}
      aria-controls={open ? detailId : undefined}
      aria-label={`${open ? "Hide" : "Show"} ${detailLabel ?? "details"}`}
      title={`${open ? "Hide" : "Show"} ${detailLabel ?? "details"}`}
      tabIndex={chevronTabIndex}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e) => {
        // A roving-list container (e.g. useListNav) binds its own Enter/
        // Space handling on the LIST, not the row — left to bubble, Enter
        // here would both toggle the chevron (native click) AND fire the
        // container's onOpen/onSecondary for the row underneath. Every
        // other key (Tab, Arrow*, Escape, …) bubbles normally.
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
    >
      <Icon name="chevronDown" size={12} />
    </button>
  ) : null;
  const detailPanel =
    detail && open ? (
      <div className="resource-detail" id={detailId}>
        {detail}
      </div>
    ) : null;

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
          {disclosureButton}
        </div>
        {desc && <div className="resource-desc">{desc}</div>}
        {excerpt && (
          <div className="resource-excerpt" id={excerptId}>
            {excerpt}
          </div>
        )}
        {detailPanel}
        {footer && <div className="resource-footer">{footer}</div>}
        {actions && <div className="resource-actions">{actions}</div>}
      </>
    ) : (
      <>
        <span className="resource-glyph">{glyph}</span>
        <div className="resource-line">
          <span className="resource-name" title={title}>
            {name}
          </span>
          {meta}
          {desc && <span className="resource-desc">{desc}</span>}
        </div>
        {excerpt && (
          <div className="resource-excerpt" id={excerptId}>
            {excerpt}
          </div>
        )}
        <div className="resource-actions">{actions}</div>
        <span className="resource-badges">{badges}</span>
        {disclosureButton}
        {detailPanel}
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
      role={effectiveRole}
      tabIndex={effectiveTabIndex}
      aria-label={ariaLabel}
      aria-describedby={excerpt ? excerptId : undefined}
      aria-busy={ariaBusy || undefined}
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
