import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { Spinner } from "./loading/Spinner";
import { Toggle } from "./Toggle";

export interface OverflowMenuItem {
  icon?: string;
  label?: string;
  onClick?: () => void;
  /** Skip trigger focus when the action moves focus into another control. */
  restoreFocus?: boolean;
  /** `variant: "danger"` and the shorthand `danger: true` are equivalent. */
  variant?: "default" | "danger";
  danger?: boolean;
  disabled?: boolean;
  /** The row's own live process is in flight: swaps the icon for a spinner,
   *  disables the row and exposes `aria-busy` — the SAME busy grammar as
   *  `<Button busy>`, so a Sync that lives in a menu and a Sync that lives in a
   *  header read identically. */
  busy?: boolean;
  /** Inline keyboard hint rendered at the trailing edge of the item. */
  kbd?: string;
  /** Renders a hairline separator instead of an actionable row. */
  divider?: boolean;
  /** A persistent menu checkbox, styled with the shared switch control. */
  switch?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    busy?: boolean;
    description?: string;
  };
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /** Optional row that opens this same menu on right-click or Shift+F10. */
  contextMenuRef?: RefObject<HTMLElement | null>;
  /** Use only the context target, without rendering a three-dot button. */
  contextMenuOnly?: boolean;
  label?: string;
  align?: "left" | "right";
  /** Trigger size — `"sm"` fits a compact row (matches its sibling row
   *  actions); default `"md"` matches a header/toolbar. */
  triggerSize?: "sm" | "md";
}

/** Panel gap from the trigger, and the viewport margin it never crosses. */
const GAP = 6;
const EDGE = 4;

