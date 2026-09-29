import { forwardRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface ChipsProps {
  children: ReactNode;
  role?: string;
  ariaLabel?: string;
}

export function Chips({ children, role, ariaLabel }: ChipsProps) {
  return (
    <div className="chips" role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export interface ChipProps {
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  title?: string;
  dotColor?: string;
  count?: number | string;
  icon?: string;
  ariaLabel?: string;
  /** Roving-tabindex support for a chip row that manages its own tab stop
   *  (e.g. FloatingSearch's kind row — only the pressed chip is tabbable). */
  tabIndex?: number;
  /** `data-testid` stamped on the underlying <button> — mirrors Toggle's
   *  `dataTestid` convention. */
  dataTestid?: string;
  /** Pass-through for a caller that needs to `preventDefault()` a mousedown
   *  (e.g. FloatingSearch's kind pill, which must not blur its host on
   *  click — see COMPONENTS.md §Chips). */
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

// A one-line `forwardRef`: a caller that anchors a `Popover`/menu to a Chip
// (the Library's Filter chip) needs the real interactive element, not a
// wrapping `<span>` — a non-focusable wrapper silently swallows a
// restore-focus `.focus()` call, stranding focus on `<body>` once the
// anchored panel closes.
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    pressed,
    disabled,
    onClick,
    children,
    title,
    dotColor,
    count,
    icon,
    ariaLabel,
    tabIndex,
    dataTestid,
    onMouseDown,
  },
  ref,
) {
  const inner = (
    <>
      {dotColor && (
        <span className="dot" style={{ background: dotColor }} />
      )}
      {icon && <Icon name={icon} size={13} />}
      {children != null && <span className="chip-label">{children}</span>}
      {count !== undefined && <span className="count">{count}</span>}
    </>
  );
  // A caller with no `onClick` (e.g. a plain wrap-list of named items — the
  // bundle-from-source modal's captured-skills preview) isn't a control:
  // render a non-interactive `<span>` instead of an inert, tab-reachable
  // `<button>` — the way `pressable()` already refuses a bogus `role="button"`
  // for a non-clickable element (REVIEW-B #5). Nothing forwards a ref to this
  // branch today, so the button-typed `ref` simply goes unused here.
  if (!onClick) {
    return (
      <span className="chip" title={title} aria-label={ariaLabel}>
        {inner}
      </span>
    );
  }
  return (
    <button
      ref={ref}
      disabled={disabled}
      type="button"
      className="chip"
      aria-pressed={pressed}
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={title}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      data-testid={dataTestid}
    >
      {inner}
    </button>
  );
});
