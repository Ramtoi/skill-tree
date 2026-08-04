import {
  useCallback,
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
 *
 * The keydown binds on the LIST CONTAINER (focus-scoped), so it never competes
 * with the window-level chord handler and never fires while a filter input
 * outside the list is focused.
 */
export interface ListNavOptions {
  count: number;
  onOpen: (index: number) => void;
  onSecondary?: (index: number) => void;
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

export function useListNav({ count, onOpen, onSecondary }: ListNavOptions): ListNav {
  const [activeIndex, setActive] = useState(0);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);

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
        default:
          break;
      }
    },
    [activeIndex, clamp, count, focusIndex, onOpen, onSecondary],
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
