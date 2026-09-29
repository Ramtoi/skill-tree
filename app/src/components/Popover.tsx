import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export interface PopoverProps {
  open: boolean;
  /** Hover previews can open without moving keyboard focus. */
  focusOnOpen?: boolean;
  onClose: () => void;
  /** The element the panel hangs from. */
  anchorRef: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  /** Accessible name of the panel (`role="dialog"`). */
  label: string;
  /** Optional fixed panel width. */
  width?: number;
  className?: string;
  children: ReactNode;
}

/** Panel gap from the anchor, and the viewport margin it never crosses —
 *  same constants as `OverflowMenu`. */
const GAP = 6;
const EDGE = 4;

/** An anchored, portalled panel — arbitrary controls hanging off a trigger, as
 *  opposed to `OverflowMenu` (a menu of actions) or `Sheet` (a task with its
 *  own footer). Mechanics copied from `OverflowMenu.tsx` (not imported: that
 *  primitive owns its own trigger button and item list, neither of which a
 *  `Popover` consumer wants). Not modal: no focus trap, no backdrop scrim.
 *  `Tab` moves freely between the panel's own controls; tabbing (or
 *  shift-tabbing) out of BOTH the panel and the anchor closes it — detected
 *  via `focusout`/`relatedTarget` (`onBlur` below), not by treating every
 *  `Tab` keypress as an exit (that used to close the panel after its very
 *  first control). */
export function Popover({
  open,
  focusOnOpen = true,
  onClose,
  anchorRef,
  align = "left",
  label,
  width,
  className,
  children,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorPosition = useRef<{ top: number; left: number } | null>(null);
  // Read inside effects via `.current` so the mousedown/scroll/resize/keydown
  // listeners below never need `onClose` itself in their dep arrays — a
  // fresh `onClose` closure every render (the common case: an inline
  // `() => setX(false)`) would otherwise tear down and resubscribe every
  // listener on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Fixed-position coordinates, measured from the anchor once the portalled
  // panel exists to measure against. Null = "not positioned yet" (rendered
  // invisible for exactly one layout pass, never a visible jump).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    anchorPosition.current = { top: a.top, left: a.left };
    const p = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const spaceBelow = vh - a.bottom;
    const flipUp = spaceBelow < p.height + GAP && a.top > p.height + GAP;
    const preferredTop = flipUp ? a.top - p.height - GAP : a.bottom + GAP;
    const top = Math.max(EDGE, Math.min(preferredTop, vh - p.height - EDGE));
    let left = align === "right" ? a.right - p.width : a.left;
    left = Math.max(EDGE, Math.min(left, vw - p.width - EDGE));
    setPos({ top, left });
  }, [open, align, anchorRef]);

  // On open: focus the first focusable element inside the panel. On close:
  // restore focus to the anchor with `preventScroll`.
  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const id = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); the portalled panel mounted in the SAME commit that flipped `open`, the rAF only defers past its own position measurement.
      first?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open, focusOnOpen]);

  const close = useCallback(
    (restore = true) => {
      onCloseRef.current();
      if (restore && focusOnOpen) {
        // eslint-disable-next-line no-restricted-syntax -- `anchorRef` is the caller's always-mounted anchor element, never a node whose mount depends on this same close; the rAF only sequences after the panel's own unmount.
        requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }));
      }
    },
    [anchorRef, focusOnOpen],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, anchorRef]);

  // A scroll on any ANCESTOR (not the panel's own content — the nested
  // `Select`'s menu calls `scrollIntoView` on its active option, which fires
  // a capture-phase scroll event right here) or a window resize invalidates
  // the measured position; closing is simpler and safer than chasing a
  // moving target.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      // A click can scroll its trigger into view before opening. That queued
      // scroll event already contributed to our measurement; it must not
      // dismiss a panel whose anchor has not moved since then.
      const current = anchorRef.current?.getBoundingClientRect();
      if (current && current.top === anchorPosition.current?.top && current.left === anchorPosition.current?.left) return;
      close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, anchorRef]);

  // `Escape` used to be handled on the panel's own `onKeyDown`, which only
  // ever fired once focus had actually landed inside it — a rAF tick after
  // open, so an Escape pressed in that window (or before the panel ever
  // receives focus, e.g. a screen reader's virtual cursor) was silently
  // swallowed instead. A document-level listener catches it regardless of
  // exactly where focus is, gated to "the key came from inside this
  // popover's own reach" (the panel, the anchor, or a focus-less
  // `document.body`) so an unrelated open popover elsewhere on the page
  // can't be closed by this one's Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as Node | null;
      const insidePanel = !!target && !!panelRef.current?.contains(target);
      const insideAnchor = !!target && !!anchorRef.current?.contains(target);
      const isBody = target === document.body;
      if (focusOnOpen && !insidePanel && !insideAnchor && !isBody) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, anchorRef, close, focusOnOpen]);

  // Tabbing (or shift-tabbing) out of the panel AND the anchor closes it
  // without restoring focus — focus already landed wherever the browser's
  // own tab order sent it, so yanking it back to the anchor would fight the
  // user's own keyboard navigation. A `null` `relatedTarget` means the
  // document itself lost focus (the window blurred — devtools, another app),
  // not a real tab-out, so it's ignored.
  const onPanelBlur = (e: FocusEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related === null) return;
    if (panelRef.current?.contains(related)) return;
    if (anchorRef.current?.contains(related)) return;
    close(false);
  };

  if (!open) return null;

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- `role="dialog"` is not natively interactive, but `onBlur`/focusout is the ONLY reliable "focus left this subtree" signal (a click target check can't tell keyboard tab-out from anything else); the dialog carries no key/click handler of its own.
    <div
      className={`popover-panel${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-label={label}
      ref={panelRef}
      onBlur={onPanelBlur}
      style={{
        ...(width ? { width } : undefined),
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
