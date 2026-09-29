import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UsagePeaksGrid } from "@/screens/usage/UsagePeaksGrid";

describe("UsagePeaksGrid", () => {
  it("labels Monday 11:00 and navigates in weekday-major rows", () => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    grid[0][11] = 10;
    render(<UsagePeaksGrid grid={grid} since="2026-09-01" until="2026-09-16" />);
    const monday = screen.getByRole("gridcell", { name: "10 tokens total across all Mondays, 11:00 to 12:00 UTC, Sep 1, 2026 to Sep 16, 2026" });
    expect(monday).toBeInTheDocument();
    fireEvent.mouseEnter(monday);
    expect(screen.getByRole("tooltip")).toHaveTextContent(monday.getAttribute("aria-label")!);
    fireEvent.mouseLeave(monday);
    expect(screen.getByRole("tooltip")).toBeEmptyDOMElement();
    fireEvent.focus(monday);
    expect(screen.getByRole("tooltip")).toHaveTextContent(monday.getAttribute("aria-label")!);
    fireEvent.keyDown(monday, { key: "ArrowRight" });
    expect(document.activeElement).toHaveAttribute("aria-label", "0 tokens total across all Mondays, 12:00 to 13:00 UTC, Sep 1, 2026 to Sep 16, 2026");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("aria-label", "0 tokens total across all Tuesdays, 12:00 to 13:00 UTC, Sep 1, 2026 to Sep 16, 2026");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toHaveAttribute("aria-label", "0 tokens total across all Tuesdays, 00:00 to 01:00 UTC, Sep 1, 2026 to Sep 16, 2026");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toHaveAttribute("aria-label", "0 tokens total across all Tuesdays, 23:00 to 24:00 UTC, Sep 1, 2026 to Sep 16, 2026");
  });

  it("explains all-time totals and formats large counts", () => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    grid[3][6] = 25999654;
    const { rerender } = render(<UsagePeaksGrid grid={grid} since={null} until={null} />);
    const cell = screen.getByRole("gridcell", { name: "25,999,654 tokens total across all Thursdays, 06:00 to 07:00 UTC, all recorded dates" });
    fireEvent.mouseEnter(cell);
    expect(screen.getByRole("tooltip")).toHaveTextContent("all recorded dates");
    rerender(<UsagePeaksGrid grid={grid} since="2026-09-01" until={null} />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("from Sep 1, 2026 onward");
    rerender(<UsagePeaksGrid grid={grid} since={null} until="2026-09-16" />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("through Sep 16, 2026");
  });
});
