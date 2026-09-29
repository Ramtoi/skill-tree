import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusedTooltipPosition,
  resolvedTooltipPosition,
} from "@/components/tooltipPosition";

afterEach(() => vi.restoreAllMocks());

describe("informative tooltip position", () => {
  it("keeps a keyboard tooltip outside a host that crosses the viewport midpoint", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({
      left: 200,
      top: 350,
      width: 200,
      height: 100,
      right: 400,
      bottom: 450,
      x: 200,
      y: 350,
      toJSON: () => ({}),
    });

    expect(focusedTooltipPosition(host)).toMatchObject({ top: 450, vertical: "below" });
  });

  it("clamps the measured overlay rectangle inside a narrow viewport", () => {
    const viewport = { width: 520, height: 400 };
    const size = { width: 260, height: 120 };
    expect(resolvedTooltipPosition(
      { left: 270, top: 200, side: "left", vertical: "below" },
      size,
      viewport,
    )).toEqual({ left: 12, top: 212 });
    expect(resolvedTooltipPosition(
      { left: 250, top: 390, side: "right", vertical: "above" },
      size,
      viewport,
    )).toEqual({ left: 248, top: 258 });
  });
});
