/**
 * The `/` hotkey must focus the screen's search box wherever it lives — the
 * header row OR the subheader. This is the single durable selector, tested
 * directly so the App.tsx keyboard path can't silently regress (A4-F1).
 */
export const SCREEN_SEARCH_SELECTOR =
  "[data-screen-search] input, .main-subheader .search-input input, .main-header .search-input input";

/**
 * True when a keystroke is going into text the user is typing, so a bare-key
 * global hotkey (`/`) must stay out of the way.
 *
 * `isContentEditable` is the load-bearing clause: CodeMirror types into a
 * contenteditable div, NOT a <textarea>. Without it, typing `/` inside any code
 * editor fires the search hotkey and yanks focus mid-keystroke. That stayed
 * latent only while no editor screen had a search slot for `focusScreenSearch`
 * to land on — the hook editor's tool filter is one. `useChords` and
 * `useListNav` already guard identically; this keeps the third handler in step.
 */
export function isTextEntryTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (node.isContentEditable) return true;
  // jsdom does not implement `isContentEditable` (it needs layout), so the
  // property alone cannot be asserted in a unit test. The attribute walk is the
  // testable equivalent AND is strictly more robust: it also catches a keystroke
  // whose target is a DESCENDANT of the editable host.
  return typeof node.closest === "function"
    ? node.closest('[contenteditable="true"], [contenteditable=""]') !== null
    : false;
}

/** Focus the active screen search input. Returns true if one was found. */
export function focusScreenSearch(root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLInputElement>(SCREEN_SEARCH_SELECTOR);
  if (el) {
    el.focus();
    return true;
  }
  return false;
}
