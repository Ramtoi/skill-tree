import { useEffect } from "react";

/**
 * Skill Tree is a developer tool. Skill names, paths, glob patterns, Bash
 * prefixes, ssh hosts, and version strings are typed with intention — so the
 * macOS/WebKit text-assist behaviours (autocorrect capitalising the leading
 * word, substituting "words", and the red spellcheck squiggle) only ever get in
 * the way, e.g. force-uppercasing a lowercase-only skill slug mid-type.
 *
 * WebKit (the engine behind Tauri's macOS WKWebView) reads three per-element
 * attributes for this: `autocorrect`, `autocapitalize`, and `spellcheck`.
 * Rather than remember them at ~60 call sites — and miss every future input —
 * we disable all three on every text `<input>`/`<textarea>` from one place and
 * keep them disabled as the DOM changes (route swaps, portaled modals/sheets,
 * dynamically added rows).
 *
 * Opt a field back in with `data-native-assist="true"` (e.g. a long-form prose
 * field where a spellcheck squiggle is welcome). Checkboxes, radios, and other
 * non-text input types are left untouched.
 */

/** Input `type`s that carry free text a user might want assisted (and we don't). */
const TEXTUAL_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
]);

function isManagedField(
  el: Element,
): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    return TEXTUAL_INPUT_TYPES.has(type);
  }
  return false;
}

/** Set the three WebKit assist attributes off, unless the field opts back in. */
function disableAssist(el: HTMLInputElement | HTMLTextAreaElement): void {
  if (el.dataset.nativeAssist === "true") return;
  // setAttribute keeps these outside React's controlled-prop bookkeeping, so a
  // re-render never clobbers them (React only manages attributes it renders).
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("spellcheck", "false");
}

/** Apply to a node and any managed descendants it brought along. */
function sweep(node: Node): void {
  if (!(node instanceof Element)) return;
  if (isManagedField(node)) disableAssist(node);
  node
    .querySelectorAll?.("input, textarea")
    .forEach((el) => isManagedField(el) && disableAssist(el));
}

/**
 * Mount once near the app root. Disables native text-assist on every current
 * text field and on any added later. Observes `document.documentElement` so
 * portaled overlays (Modal/Sheet/ConfirmDialog render via `createPortal` to
 * `document.body`) are covered too.
 */
export function useDisableNativeTextAssist(): void {
  useEffect(() => {
    const root = document.documentElement;
    sweep(root);

    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach(sweep);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
