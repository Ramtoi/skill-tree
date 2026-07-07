/**
 * First-run tips-tour data + persistence. Mirrors lib/tweaks.ts: pure
 * localStorage read/write helpers (guarded so a disabled/broken storage never
 * throws) plus the static step registry. The canonical open/step *state* lives
 * in the Zustand app store (see store/index.ts); this module owns only the
 * durable "have they seen it" flag and the immutable tour definition.
 */
import { hintForBindingId, GLOBAL_STATIC_HINTS } from "@/lib/keymap";

const TIPS_DONE_KEY = "st:tips:done";

/** True once the user has completed OR skipped/dismissed the tour. */
export function tipsDone(): boolean {
  try {
    return localStorage.getItem(TIPS_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist that the tour has been finished/skipped (idempotent). */
export function markTipsDone(): void {
  try {
    localStorage.setItem(TIPS_DONE_KEY, "1");
  } catch {
    /* ignore storage errors */
  }
}

/** Test/debug helper: forget the flag so the tour can auto-start again. */
export function clearTipsDone(): void {
  try {
    localStorage.removeItem(TIPS_DONE_KEY);
  } catch {
    /* ignore storage errors */
  }
}

/**
 * A shortcut reference sourced from the single keymap registry (lib/keymap.ts)
 * — never a hardcoded key string. `binding` looks up a KEYMAP entry by id;
 * `global` looks up one of the static App-owned hints (⌘K, /, ⌘S, Esc).
 */
export type TourHint = { binding: string } | { global: string };

/** Resolve a `TourHint` to its display string via the keymap registry. */
export function resolveTourHint(h: TourHint): string {
  if ("binding" in h) return hintForBindingId(h.binding);
  return GLOBAL_STATIC_HINTS.find((g) => g.label === h.global)?.hint ?? "";
}

export interface TipStep {
  /** Matches a `[data-tour="<id>"]` anchor in the shell. */
  id: string;
  title: string;
  /** One or two sentences of prose. Keys are surfaced via `hints`, not inline. */
  body: string;
  /** Shortcut chips shown under the body, sourced from the keymap registry. */
  hints?: TourHint[];
}

/**
 * The six-step first-run tour, in order. Anchors are stable, always-mounted
 * shell elements (rail buttons, NavPanel add, the StatusBar sync chip) so the
 * tour works from any route; a missing anchor centers the card (TipsTour.tsx).
 */
export const TOUR: TipStep[] = [
  {
    id: "palette",
    title: "Everything is a keystroke away",
    body: "The command palette jumps to any skill, project, bundle, or action — and runs verbs like equip and apply without leaving the keyboard.",
    hints: [{ global: "Toggle command palette" }],
  },
  {
    id: "add-project",
    title: "Register a project",
    body: "A project is a linking target. Add one so the hub can write your equipped skills into its agent folders.",
  },
  {
    id: "library",
    title: "Fill your library",
    body: "Author skills from scratch here, or pull them in from Sources — git repos and packs you register once and reuse everywhere.",
    hints: [{ binding: "create.skill" }],
  },
  {
    id: "equip",
    title: "Equip a project",
    body: "Open a project to equip individual skills or apply whole bundles. Drag a skill onto the loadout, or toggle a bundle chip.",
    hints: [{ binding: "nav.project" }],
  },
  {
    id: "sync",
    title: "Sync writes it out",
    body: "Syncing links every equipped skill into each project's enabled harness folders. This chip carries freshness — including an honest \"not synced yet\".",
  },
  {
    id: "help",
    title: "Go faster",
    body: "Open the shortcut cheatsheet any time, use chord jumps to move between screens, and open Tweaks from the rail cog to change density or hide the rail.",
    hints: [{ binding: "help.cheatsheet" }, { binding: "nav.library" }],
  },
];
