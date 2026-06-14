export type ProjectHealth = "ok" | "stale" | "never";

// `lastSync` is the human string the prototype uses ("12m", "4h", "2d", "never").
// The Tauri commands don't yet emit a per-project sync timestamp, so callers will
// usually pass `undefined` — which maps to "never". When structured timestamps land,
// swap this implementation; the visual contract stays identical.
export function projectHealth(lastSync?: string): ProjectHealth {
  if (!lastSync || lastSync === "never") return "never";
  if (lastSync.includes("d")) return "stale";
  return "ok";
}
