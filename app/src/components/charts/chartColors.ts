/**
 * Chart color contract — every value here is a CSS variable reference, never
 * a color literal. See COMPONENTS.md §Charts.
 *
 * - IDENTITY_SERIES: categorical, fixed order, per-entity. A supplied set
 *   resolves hash collisions into unused slots; a 9th+ entity folds into
 *   `Other`, which wears OTHER_SERIES_COLOR, not a 9th hue.
 * - sequentialSteps(n): one hue (the CONTEXT accent), n steps light→dark —
 *   for magnitude (CompositionBar segments, single-series rank bars).
 * - SINGLE_SERIES: the flat default fill for a chart that carries no
 *   per-item color of its own (e.g. an unranked HorizontalBarList row).
 */

/** Categorical identity ramp, fixed order — never cycled. */
export const IDENTITY_SERIES: readonly string[] = [
  "var(--id-0)",
  "var(--id-1)",
  "var(--id-2)",
  "var(--id-3)",
  "var(--id-4)",
  "var(--id-5)",
  "var(--id-6)",
  "var(--id-7)",
];

/** Fold color for any entity past IDENTITY_SERIES.length. */
export const OTHER_SERIES_COLOR = "var(--fg-dim)";

/** Flat default fill when a mark carries no per-item color. */
export const SINGLE_SERIES = "color-mix(in oklab, var(--ctx) 62%, var(--bg-3))";

const SEQUENTIAL_MAX_PCT = 92;
const SEQUENTIAL_MIN_PCT = 28;

/**
 * n steps of one hue (--ctx), light→dark, for encoding magnitude/rank
 * rather than identity. n<=0 returns []; n===1 returns the lightest step.
 */
export function sequentialSteps(n: number): string[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [sequentialStep(SEQUENTIAL_MAX_PCT)];
  const steps: string[] = [];
  for (let i = 0; i < count; i++) {
    const pct = SEQUENTIAL_MAX_PCT - (i * (SEQUENTIAL_MAX_PCT - SEQUENTIAL_MIN_PCT)) / (count - 1);
    steps.push(sequentialStep(Math.round(pct)));
  }
  return steps;
}

function sequentialStep(pct: number): string {
  return `color-mix(in oklab, var(--ctx) ${pct}%, var(--bg-3))`;
}

/** IDENTITY_SERIES[index], folding anything past the ramp into Other. */
export function identityColor(index: number): string {
  return IDENTITY_SERIES[index] ?? OTHER_SERIES_COLOR;
}

/**
 * Assign a categorical colour from an entity's stable id rather than its
 * current rank. When ids are supplied, sorted open addressing moves a hash
 * collision into the next free slot. Only true palette overflow becomes
 * Other, so a six-model chart cannot become mostly gray by chance.
 */
export function seriesColorFor(
  id: string,
  palette: readonly string[] = IDENTITY_SERIES,
  ids?: readonly string[],
): string {
  if (id.toLowerCase() === "other") return OTHER_SERIES_COLOR;
  if (palette.length === 0) return OTHER_SERIES_COLOR;
  if (!ids) return palette[stableHash(id) % palette.length] ?? OTHER_SERIES_COLOR;

  const assignments = new Map<string, number>();
  const occupied = new Set<number>();
  const candidates = [...new Set(ids.filter((candidate) => candidate.toLowerCase() !== "other"))]
    .sort((a, b) => a.localeCompare(b));
  for (const candidate of candidates) {
    const start = stableHash(candidate) % palette.length;
    for (let offset = 0; offset < palette.length; offset += 1) {
      const slot = (start + offset) % palette.length;
      if (occupied.has(slot)) continue;
      assignments.set(candidate, slot);
      occupied.add(slot);
      break;
    }
  }
  const slot = assignments.get(id);
  return slot === undefined ? OTHER_SERIES_COLOR : palette[slot] ?? OTHER_SERIES_COLOR;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
