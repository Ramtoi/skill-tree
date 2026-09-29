import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsageActivityCard } from "@/screens/usage/UsageActivityCard";
import { activityTotals, buildActivitySeries } from "@/screens/usage/usageOverTime";
import type { UsageTimelineDay } from "@/features/usage/usageAnalyticsTypes";

const days: UsageTimelineDay[] = [
  { date: "2026-08-01", skills: { alpha: 10, bravo: 8, charlie: 6, delta: 4, other: 2 }, tools: {} },
  { date: "2026-09-01", skills: { alpha: 5, bravo: 3, charlie: 2, delta: 1 }, tools: {} },
];

describe("skill chart selection", () => {
  it("finds every skill and plots only selected skills with their original counts", () => {
    expect(activityTotals(days, "skills")).toEqual([["alpha", 15], ["bravo", 11], ["charlie", 8], ["delta", 5], ["other", 2]]);
    const series = buildActivitySeries(days, "month", "skills", { ids: ["delta", "other"] });
    expect(series.map((item) => item.id)).toEqual(["delta", "other"]);
    expect(series.map((item) => item.points.map((point) => point.y))).toEqual([[4, 1], [2, 0]]);
    expect(buildActivitySeries(days, "month", "skills", { ids: [] })).toEqual([]);
    expect(buildActivitySeries(days, "month", "skills", { ids: ["delta", "missing", "delta"] }).map((item) => item.id)).toEqual(["delta"]);
  });

  it("searches beyond the top three, toggles without closing, clears, and restores defaults", async () => {
    const user = userEvent.setup();
    const { container } = render(<UsageActivityCard kind="skills" days={days} bucket="month" />);
    const plotted = () => [...container.querySelectorAll("polyline")].map((line) => line.getAttribute("data-series"));
    expect(plotted()).toEqual(["alpha", "bravo", "charlie"]);
    expect(container.querySelector('polyline[data-emphasis="false"]')).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose skills, 3 selected" }));
    const dialog = screen.getByRole("dialog", { name: "Choose skills" });
    const search = within(dialog).getByRole("searchbox", { name: "Search skills" });
    await user.type(search, "DELTA");
    await user.click(within(dialog).getByRole("option", { name: /^delta/ }));
    expect(dialog).toBeInTheDocument();
    expect(plotted()).toContain("delta");
    await user.click(within(dialog).getByRole("option", { name: /^delta/ }));
    expect(plotted()).not.toContain("delta");
    await user.type(search, "missing");
    expect(within(dialog).getByRole("status")).toHaveTextContent("No matching skills");
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));
    expect(plotted()).toEqual([]);
    expect(screen.getByText(/No skills selected/)).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "delta");
    await user.click(within(dialog).getByRole("option", { name: /^delta/ }));
    expect(plotted()).toEqual(["delta"]);
    expect(container.querySelector(".line-chart-axis-max")).toHaveTextContent("4 invocations");
    expect(container.querySelector(".chart-legend")).not.toHaveTextContent("Other");
    // A single selected line keeps its name and total visible.
    expect(container.querySelector(".chart-legend")).toHaveTextContent("delta5 invocations");
    await user.click(within(dialog).getByRole("button", { name: "Top 3" }));
    expect(plotted()).toEqual(["alpha", "bravo", "charlie"]);
    expect(within(dialog).queryByRole("checkbox", { name: "Show remaining skills as Other" })).not.toBeInTheDocument();
  });

  it("keeps choices when bucketing or narrowing data and restores absent choices on widening", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<UsageActivityCard kind="skills" days={days} bucket="month" />);
    await user.click(screen.getByRole("button", { name: /Choose skills/ }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("option", { name: /^delta/ }));
    rerender(<UsageActivityCard kind="skills" days={[{ ...days[0], skills: { alpha: 1 } }]} bucket="week" />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getByText(/No selected skills have data/)).toBeInTheDocument();
    rerender(<UsageActivityCard kind="skills" days={days} bucket="week" />);
    expect(container.querySelector("polyline")).toHaveAttribute("data-series", "delta");
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
  });

  it("limits the comparison to eight names while keeping selected rows removable", async () => {
    const user = userEvent.setup();
    const many = [{ ...days[0], skills: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`skill-${i}`, 10 - i])) }];
    render(<UsageActivityCard kind="skills" days={many} bucket="day" />);
    await user.click(screen.getByRole("button", { name: /Choose skills/ }));
    for (let i = 3; i < 8; i++) await user.click(screen.getByRole("option", { name: new RegExp(`^skill-${i}\\b`) }));
    const ninth = screen.getByRole("option", { name: /^skill-8/ });
    expect(ninth).toHaveAttribute("aria-disabled", "true");
    await user.click(ninth);
    expect(ninth).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("option", { name: /^skill-0/ }));
    await user.click(ninth);
    expect(ninth).toHaveAttribute("aria-selected", "true");
  });

  it("does not offer the picker for tools or unavailable skill data", () => {
    const { rerender } = render(<UsageActivityCard kind="tools" days={days} bucket="day" />);
    expect(screen.queryByRole("button", { name: /Choose skills/ })).not.toBeInTheDocument();
    rerender(<UsageActivityCard kind="skills" days={days} bucket="day" notice="No timeline for pi" />);
    expect(screen.queryByRole("button", { name: /Choose skills/ })).not.toBeInTheDocument();
  });
});
