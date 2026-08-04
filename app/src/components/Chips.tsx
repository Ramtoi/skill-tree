import { type ReactNode } from "react";
import { Icon } from "./Icon";

export interface ChipsProps {
  children: ReactNode;
  role?: string;
}

export function Chips({ children, role }: ChipsProps) {
  return (
    <div className="chips" role={role}>
      {children}
    </div>
  );
}

export interface ChipProps {
  pressed?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  title?: string;
  dotColor?: string;
  count?: number | string;
  icon?: string;
  ariaLabel?: string;
}

export function Chip({
  pressed,
  onClick,
  children,
  title,
  dotColor,
  count,
  icon,
  ariaLabel,
}: ChipProps) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {dotColor && (
        <span className="dot" style={{ background: dotColor }} />
      )}
      {icon && <Icon name={icon} size={13} />}
      {children != null && <span className="chip-label">{children}</span>}
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );
}
