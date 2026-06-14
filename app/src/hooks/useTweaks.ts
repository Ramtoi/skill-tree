import { useEffect, useState, useCallback } from "react";

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

function readStorage(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return TWEAK_DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...TWEAK_DEFAULTS, ...parsed };
  } catch {
    return TWEAK_DEFAULTS;
  }
}

export function useTweaks(): [Tweaks, <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void] {
  const [tweaks, setTweaks] = useState<Tweaks>(() => readStorage());

  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((t) => {
      const next = { ...t, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, []);

  // Apply tweak side-effects to <html>. The brand accent (--violet) is fixed in
  // the stylesheet and intentionally not swappable — color carries meaning here.
  useEffect(() => {
    document.documentElement.setAttribute("data-density", tweaks.density);
  }, [tweaks.density]);

  return [tweaks, setTweak];
}
