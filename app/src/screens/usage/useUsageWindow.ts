import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { UsageWindow } from "@/features/usage/usageAnalyticsTypes";

const WINDOW_KEY = "st:usage:window";

/** Default window for the project drill-down — distinct from
 *  `useUsagePrefs.ts`'s `UsageRange`/`st:usage:range` (`"7d" | "30d" | "all"`,
 *  default `"all"`), which is the Overview's own vocabulary and does not
 *  cover D7's `--window 7|30|90` at all (design D14.6). */
const DEFAULT_WINDOW: UsageWindow = 30;

function readWindow(): UsageWindow {
  try {
    const raw = localStorage.getItem(WINDOW_KEY);
    if (raw === "7" || raw === "30" || raw === "90") {
      return Number(raw) as UsageWindow;
    }
    return DEFAULT_WINDOW;
  } catch {
    return DEFAULT_WINDOW;
  }
}

export interface UseUsageWindow {
  window: UsageWindow;
  setWindow: (value: UsageWindow) => void;
}

/**
 * Persists the usage drill-down's 7/30/90-day window pick to
 * `st:usage:window`, shared across every surface that reads it (the project
 * route's header selector, wave 3's project chrome) so a pick made on one
 * surface survives a trip through a session and back (design D14.6). Every
 * read and write is wrapped in try/catch, an invalid or absent stored value
 * falls back to 30.
 */
export function useUsageWindow(): UseUsageWindow {
  const location = useLocation();
  const navigate = useNavigate();
  const consumedState = useRef<unknown>(undefined);
  const [window, setWindowState] = useState<UsageWindow>(() => {
    const state = (location.state as { usageWindow?: unknown } | null | undefined)?.usageWindow;
    return state === 7 || state === 30 || state === 90 ? state : readWindow();
  });

  const setWindow = useCallback((value: UsageWindow) => {
    setWindowState(value);
    try {
      localStorage.setItem(WINDOW_KEY, String(value));
    } catch {
      /* best-effort persistence only */
    }
  }, []);

  useEffect(() => {
    const state = location.state;
    const handoff = (state as { usageWindow?: unknown } | null | undefined)?.usageWindow;
    if ((handoff !== 7 && handoff !== 30 && handoff !== 90) || consumedState.current === state) return;
    consumedState.current = state;
    setWindow(handoff);
    const rest = { ...((state as Record<string, unknown>) ?? {}) };
    delete rest.usageWindow;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: rest });
  }, [location, navigate, setWindow]);

  return { window, setWindow };
}
