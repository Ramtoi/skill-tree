/**
 * The `/` hotkey must focus the screen's search box wherever it lives — the
 * header row OR the subheader. This is the single durable selector, tested
 * directly so the App.tsx keyboard path can't silently regress (A4-F1).
 */
export const SCREEN_SEARCH_SELECTOR =
  "[data-screen-search] input, .main-subheader .search-input input, .main-header .search-input input";

/** Focus the active screen search input. Returns true if one was found. */
export function focusScreenSearch(root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLInputElement>(SCREEN_SEARCH_SELECTOR);
  if (el) {
    el.focus();
    return true;
  }
  return false;
}
