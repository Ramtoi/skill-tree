// Coarse "minutes since last sync" parser used for sorting projects in the
// navigator. Mirrors the prototype: handles "12m", "4h", "2d"; anything
// unparseable (including undefined / "never") sorts to the bottom.
export function syncMinutes(lastSync?: string): number {
  if (!lastSync || lastSync === "never") return Number.MAX_SAFE_INTEGER;
  const n = parseInt(lastSync, 10);
  if (Number.isNaN(n)) return Number.MAX_SAFE_INTEGER;
  if (lastSync.includes("m")) return n;
  if (lastSync.includes("h")) return n * 60;
  if (lastSync.includes("d")) return n * 60 * 24;
  return n;
}
