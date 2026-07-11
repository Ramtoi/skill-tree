import { useAppStore } from "@/store";

/**
 * The single keymap registry (ux-command-layer D1). This module is the ONE
 * place a chord binding, its label, its display hint, and its handler live
 * together. The chord handler (`useChords`), the `?` cheatsheet
 * (`ShortcutCheatsheet`), and every palette `Kbd` hint derive from `KEYMAP` —
 * nothing else defines a chord or renders a hint string, so a shown keybind is
 * structurally guaranteed to be one that actually fires.
 */

export type KeyGroup = "Navigation" | "Create" | "Global" | "List" | "Palette";

export interface KeymapCtx {
  /** react-router navigate. */
  navigate: (to: string) => void;
  /** Open the command palette, optionally straight into a verb stage. */
  openPalette: (verbId?: string) => void;
  /** Route to the most-recent / first project (empty string when none). */
  lastProjectRoute: () => string;
  /** Route to the first bundle (empty string when none). */
  firstBundleRoute: () => string;
}

export interface KeyBinding {
  /** Stable id, e.g. "nav.library", "create.skill". Used by tests + hint lookup. */
  id: string;
  /** Chord sequence as discrete key tokens: ["g","l"], ["g","P"] (shift), ["c","s"]. */
  keys: string[];
  /** Human label for the cheatsheet, e.g. "Go to Library". */
  label: string;
  group: KeyGroup;
  /** Display form for <Kbd> / the cheatsheet. Derived-render only, never re-parsed. */
  hint: string;
  /** When the binding is live. Default "not-typing" (inert while a text field is focused). */
  when?: "always" | "not-typing";
  /** The handler. Receives app-level navigation + store actions. */
  run: (ctx: KeymapCtx) => void;
}

/** Navigate to a project route, falling back to the palette when none exist. */
function goProject(ctx: KeymapCtx) {
  const r = ctx.lastProjectRoute();
  if (r) ctx.navigate(r);
  else ctx.openPalette();
}

/** Navigate to a bundle route, falling back to the palette when none exist. */
function goBundle(ctx: KeymapCtx) {
  const r = ctx.firstBundleRoute();
  if (r) ctx.navigate(r);
  else ctx.openPalette();
}

export const KEYMAP: KeyBinding[] = [
  // ── Navigation (g-prefix) ──
  {
    id: "nav.library",
    keys: ["g", "l"],
    label: "Go to Library",
    group: "Navigation",
    hint: "g l",
    run: (ctx) => ctx.navigate("/"),
  },
  {
    id: "nav.project",
    keys: ["g", "p"],
    label: "Go to last project",
    group: "Navigation",
    hint: "g p",
    run: goProject,
  },
  {
    id: "nav.bundles",
    keys: ["g", "b"],
    label: "Go to Bundles",
    group: "Navigation",
    hint: "g b",
    run: goBundle,
  },
  {
    id: "nav.harnesses",
    keys: ["g", "h"],
    label: "Go to Harnesses",
    group: "Navigation",
    hint: "g h",
    run: (ctx) => ctx.navigate("/harnesses"),
  },
  {
    id: "nav.sources",
    keys: ["g", "s"],
    label: "Go to Sources",
    group: "Navigation",
    hint: "g s",
    run: (ctx) => ctx.navigate("/sources"),
  },
  {
    id: "nav.snippets",
    keys: ["g", "n"],
    label: "Go to Snippets",
    group: "Navigation",
    hint: "g n",
    run: (ctx) => ctx.navigate("/snippets"),
  },
  {
    id: "nav.remotes",
    keys: ["g", "r"],
    label: "Go to Remotes",
    group: "Navigation",
    hint: "g r",
    run: (ctx) => ctx.navigate("/remotes"),
  },
  {
    id: "nav.permissions",
    keys: ["g", "P"],
    label: "Go to Permissions",
    group: "Navigation",
    hint: "g ⇧p",
    run: (ctx) => ctx.navigate("/permissions"),
  },
  // ── Create (c-prefix) ──
  {
    id: "create.skill",
    keys: ["c", "s"],
    label: "New skill",
    group: "Create",
    hint: "c s",
    run: (ctx) => ctx.navigate("/?new=1"),
  },
  {
    id: "create.bundle",
    keys: ["c", "b"],
    label: "New bundle",
    group: "Create",
    hint: "c b",
    run: (ctx) => ctx.navigate("/?addBundle=1"),
  },
  // ── Palette / help (single key) ──
  {
    id: "help.cheatsheet",
    keys: ["?"],
    label: "Keyboard shortcuts",
    group: "Palette",
    hint: "?",
    run: () => useAppStore.getState().openCheatsheet(),
  },
];

/** Look up a binding's display hint by id (for palette items). Empty when unknown. */
export function hintForBindingId(id: string): string {
  return KEYMAP.find((b) => b.id === id)?.hint ?? "";
}

/**
 * Static "Global" rows for the cheatsheet — keys owned by App.tsx/screens
 * (⌘K, /, ⌘S, Esc). Kept OUT of `KEYMAP` (and off the entry↔handler test) so
 * the registry stays an exact map of the chords it actually dispatches.
 */
export const GLOBAL_STATIC_HINTS: { hint: string; label: string }[] = [
  { hint: "⌘K", label: "Toggle command palette" },
  { hint: "/", label: "Focus search" },
  { hint: "⌘S", label: "Save (editor)" },
  { hint: "esc", label: "Dismiss / pop stage" },
];
