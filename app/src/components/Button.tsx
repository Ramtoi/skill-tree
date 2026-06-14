import { type CSSProperties, type ReactNode, type MouseEvent } from "react";
import { Icon } from "./Icon";

export type ButtonVariant = "ghost" | "soft" | "primary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  /** Node rendered before the icon/label — used to inject a loading spinner. */
  leading?: ReactNode;
  kbd?: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
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
  kbd,
  onClick,
  disabled,
  title,
  type = "button",
  className,
  style,
  "data-testid": dataTestId,
}: ButtonProps) {
  const cls = `btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`;
  const ariaLabel = !children && title ? title : undefined;
  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={style}
      data-testid={dataTestId}
    >
      {leading}
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 14} />}
      {children != null && children !== false && (
        <span className="btn-label">{children}</span>
      )}
      {kbd && <kbd className="kbd-inline">{kbd}</kbd>}
    </button>
  );
}
