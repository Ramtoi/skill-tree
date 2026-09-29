import { useEffect, useRef } from "react";
import type { useLocalAgentUsage } from "./useLocalAgentUsage";

/** Capture-on-open threshold: a cache older than this (or entirely absent)
 *  is treated as stale and gets one automatic scan on mount — "insurance for
 *  when I open the usage screen" (PLAN.md, 2026-09-04), not a durability
 *  guarantee. `scanned_at` is epoch SECONDS, matching `Date.now() / 1000`
 *  below. */
const CAPTURE_ON_OPEN_STALE_SECONDS = 3600;

/**
 * Module-level: which cache states this app SESSION has already tried an
 * automatic scan for, keyed by `scanned_at ?? "none"` (review W3). A FAILED
 * auto-scan leaves the cache exactly as it was (`cachedScan` stays `null`,
 * or a stale timestamp stays stale), so its key would otherwise re-qualify
 * as "stale" on every remount and re-fire forever — the user asked for
 * nothing and would get a repeated failed process card. Recording the key
 * once, win or lose, is what makes the auto-scan an "ask once" attempt
 * rather than a retry loop. Session-lifetime by design (not persisted): a
 * fresh app launch gets one attempt again, same as before.
 */
const attemptedCacheKeys = new Map<string, number>();

/** Test-only: vitest does not reset ES module state between `it()`s within
 *  one test file (only across files), so this module-level set would
 *  otherwise leak a "already attempted" key from one test into the next.
 *  Cleared globally in `src/test/setup.ts`'s `beforeEach`. */
export function __resetCaptureOnOpenForTests(): void {
  attemptedCacheKeys.clear();
}

function cacheKey(scannedAt: number | undefined | null): string {
  return scannedAt === undefined || scannedAt === null ? "none" : String(scannedAt);
}

/**
 * Capture-on-open: fires the SAME scan mutation the "Refresh scan" button
 * fires, once, when the held cache is missing or older than
 * {@link CAPTURE_ON_OPEN_STALE_SECONDS}.
 *
 * Takes the object `useLocalAgentUsage()` already returns rather than
 * calling that hook itself, and is called ONLY by the Usage screen
 * (`LocalAgentUsage.tsx`). Review C4: this effect used to live inside
 * `useLocalAgentUsage()` itself, so every consumer of that hook — the
 * NavPanel's Agents glance (`AgentsBody.tsx`), `useProjectActivity.ts` — got
 * its OWN ref and its OWN mutation instance and fired its OWN scan, so
 * opening `/usage` or `/harness/:id` could spawn two or more concurrent
 * `ccusage` runs from surfaces the user never asked to scan. With exactly
 * one call site there is exactly one scan mutation in play, and a failure
 * renders through the SAME error/diagnostic states the manual "Refresh
 * scan" button already produces (review W3) — no new UI state.
 */
export function useCaptureOnOpen(usage: ReturnType<typeof useLocalAgentUsage>): void {
  const capturedRef = useRef(false);
  useEffect(() => {
    if (capturedRef.current) return;
    if (!usage.latest.isSuccess) return;
    if (usage.scan.isPending) return;
    const cachedScan = usage.cachedScan;
    const key = cacheKey(cachedScan?.scanned_at);
    const now = Math.floor(Date.now() / 1000);
    const attemptedAt = attemptedCacheKeys.get(key);
    if (attemptedAt !== undefined && now - attemptedAt <= CAPTURE_ON_OPEN_STALE_SECONDS) return;
    const stale =
      cachedScan === null ||
      now - cachedScan.scanned_at > CAPTURE_ON_OPEN_STALE_SECONDS;
    if (!stale) return;
    capturedRef.current = true;
    attemptedCacheKeys.set(key, now);
    usage.runScan();
    // `usage.scan` (the whole mutation object) changes identity on every
    // status transition; depending on it directly would re-run this effect
    // far more often than the two fields it actually reads. The
    // `capturedRef`/`attemptedCacheKeys` guards above make every extra run a
    // no-op regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage.latest.isSuccess, usage.cachedScan, usage.scan.isPending, usage.runScan]);
}
