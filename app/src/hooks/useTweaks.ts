import { useAppStore } from "@/store";
import type { Tweaks } from "@/lib/tweaks";

export type { Tweaks } from "@/lib/tweaks";
export { TWEAK_DEFAULTS } from "@/lib/tweaks";

/**
 * Thin selector over the single-source-of-truth tweaks slice in the app store.
 * Kept as a hook for call-site compatibility; every consumer now reads/writes
 * the same store value, so a change from one surface reflects everywhere live.
 *
 * The `data-density` `<html>` side-effect lives in one App-root effect (App.tsx),
 * not here, so there is exactly one writer.
 */
export function useTweaks(): [
  Tweaks,
  <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void,
] {
  const tweaks = useAppStore((s) => s.tweaks);
  const setTweak = useAppStore((s) => s.setTweak);
  return [tweaks, setTweak];
}
