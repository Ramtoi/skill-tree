import {
  useLayoutEffect,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { isTextEntryTarget } from "@/lib/focusScreenSearch";
import { useAppStore } from "@/store";

/**
 * Roving tabindex + chord keys for the navigator's row list (spec §3.1).
 * Binds on `.side-scroll` (focus-scoped, mirrors `useListNav` — never
 * competes with a screen's own list nav or the window-level chord handler).
 *
 * `narrow` disambiguates Escape: docked it focuses `.app-main`; narrow it is a
 * no-op here because `main` is `inert` while the drawer is open and App.tsx's
 * own window handler + focus-return effect already own that path.
 *
 * `locationKey` (`pathname + search`) drives the focus-RETURN effect: when an
 * activated row swaps the whole panel body (its own button unmounts) focus
 * drops to `<body>`; if focus was inside the panel just before that, it is
 * handed back to the new tabindex-0 row rather than stranded.
 */
export function useSideNav({
  narrow,
  locationKey,
}: {
  narrow: boolean;
  locationKey: string;
}): {
  scrollRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const focusWasInPanel = useRef(false);

  // ── Roving tabindex — recomputed after EVERY render, so a route change, a
  // filter narrowing the list, or a group collapsing all keep exactly one row
  // tabbable. Order matters: this must commit BEFORE the focus-return effect
  // below queries `[tabindex="0"]`. ──────────────────────────────────────────
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-side-row]"),
    );
    if (rows.length === 0) return;
    const current = rows.find((r) => {
      const v = r.getAttribute("aria-current");
      return v === "true" || v === "page";
    });
    const target = current ?? rows[0];
    for (const row of rows) {
      row.tabIndex = row === target ? 0 : -1;
    }
  });

  // Track whether focus lives inside the panel — mirrors App.tsx's own
  // `focusWasInNav` (App.tsx:180-188): recomputed on every document focusin,
  // so it covers both "moved in" and "moved out" without relying on
  // `focusout`'s `relatedTarget` (unreliable across browsers/jsdom).
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const node = e.target as Node | null;
      focusWasInPanel.current = !!node && !!scrollRef.current?.contains(node);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // ── Focus return after activation (M5) ────────────────────────────────────
  useLayoutEffect(() => {
    if (!focusWasInPanel.current) return;
    if (document.activeElement !== document.body) return;
    const container = scrollRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>('[data-side-row][tabindex="0"]');
    row?.focus();
  }, [locationKey]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // ⌘K (and any other modifier chord) must not also move panel focus.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextEntryTarget(e.target)) return;
    // A chord prefix is pending (e.g. the `g` of `g p`) — the second key
    // belongs to `useChords`'s window listener, not the panel's own single-key
    // bindings (M-2: `g p` / `g k` must not also pin / move the roving ring).
    if (useAppStore.getState().chordPending !== null) return;

    const container = scrollRef.current;
    if (!container) return;

    if (e.key === "/") {
      const input = container.querySelector<HTMLInputElement>(".side-filter input");
      if (input) {
        e.preventDefault();
        e.stopPropagation();
        input.focus();
      }
      // No filter present: let the key bubble to the global `/` handler.
      return;
    }

    if (e.key === "Escape") {
      // Event is deliberately NOT stopped — App.tsx's own Escape handling
      // (palette / drawer close) still runs.
      if (!narrow) {
        document.querySelector<HTMLElement>(".app-main")?.focus();
      }
      return;
    }

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-side-row]"));
    if (rows.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? rows.indexOf(active) : -1;

    switch (e.key) {
      case "ArrowDown":
      case "j": {
        e.preventDefault();
        rows[idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)]?.focus();
        break;
      }
      case "ArrowUp":
      case "k": {
        e.preventDefault();
        rows[idx < 0 ? 0 : Math.max(idx - 1, 0)]?.focus();
        break;
      }
      case "Home": {
        e.preventDefault();
        rows[0]?.focus();
        break;
      }
      case "End": {
        e.preventDefault();
        rows[rows.length - 1]?.focus();
        break;
      }
      case "p": {
        if (idx < 0) break;
        e.preventDefault();
        const pin = rows[idx].parentElement?.querySelector<HTMLElement>(".side-item-pin");
        pin?.click();
        break;
      }
      default:
        break;
      // Enter: native button activation — no handler needed.
    }
  }

  return { scrollRef, onKeyDown };
}
