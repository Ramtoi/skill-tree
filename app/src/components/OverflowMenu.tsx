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
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Indices of actionable (non-divider, non-disabled) items for roving focus.
  const actionable = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.divider && !it.disabled)
    .map(({ i }) => i);

  const focusItem = (menuIndex: number) => {
    const node = panelRef.current;
    if (!node) return;
    const btns = node.querySelectorAll<HTMLButtonElement>(".overflow-menu-item:not(:disabled)");
    btns[menuIndex]?.focus();
  };

  // On open: focus the first item. On close: restore focus to the trigger.
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => focusItem(0));
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) {
      requestAnimationFrame(() =>
        wrapRef.current?.querySelector<HTMLButtonElement>(":scope > .btn")?.focus(),
      );
    }
  };

  const currentFocusIndex = () => {
    const node = panelRef.current;
    if (!node) return 0;
    const btns = Array.from(node.querySelectorAll<HTMLButtonElement>(".overflow-menu-item:not(:disabled)"));
    return Math.max(0, btns.indexOf(document.activeElement as HTMLButtonElement));
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    const count = actionable.length;
    if (count === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem((currentFocusIndex() + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem((currentFocusIndex() - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(count - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      // Tabbing out dismisses the menu (leaves focus where Tab lands).
      close(false);
    }
  };

  return (
    <div className="overflow-menu" ref={wrapRef}>
      <Button
        icon="more"
        title={label}
        onClick={() => (open ? close() : setOpen(true))}
        className={open ? "is-open" : undefined}
        data-testid="overflow-trigger"
      />
      {open && (
        <div
          className="overflow-menu-panel"
          data-align={align}
          role="menu"
          aria-label={label}
          ref={panelRef}
          onKeyDown={onPanelKey}
        >
          {items.map((item, i) =>
            item.divider ? (
              <div key={`divider-${i}`} className="overflow-menu-divider" role="separator" />
            ) : (
              <button
                key={item.label ?? i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`overflow-menu-item${
                  item.variant === "danger" || item.danger ? " is-danger" : ""
                }`}
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  close();
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
