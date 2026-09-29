import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/**
 * Reusable roving-focus list navigation (ux-command-layer D6). A hook, not a
 * component, so each list keeps its own row markup. `j`/ArrowDown and
 * `k`/ArrowUp move the active row (roving tabindex), Enter opens it, `e` runs
 * the secondary action (Library: open the equip picker), Home/End jump.
 * `ArrowRight`/`ArrowLeft` both call `onToggleDetail(activeIndex)` — ONE
 * toggle bound to both keys (not an open-vs-close pair), because the hook
 * has no view into the row's own disclosure state; the caller's toggler
 * flips it. This is the keyboard path to a `ResourceRow`'s `detail` panel
 * once its chevron is taken out of the tab order (see `ResourceRow`'s
 * `tabIndex` contract: a roving wrapper owns the stop, so the chevron itself
 * is unreachable by Tab).
 *
 * The keydown binds on the LIST CONTAINER (focus-scoped), so it never competes
 * with the window-level chord handler and never fires while a filter input
 * outside the list is focused.
 */
export interface ListNavOptions {
  count: number;
  onOpen: (index: number) => void;
  onSecondary?: (index: number) => void;
  /** Toggles the active row's `ResourceRow.detail` panel open/closed. Bound
   *  to both `ArrowRight` and `ArrowLeft` (see the hook doc comment above). */
  onToggleDetail?: (index: number) => void;
  /** `Backspace`/`Delete` on the active row — a reversible removal (the
   *  Library's bundle mode: drop a skill from the bundle). Omitted by every
   *  other list, which leaves those keys unhandled. */
  onRemove?: (index: number) => void;
  orientation?: "vertical";
}

export interface ListNav {
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  itemProps: (i: number) => {
    tabIndex: number;
    "aria-selected": boolean;
    "data-listnav-active": boolean;
    ref: (el: HTMLElement | null) => void;
  };
  containerProps: {
    role: "listbox";
    onKeyDown: (e: ReactKeyboardEvent) => void;
  };
}

function isTextTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    node.isContentEditable ||
    node.getAttribute?.("role") === "textbox"
  );
}

export function useListNav({
  count,
  onOpen,
  onSecondary,
  onToggleDetail,
  onRemove,
}: ListNavOptions): ListNav {
  const [activeIndex, setActive] = useState(0);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);

  // A filter/search can shrink the list under the active index. Left alone the
  // index strands past the end: no row carries the roving tabindex, nothing is
  // marked active, and the listbox goes dead until the filter is cleared. Clamp
  // on every count change so the last row picks the focus back up.
  useEffect(() => {
    setActive((i) => (i > count - 1 ? Math.max(0, count - 1) : i));
  }, [count]);

  const focusIndex = useCallback((i: number) => {
    setActive(i);
    // Move DOM focus to the row so the roving tabindex + screen readers track.
    itemsRef.current[i]?.focus();
  }, []);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(i, count - 1)),
    [count],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // Never intercept typing destined for a text field inside the list.
      if (isTextTarget(e.target)) return;
      if (count === 0) return;
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          focusIndex(clamp(activeIndex + 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          focusIndex(clamp(activeIndex - 1));
          break;
        case "Home":
          e.preventDefault();
          focusIndex(0);
          break;
        case "End":
          e.preventDefault();
          focusIndex(count - 1);
          break;
        case "Enter":
          e.preventDefault();
          onOpen(activeIndex);
          break;
        case "e":
          if (onSecondary) {
            e.preventDefault();
            onSecondary(activeIndex);
          }
          break;
        case "ArrowRight":
        case "ArrowLeft":
          if (onToggleDetail) {
            e.preventDefault();
            onToggleDetail(activeIndex);
          }
          break;
        case "Backspace":
        case "Delete":
          if (onRemove) {
            e.preventDefault();
            onRemove(activeIndex);
          }
          break;
        default:
          break;
      }
    },
    [
      activeIndex,
      clamp,
      count,
      focusIndex,
      onOpen,
      onSecondary,
      onToggleDetail,
      onRemove,
    ],
  );

  const itemProps = useCallback(
    (i: number) => ({
      tabIndex: i === activeIndex ? 0 : -1,
      "aria-selected": i === activeIndex,
      "data-listnav-active": i === activeIndex,
      ref: (el: HTMLElement | null) => {
        itemsRef.current[i] = el;
      },
    }),
    [activeIndex],
  );

  const containerProps = useMemo(
    () => ({ role: "listbox" as const, onKeyDown }),
    [onKeyDown],
  );

  return { activeIndex, setActiveIndex: setActive, itemProps, containerProps };
}
