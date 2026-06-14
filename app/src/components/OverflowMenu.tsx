import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

export interface OverflowMenuItem {
  icon?: string;
  label?: string;
  onClick?: () => void;
  /** `variant: "danger"` and the shorthand `danger: true` are equivalent. */
  variant?: "default" | "danger";
  danger?: boolean;
  disabled?: boolean;
  /** Inline keyboard hint rendered at the trailing edge of the item. */
  kbd?: string;
  /** Renders a hairline separator instead of an actionable row. */
  divider?: boolean;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  label?: string;
  align?: "left" | "right";
}

export function OverflowMenu({
  items,
  label = "More actions",
  align = "right",
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="overflow-menu" ref={wrapRef}>
      <Button
        icon="more"
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={open ? "is-open" : undefined}
      />
      {open && (
        <div
          className="overflow-menu-panel"
          data-align={align}
          role="menu"
          aria-label={label}
        >
          {items.map((item, i) =>
            item.divider ? (
              <div key={`divider-${i}`} className="overflow-menu-divider" role="separator" />
            ) : (
              <button
                key={item.label ?? i}
                type="button"
                role="menuitem"
                className={`overflow-menu-item${
                  item.variant === "danger" || item.danger ? " is-danger" : ""
                }`}
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onClick?.();
                }}
              >
                {item.icon && <Icon name={item.icon} size={14} />}
                <span className="overflow-menu-label">{item.label}</span>
                {item.kbd && <Kbd>{item.kbd}</Kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
