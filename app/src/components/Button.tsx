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
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Reason a submit/action is unavailable. When set (and `disabled`), the button
   *  stays focusable, exposes `aria-disabled`, surfaces the reason as its title,
   *  and swallows clicks — so the user can discover *why* it is inert. */
  disabledReason?: string;
  title?: string;
  type?: "button" | "submit" | "reset";
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}

export function Button({
  children,
  variant = "ghost",
  size = "md",
  icon,
  leading,
  busy,
  kbd,
  onClick,
  disabled,
  disabledReason,
  title,
  type = "button",
  className,
  style,
  "data-testid": dataTestId,
}: ButtonProps) {
  const cls = `btn btn-${variant} btn-${size}${busy ? " is-loading" : ""}${className ? ` ${className}` : ""}`;
  // Busy hard-disables (its own mutation is in flight); it never soft-disables.
  const effectiveDisabled = !!disabled || !!busy;
  // Soft-disable: keep focusable + expose the reason rather than hard-removing
  // the button from the a11y tree (native `disabled` swallows title tooltips).
  const softDisabled = effectiveDisabled && !!disabledReason && !busy;
  const resolvedTitle = softDisabled ? disabledReason : title;
  const ariaLabel = !children && resolvedTitle ? resolvedTitle : undefined;
  // Busy replaces the icon with the spinner; an explicit `leading` still wins.
  const leadingNode =
    leading ?? (busy ? <Spinner size={size === "sm" ? 12 : 13} color="currentColor" /> : null);
  return (
    <button
      type={type}
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
      style={style}
      data-testid={dataTestId}
    >
      {leadingNode}
      {icon && !busy && <Icon name={icon} size={size === "sm" ? 13 : 14} />}
      {children != null && children !== false && (
        <span className="btn-label">{children}</span>
      )}
      {kbd && <kbd className="kbd-inline">{kbd}</kbd>}
    </button>
  );
}