export function OverflowMenu({
  items,
  contextMenuRef,
  contextMenuOnly = false,
  label = "More actions",
  align = "right",
  triggerSize = "md",
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const contextOriginRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Fixed-position coordinates, measured from the trigger once the portalled
  // panel exists to measure against. Null = "not positioned yet" (rendered
  // invisible for exactly one layout pass, never a visible jump).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The trigger's own rect at open time (finding B: same guard as
  // `Popover.tsx`). Scroll anchoring moves an ancestor's scrollTop without
  // moving the trigger itself; only a real position change should close.
  const anchorPositionRef = useRef<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const target = contextMenuRef?.current;
    if (!target) return;
    const openContext = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      contextOriginRef.current = (event.target as HTMLElement).closest<HTMLElement>("button") ?? target;
      setOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openContext(event);
    };
    target.addEventListener("contextmenu", openContext);
    target.addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("contextmenu", openContext);
      target.removeEventListener("keydown", onKey);
    };
  }, [contextMenuRef]);

  const focusableItems = () => Array.from(
    panelRef.current?.querySelectorAll<HTMLElement>(
      "button.overflow-menu-item:not(:disabled), input[role='menuitemcheckbox']:not(:disabled)",
    ) ?? [],
  );

  const focusItem = (menuIndex: number) => {
    focusableItems()[menuIndex]?.focus();
  };

  // On open: focus the first item. On close: restore focus to the trigger.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); the portalled panel mounted in the SAME commit that flipped `open`, the rAF only defers past the panel's own position measurement.
      const id = requestAnimationFrame(() => focusItem(0));
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Portalled to `document.body` (finding B1: a menu inside a scrolling
  // ancestor — the snippet Applied-to well, or anywhere a future consumer
  // scrolls — was clipped by that ancestor's overflow box, since its
  // `position: absolute` containing block was the scroller itself). Measured
  // from the TRIGGER's rect after the panel has real content to size against,
  // so its width/height are real, not guessed. Flips above the trigger when
  // there is no room below; clamped so it never crosses the viewport edge.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = contextMenuOnly ? contextMenuRef?.current : wrapRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const t = trigger.getBoundingClientRect();
    anchorPositionRef.current = { top: t.top, left: t.left };
    const p = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const spaceBelow = vh - t.bottom;
    const flipUp = spaceBelow < p.height + GAP && t.top > p.height + GAP;
    const top = flipUp ? t.top - p.height - GAP : t.bottom + GAP;
    let left = align === "right" ? t.right - p.width : t.left;
    left = Math.max(EDGE, Math.min(left, vw - p.width - EDGE));
    setPos({ top, left });
  }, [open, align, contextMenuOnly, contextMenuRef]);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) {
      // `preventScroll` — a scroll-triggered close must not itself yank the
      // page back to reveal the trigger while the user is mid-gesture away
      // from it.
      const target = contextOriginRef.current ?? wrapRef.current?.querySelector<HTMLButtonElement>(":scope > .btn");
      // eslint-disable-next-line no-restricted-syntax -- `target` is the always-mounted trigger (or a context-menu origin captured before this close), never a node whose mount depends on this same `close()` call; the rAF only sequences after the panel's own unmount.
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The panel is a `document.body` portal now — a real DOM click inside
      // it never passes `wrapRef.contains`, so without this check every
      // click on a menu item would ALSO read as "outside" and close the
      // menu (via mousedown) before its own onClick (via click) ever fires.
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // A scroll on any ANCESTOR invalidates the measured position — except a
  // scroll targeted inside the panel itself (e.g. a nested `Select`'s
  // `scrollIntoView`) or one where the trigger's own rect hasn't actually
  // moved (scroll anchoring adjusts an ancestor's scrollTop while the
  // trigger stays put, finding B — mirrors `Popover.tsx`'s same guard).
  // Resize always closes: there is no cheap "did the trigger really move"
  // check for it, and a real resize very likely did move things.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      const trigger = contextMenuOnly ? contextMenuRef?.current : wrapRef.current;
      const current = trigger?.getBoundingClientRect();
      if (current && current.top === anchorPositionRef.current?.top && current.left === anchorPositionRef.current?.left) return;
      close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, contextMenuOnly, contextMenuRef]);

  const currentFocusIndex = () => {
    return Math.max(0, focusableItems().indexOf(document.activeElement as HTMLElement));
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const count = focusableItems().length;
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
    } else if (e.key === "Enter" || e.key === " ") {
      // While the panel is open it OWNS the keyboard. Without this, a menu
      // rendered inside a `useListNav` listbox (e.g. a Sources card) loses
      // Enter to the container's handler — which preventDefaults it and acts on
      // the row behind the menu — leaving every menu item keyboard-dead.
      e.stopPropagation();
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.matches(".overflow-menu-item, .overflow-menu-item [role='menuitemcheckbox']")) {
        // Activate here and suppress the browser's own synthesized click, so
        // the item fires exactly once rather than twice.
        if (focused instanceof HTMLInputElement && e.key === " ") return;
        e.preventDefault();
        (focused as HTMLElement).click();
      }
    }
  };

  return (
    <div className="overflow-menu" ref={wrapRef}>
      {!contextMenuOnly && <Button
        icon="more"
        size={triggerSize}
        title={label}
        onClick={() => {
          contextOriginRef.current = null;
          if (open) close();
          else setOpen(true);
        }}
        className={open ? "is-open" : undefined}
        data-testid="overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
      />}
      {open &&
        createPortal(
          <div
            className="overflow-menu-panel"
            data-align={align}
            role="menu"
            aria-label={label}
            ref={panelRef}
            onKeyDown={onPanelKey}
            style={
              pos
                ? { top: pos.top, left: pos.left, visibility: "visible" }
                : { top: 0, left: 0, visibility: "hidden" }
            }
          >
            {items.map((item, i) =>
              item.divider ? (
                <div key={`divider-${i}`} className="overflow-menu-divider" role="separator" />
              ) : item.switch ? (
                <label
                  key={item.label ?? i}
                  className="overflow-menu-item overflow-menu-switch"
                  data-disabled={item.disabled || item.switch.busy || undefined}
                >
                  {item.switch.busy ? (
                    <Spinner size={13} color="currentColor" />
                  ) : item.icon && <Icon name={item.icon} size={14} />}
                  <span className="overflow-menu-label">
                    <span>{item.label}</span>
                    {item.switch.description && <small>{item.switch.description}</small>}
                  </span>
                  <Toggle
                    variant="switch"
                    size="sm"
                    checked={item.switch.checked}
                    onChange={(checked) => {
                      if (!item.disabled && !item.switch?.busy) item.switch?.onChange(checked);
                    }}
                    ariaLabel={item.label}
                    role="menuitemcheckbox"
                    tabIndex={-1}
                    disabled={item.disabled && !item.switch.busy}
                    ariaDisabled={item.disabled || item.switch.busy}
                    ariaBusy={item.switch.busy}
                  />
                </label>
              ) : (
                <button
                  key={item.label ?? i}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`overflow-menu-item${
                    item.variant === "danger" || item.danger ? " is-danger" : ""
                  }`}
                  disabled={item.disabled || item.busy}
                  aria-busy={item.busy || undefined}
                  onClick={() => {
                    if (item.disabled || item.busy) return;
                    close(item.restoreFocus !== false);
                    item.onClick?.();
                  }}
                >
                  {item.busy ? (
                    <Spinner size={13} color="currentColor" />
                  ) : (
                    item.icon && <Icon name={item.icon} size={14} />
                  )}
                  <span className="overflow-menu-label">{item.label}</span>
                  {item.kbd && <Kbd>{item.kbd}</Kbd>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
