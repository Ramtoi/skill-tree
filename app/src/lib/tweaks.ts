/**
 * Tweaks state — density / rail / demo flags. The canonical store lives in the
 * Zustand app store (single source of truth, see store/index.ts). These are the
 * pure type + localStorage helpers it hydrates from and writes through to.
 */
export interface Tweaks {
  density: "compact" | "default" | "cozy";
  showRail: boolean;
  demoSync: boolean;
  demoError: boolean;
}

export const TWEAK_DEFAULTS: Tweaks = {
  density: "default",
  showRail: true,
  demoSync: false,
  demoError: false,
};

const STORAGE_KEY = "skill-tree:tweaks";

/** Read persisted tweaks once (back-compat with the old useTweaks key). */
export function readTweaks(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return TWEAK_DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...TWEAK_DEFAULTS, ...parsed };
  } catch {
    return TWEAK_DEFAULTS;
  }
}

/** Write-through the full tweaks object to localStorage. */
export function writeTweaks(tweaks: Tweaks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
  } catch {
    /* ignore storage errors */
  }
}
