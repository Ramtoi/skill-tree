/**
 * Maps a ccusage `agent` id to this app's own harness registry id, so the
 * Usage screen can show the real brand glyph (`<HarnessGlyph>`) instead of a
 * bare monogram. Unmapped ids (any harness ccusage supports beyond these
 * four) render with no glyph — `ccusageToHubHarness` returns `undefined` and
 * callers omit the swatch/glyph rather than guessing.
 */
import { canonicalHarness } from "@/features/usage/sessionIdentity";

export function ccusageToHubHarness(ccusageId: string): string | undefined {
  return canonicalHarness(ccusageId);
}

export function canonicalHarnessId(id: string): string {
  const canonical = canonicalHarness(id);
  return canonical === "claude-code" ? "claude" : canonical ?? id;
}

/** Fixed display/series order for the harnesses ccusage names natively —
 *  everything else falls in alphabetically after these four. */
export const HARNESS_FIXED_ORDER: readonly string[] = ["claude", "codex", "pi", "opencode"];

/** How many identity-ramp slots the fixed harnesses reserve (`--id-0..3`). */
const RESERVED_COLOR_SLOTS = HARNESS_FIXED_ORDER.length;
/** Slots left for every other ccusage agent (`--id-4..7`). */
const OPEN_COLOR_SLOTS = 4;

/**
 * The identity-ramp index a harness wears — **a property of the harness, not
 * of its rank in the list currently on screen**. Passing an array index here
 * would re-hue every later series the moment one harness drops out of scope
 * (a range narrowing, a harness with no usage this week), so the spend
 * chart's legend, its columns and the breakdown's share bars would all shift
 * color for reasons the data never justified.
 *
 * `claude → --id-0, codex → --id-1, pi → --id-2, opencode → --id-3` per the
 * plan; any other agent id hashes deterministically into `--id-4..7`. Two
 * unmapped agents can therefore collide on one hue — a far smaller lie than
 * silently re-assigning a hue the user has already learned.
 */
export function harnessColorIndex(ccusageId: string): number {
  ccusageId = canonicalHarnessId(ccusageId);
  const fixed = HARNESS_FIXED_ORDER.indexOf(ccusageId);
  if (fixed !== -1) return fixed;
  let hash = 0;
  for (let i = 0; i < ccusageId.length; i++) {
    hash = (hash * 31 + ccusageId.charCodeAt(i)) % 100003;
  }
  return RESERVED_COLOR_SLOTS + (hash % OPEN_COLOR_SLOTS);
}

/** Orders a set of (ccusage) harness ids: the fixed order first (only the
 *  ones present), then any remaining id alphabetically. Used for the spend
 *  chart's series order and the harness-breakdown row order, so the two
 *  never disagree. */
export function orderHarnessIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  const fixed = unique
    .filter((id) => HARNESS_FIXED_ORDER.includes(canonicalHarnessId(id)))
    .sort((a, b) => HARNESS_FIXED_ORDER.indexOf(canonicalHarnessId(a)) - HARNESS_FIXED_ORDER.indexOf(canonicalHarnessId(b)));
  const rest = unique
    .filter((id) => !HARNESS_FIXED_ORDER.includes(canonicalHarnessId(id)))
    .sort((a, b) => canonicalHarnessId(a).localeCompare(canonicalHarnessId(b)));
  return [...fixed, ...rest];
}
