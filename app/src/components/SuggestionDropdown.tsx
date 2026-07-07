import { type ReactNode } from "react";
import type { Autocomplete } from "@/lib/useAutocomplete";

export interface SuggestionDropdownProps {
  ac: Autocomplete;
  /** Optional custom row rendering (e.g. highlight the matched substring). */
  renderItem?: (item: string, active: boolean) => ReactNode;
  /** Accessible label for the listbox. */
  label?: string;
}

/**
 * Presentational suggestion list for `useAutocomplete`. Render it as the last
 * child of a `position: relative` wrapper directly after the field; it absolutely
 * positions itself beneath. `onMouseDown` preventDefault keeps the field focused
 * so the click commits before a blur can close the menu.
 */
export function SuggestionDropdown({
  ac,
  renderItem,
  label = "Suggestions",
}: SuggestionDropdownProps) {
  if (!ac.open || ac.matches.length === 0) return null;
  return (
    <ul className="autocomplete-menu" role="listbox" aria-label={label}>
      {ac.matches.map((item, i) => {
        const active = i === ac.activeIndex;
        return (
          <li
            key={item}
            role="option"
            aria-selected={active}
            className="autocomplete-item"
            data-active={active ? "" : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              ac.pick(item);
            }}
            onMouseEnter={() => ac.setActiveIndex(i)}
          >
            {renderItem ? renderItem(item, active) : item}
          </li>
        );
      })}
    </ul>
  );
}
