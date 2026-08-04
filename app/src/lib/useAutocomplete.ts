import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

/**
 * Headless combobox behaviour shared by the fields that cross-reference existing
 * registry data as you type (snippet tags, permission Bash patterns). It filters
 * a candidate pool by the current query, ranks prefix matches first, and owns
 * keyboard nav + an active-row cursor. It renders nothing — pair it with
 * `SuggestionDropdown` for the visual list.
 *
 * The active row defaults to -1 (no selection) and resets on every query change,
 * so a plain Enter falls through to the caller (e.g. TagInput adds the typed
 * draft verbatim); Enter only commits a suggestion once the user has arrowed
 * into the list. `handleKeyDown` returns whether it consumed the key so callers
 * can early-return.
 */

export interface UseAutocompleteParams {
  /** Current text in the field. */
  query: string;
  /** Full candidate pool. De-duped and emptied internally. */
  items: string[];
  /** Commit a suggestion (click / Enter-on-active / Tab-on-active). */
  onPick: (item: string) => void;
  /** Max rows shown. Default 8. */
  limit?: number;
}

export interface Autocomplete {
  /** User intent to show the menu (focus opens, blur/Esc/pick closes). */
  open: boolean;
  /** Filtered, ranked, limited suggestions. */
  matches: string[];
  /** Index into `matches`, or -1 for "no active row". */
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  show: () => void;
  hide: () => void;
  pick: (item: string) => void;
  /** Wire to the field's onKeyDown. Returns true when the key was consumed. */
  handleKeyDown: (e: KeyboardEvent) => boolean;
}

export function useAutocomplete({
  query,
  items,
  onPick,
  limit = 8,
}: UseAutocompleteParams): Autocomplete {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const prefix: string[] = [];
    const infix: string[] = [];
    for (const raw of items) {
      const item = raw.trim();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      const lower = item.toLowerCase();
      // Nothing to complete when the field already equals a candidate exactly.
      if (lower === q) continue;
      if (!q) {
        prefix.push(item);
      } else if (lower.startsWith(q)) {
        prefix.push(item);
      } else if (lower.includes(q)) {
        infix.push(item);
      }
    }
    return [...prefix, ...infix].slice(0, limit);
  }, [query, items, limit]);

  // A fresh query means the old active row is meaningless — reset to "none" so
  // Enter falls through to the caller until the user deliberately arrows in.
  useEffect(() => setActiveIndex(-1), [query]);

  const pick = (item: string) => {
    onPick(item);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (matches.length === 0) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => (i + 1) % matches.length);
        return true;
      case "ArrowUp":
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
        return true;
      case "Enter":
      case "Tab":
        if (open && activeIndex >= 0 && activeIndex < matches.length) {
          e.preventDefault();
          pick(matches[activeIndex]);
          return true;
        }
        return false;
      case "Escape":
        if (open) {
          setOpen(false);
          setActiveIndex(-1);
          return true;
        }
        return false;
      default:
        return false;
    }
  };

  return {
    open,
    matches,
    activeIndex,
    setActiveIndex,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    pick,
    handleKeyDown,
  };
}
