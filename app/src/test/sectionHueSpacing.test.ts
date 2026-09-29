import { describe, expect, it } from "vitest";
import { readAppCss } from "./readAppCss";
import { GROUP_IDS } from "@/lib/sections";

// Colour space is partitioned by HUE as well as by chroma register. Status
// hues (red / amber / green / blue) are reserved: a section hue that sits on
// one of them reads as that status the moment it is lifted for a ring or a
// fill inside a screen body. The section wheel therefore keeps clear of every
// status hue and of itself. Context is the one exception — it IS the brand's
// home hue, so on Library screens anchor and context coincide by design.

const CSS = readAppCss();

function hueOf(token: string): number {
  const m = CSS.match(new RegExp(`${token}:\\s*oklch\\([\\d.]+% [\\d.]+ (\\d+)`));
  if (!m) throw new Error(`${token} not defined in the app CSS`);
  return Number(m[1]);
}
function dist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const STATUS = ["--red", "--amber", "--green", "--blue"] as const;
const MIN_FROM_STATUS = 30;
// 40°, not the 60° the old wheel had: that wheel bought its spacing by sitting
// ON the status hues. With red/amber/green/blue reserved there is room for five
// hues at 40° minimum (steel blue 225 vs teal 185 is the tightest pair), and
// status distance is the priority — the rail names each group with a glyph and
// a label, the status dot has only its colour.
const MIN_BETWEEN_SECTIONS = 40;
// Steel blue sits 20° from info blue: `--blue` is the least-used status hue in
// a body (sync freshness carries its own tones), and the projects hue was kept
// for continuity with the rail's first slot.
const ALLOWED: Record<string, Partial<Record<(typeof STATUS)[number], number>>> = {
  projects: { "--blue": 20 },
};

describe("section hue spacing", () => {
  const hues = Object.fromEntries(GROUP_IDS.map((g) => [g, hueOf(`--sec-${g}`)]));

  it.each(GROUP_IDS)("--sec-%s keeps clear of every status hue", (g) => {
    for (const s of STATUS) {
      const min = ALLOWED[g]?.[s] ?? MIN_FROM_STATUS;
      expect(dist(hues[g], hueOf(s)), `${g} vs ${s}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("keeps the five section hues tellable apart", () => {
    for (let i = 0; i < GROUP_IDS.length; i++)
      for (let j = i + 1; j < GROUP_IDS.length; j++)
        expect(
          dist(hues[GROUP_IDS[i]], hues[GROUP_IDS[j]]),
          `${GROUP_IDS[i]} vs ${GROUP_IDS[j]}`,
        ).toBeGreaterThanOrEqual(MIN_BETWEEN_SECTIONS);
  });

  it("context is the brand's home hue", () => {
    expect(hues.context).toBe(hueOf("--violet"));
  });
});
