import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TokenCompositionBars, shouldZoom } from "@/screens/usage/TokenCompositionBars";
import type { Segment } from "@/components/charts/CompositionBar";
import type { UsageTokenCounts } from "@/features/usage/usageTypes";

function tok(input: number, output: number, cacheCreation: number, cacheRead: number): UsageTokenCounts {
  return { input, output, cacheCreation, cacheRead, total: input + output + cacheCreation + cacheRead };
}

// The real screenshot session (docs/changes/DESIGN-usage-numbers/PLAN.md §R1): cache read
// 1.3B (98%), cache write 22.9M (2%), output 1.7M (0.1%), input 21.2k (<0.1%).
const CACHE_HEAVY = tok(21_200, 1_700_000, 22_900_000, 1_300_000_000);

describe("shouldZoom", () => {
  it("is true when one segment holds 90%+ and two others are non-zero", () => {
    const segments: Segment[] = [
      { id: "cache-read", label: "Cache read", value: CACHE_HEAVY.cacheRead, color: "c0" },
      { id: "input", label: "Input", value: CACHE_HEAVY.input, color: "c1" },
      { id: "cache-write", label: "Cache write", value: CACHE_HEAVY.cacheCreation, color: "c2" },
      { id: "output", label: "Output", value: CACHE_HEAVY.output, color: "c3" },
    ];
    expect(shouldZoom(segments)).toBe(true);
  });

  it("is false for a balanced composition", () => {
    const segments: Segment[] = [
      { id: "a", label: "A", value: 25, color: "c0" },
      { id: "b", label: "B", value: 25, color: "c1" },
      { id: "c", label: "C", value: 25, color: "c2" },
      { id: "d", label: "D", value: 25, color: "c3" },
    ];
    expect(shouldZoom(segments)).toBe(false);
  });

  it("is false when the dominant segment clears 90% but only one other is non-zero", () => {
    const segments: Segment[] = [
      { id: "a", label: "A", value: 950, color: "c0" },
      { id: "b", label: "B", value: 50, color: "c1" },
      { id: "c", label: "C", value: 0, color: "c2" },
    ];
    expect(shouldZoom(segments)).toBe(false);
  });
});

describe("TokenCompositionBars", () => {
  it("adds a zoom bar when one segment holds 90% or more and two others are non-zero", () => {
    const { container } = render(<TokenCompositionBars tokens={CACHE_HEAVY} ariaLabel="Token composition" />);
    expect(container.querySelector(".usage-zoom-bar")).toBeInTheDocument();
  });

  it("omits the zoom bar for a balanced composition", () => {
    const balanced = tok(25, 25, 25, 25);
    const { container } = render(<TokenCompositionBars tokens={balanced} ariaLabel="Token composition" />);
    expect(container.querySelector(".usage-zoom-bar")).not.toBeInTheDocument();
  });

  it("gives a segment the same hue in both levels", () => {
    const { container } = render(<TokenCompositionBars tokens={CACHE_HEAVY} ariaLabel="Token composition" />);
    const bars = container.querySelectorAll(".comp-bar");
    expect(bars).toHaveLength(2);
    const outputInLevelOne = bars[0].querySelector('[data-segment="output"]') as HTMLElement;
    const outputInLevelTwo = bars[1].querySelector('[data-segment="output"]') as HTMLElement;
    expect(outputInLevelOne.style.background).toBe(outputInLevelTwo.style.background);
  });

  it("captions the zoom bar with its own token total and its share of the whole", () => {
    render(<TokenCompositionBars tokens={CACHE_HEAVY} ariaLabel="Token composition" />);
    expect(
      screen.getByText("Excluding cache read · 24.6M tokens · 2% of all tokens"),
    ).toBeInTheDocument();
  });

  it("renders 98% / 2% / 0.1% / <0.1% for the 1.3B cache-read session", () => {
    const { container } = render(<TokenCompositionBars tokens={CACHE_HEAVY} ariaLabel="Token composition" />);
    const levelOne = container.querySelectorAll(".comp-bar-legend")[0];
    const pcts = Array.from(levelOne.querySelectorAll(".comp-bar-legend-pct")).map((el) => el.textContent);
    expect(pcts).toEqual(["98%", "<0.1%", "2%", "0.1%"]);
  });

  // REVIEW-W1 #3: a case where the four-way largest-remainder ladder gives
  // the dominant a DIFFERENT whole number than a caption computed
  // independently would (cache read 904 rounds to 91% here, not the 90.4%
  // a naive read would suggest) — the caption must track that exact number,
  // never an independently rounded one, so the two always sum to 100.
  it("keeps the caption and the dominant's own level-one percent summing to exactly 100 (904/4/48/44)", () => {
    const skewed = tok(4, 44, 48, 904);
    const { container } = render(<TokenCompositionBars tokens={skewed} ariaLabel="Token composition" />);
    const levelOne = container.querySelectorAll(".comp-bar-legend")[0];
    const pcts = Array.from(levelOne.querySelectorAll(".comp-bar-legend-pct")).map((el) => el.textContent);
    expect(pcts).toEqual(["91%", "0.4%", "5%", "4%"]);

    const caption = screen.getByText(/Excluding cache read/);
    expect(caption.textContent).toBe("Excluding cache read · 96 tokens · 9% of all tokens");

    const dominantWhole = Number.parseInt(pcts[0]!, 10);
    const captionWhole = Number.parseInt(caption.textContent!.split("·")[2], 10);
    expect(dominantWhole + captionWhole).toBe(100);
  });
});
