import { type CSSProperties, type ReactNode, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { Spinner } from "./loading/Spinner";

export type ButtonVariant = "ghost" | "soft" | "primary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  /** Node rendered before the icon/label — used to inject a loading spinner. */
  leading?: ReactNode;
  /** While true the button shows a leading spinner (in place of its icon),
   *  disables itself, and exposes `aria-busy` — the one busy affordance every
   *  control uses for its own in-flight mutation. */
  busy?: boolean;
  kbd?: string;
  /** Attention marker rendered inside the button, before the icon/label.
   *  `"dot"` is the macOS-style unsaved dot — the button itself carries the
   *  state instead of a separate pill. Purely additive: it appends
   *  `btn-signal-dot` and changes nothing about the variant/size classes. */
  signal?: "dot";
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Reason a submit/action is unavailable. When set (and `disabled`), the button
   *  stays focusable, exposes `aria-disabled`, surfaces the reason as its title,
   *  and swallows clicks — so the user can discover *why* it is inert. */
  disabledReason?: string;
  title?: string;
  type?: "button" | "submit" | "reset";
  /** Associates a `submit`/`reset` button with a `<form>` elsewhere in the
   *  DOM (e.g. a Sheet footer button submitting a form in the body). */
  form?: string;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  /** Pass-through for a button that opens a menu/popup — the ARIA
   *  menu-button pattern (`aria-haspopup="menu"` + `aria-expanded`). Also
   *  what tells the disclosure guard (`test/helpers/disclosureGuard.ts`)
   *  this is a popup trigger, not a `SidePanelSection` toggle. */
  "aria-haspopup"?: "menu" | "listbox" | "dialog" | "true" | boolean;
  "aria-expanded"?: boolean;
  /** Id of the region this button discloses — paired with `aria-expanded` for
   *  a plain expand/collapse control (not a menu-button; that pattern is
   *  `aria-haspopup` above). */
  "aria-controls"?: string;
  /** Toggle-button state pass-through (e.g. an un-keep affordance). */
  "aria-pressed"?: boolean;
  /** Explicit accessible name override — takes precedence over the
   *  visible-children-vs-title fallback below. For a button whose visible
   *  label must stay short (e.g. shared across several instances) but whose
   *  accessible name needs to disambiguate which one. */
  "aria-label"?: string;
  "aria-describedby"?: string;
}

export function Button({
  children,
  variant = "ghost",
  size = "md",
  icon,
  leading,
  busy,
  kbd,
  signal,
  onClick,
  disabled,
  disabledReason,
  title,
  type = "button",
  form,
  className,
  style,
  "data-testid": dataTestId,
  "aria-haspopup": ariaHasPopup,
  "aria-expanded": ariaExpanded,
  "aria-controls": ariaControls,
  "aria-pressed": ariaPressed,
  "aria-label": ariaLabelProp,
  "aria-describedby": ariaDescribedBy,
}: ButtonProps) {
  // The signal class is appended AFTER the canonical `btn btn-<variant>
  // btn-<size>` shape so the 200+ existing call sites keep their exact prefix.
  const cls = `btn btn-${variant} btn-${size}${busy ? " is-loading" : ""}${
    signal === "dot" ? " btn-signal-dot" : ""
  }${className ? ` ${className}` : ""}`;
  // Busy hard-disables (its own mutation is in flight); it never soft-disables.
  const effectiveDisabled = !!disabled || !!busy;
  // Soft-disable: keep focusable + expose the reason rather than hard-removing
  // the button from the a11y tree (native `disabled` swallows title tooltips).
  const softDisabled = effectiveDisabled && !!disabledReason && !busy;
  const resolvedTitle = softDisabled ? disabledReason : title;
  const ariaLabel =
    ariaLabelProp ?? (!children && resolvedTitle ? resolvedTitle : undefined);
  // Busy replaces the icon with the spinner; an explicit `leading` still wins.
  const leadingNode =
    leading ?? (busy ? <Spinner size={size === "sm" ? 12 : 13} color="currentColor" /> : null);
  return (
    <button
      type={type}
      form={form}
      className={cls}
      onClick={(e) => {
        if (softDisabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      disabled={effectiveDisabled && !softDisabled}
      aria-disabled={softDisabled || undefined}
      aria-busy={busy || undefined}
      title={resolvedTitle}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-pressed={ariaPressed}
      style={style}
      data-testid={dataTestId}
    >
      {signal === "dot" && !busy && (
        <span className="btn-signal" data-signal="dot" aria-hidden="true" />
      )}
      {leadingNode}
      {icon && !busy && <Icon name={icon} size={size === "sm" ? 13 : 14} />}
      {children != null && children !== false && (
        <span className="btn-label">{children}</span>
      )}
      {kbd && <kbd className="kbd-inline">{kbd}</kbd>}
    </button>
  );
}
