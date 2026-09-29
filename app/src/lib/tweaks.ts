/**
 * Appearance state — density / rail visibility. The canonical store lives in the
 * Zustand app store (single source of truth, see store/index.ts). These are the
 * pure type + localStorage helpers it hydrates from and writes through to.
 */
export interface Tweaks {
  density: "compact" | "default" | "cozy";
  showRail: boolean;
  /** Rail shows a text label beside each icon (wider rail). Preference only —
   *  a narrow window compacts the presentation without clearing this. */
  railExpanded: boolean;
  /** Show the 240px navigator panel. Off drops its column at every width; at
   *  narrow widths the panel is already an off-canvas drawer, so it stays
   *  reachable through the handle rather than disappearing outright. */
  showNav: boolean;
  /** Legacy mock-only flag accepted while reading old test/visual fixtures;
   * never hydrated, rendered, or written by production. */
  demoError?: boolean;
}

export const TWEAK_DEFAULTS: Tweaks = {
  density: "default",
  showRail: true,
  railExpanded: false,
  showNav: true,
};

const STORAGE_KEY = "skill-tree:tweaks";

/** Read persisted tweaks once (back-compat with the old useTweaks key). */
export function readTweaks(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...TWEAK_DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...TWEAK_DEFAULTS };
    const value = parsed as Partial<Tweaks>;
    return {
      density:
        value.density === "compact" || value.density === "cozy" || value.density === "default"
          ? value.density
          : TWEAK_DEFAULTS.density,
      showRail: typeof value.showRail === "boolean" ? value.showRail : TWEAK_DEFAULTS.showRail,
      railExpanded:
        typeof value.railExpanded === "boolean" ? value.railExpanded : TWEAK_DEFAULTS.railExpanded,
      showNav: typeof value.showNav === "boolean" ? value.showNav : TWEAK_DEFAULTS.showNav,
    };
  } catch {
    return { ...TWEAK_DEFAULTS };
  }
}

/** Write-through the full tweaks object to localStorage. */
export function writeTweaks(tweaks: Tweaks): boolean {
  try {
    // Deliberately project the known appearance keys. Older installs may have
    // persisted the mock-only `demoError` flag; it must never become a
    // production preference again.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        density: tweaks.density,
        showRail: tweaks.showRail,
        railExpanded: tweaks.railExpanded,
        showNav: tweaks.showNav,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
