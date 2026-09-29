import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LineChart } from "@/components/charts/LineChart";
import { StackedColumnChart } from "@/components/charts/StackedColumnChart";
import { UsageActivityCard } from "@/screens/usage/UsageActivityCard";
import { UsageActivityHeatmap } from "@/screens/usage/UsageActivityHeatmap";
import { UsageSpendChart } from "@/screens/usage/UsageSpendChart";
import type { UsageDailyPoint } from "@/features/usage/usageTypes";
import type { UsageTimelineDay } from "@/features/usage/usageAnalyticsTypes";
import type { UsagePeriodKind } from "@/screens/usage/usagePeriod";
import { periodFromKey } from "@/screens/usage/usagePeriod";

const formatValue = (value: number) => String(value);

function movePointer(target: Element, clientX: number, clientY: number): void {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

const dailyPoint = (date: string, total: number): UsageDailyPoint => ({
  date,
  tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total },
  estimatedCost: { usd: total / 100, label: "Estimated API-equivalent cost" },
  harnesses: [{
    id: "claude-code",
    name: "Claude Code",
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total },
    estimatedCost: { usd: total / 100, label: "Estimated API-equivalent cost" },
  }],
});

const timelineDays: UsageTimelineDay[] = [
  { date: "2026-08-01", skills: { alpha: 4 }, tools: { Search: 2 } },
  { date: "2026-08-02", skills: { alpha: 3 }, tools: { Search: 1 } },
];

describe("chart day activation", () => {
  it("activates the currently hovered line date and focuses its real point once", () => {
    const onSelectPoint = vi.fn();
    const { container } = render(
      <LineChart
        series={[{ id: "activity", label: "Activity", color: "red", points: [
          { x: "2026-08-01", y: 4 },
          { x: "2026-08-02", y: 3 },
        ] }]}
        ariaLabel="Activity"
        formatValue={formatValue}
        onSelectPoint={onSelectPoint}
      />,
    );
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(area, { clientX: 0, clientY: 20 });
    fireEvent.click(area);
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    expect(onSelectPoint).toHaveBeenCalledWith("2026-08-01");
    expect(container.querySelector('[data-x="2026-08-01"]')).toHaveFocus();
  });

  it("selects the clicked line date without a prior hover", () => {
    const onSelectPoint = vi.fn();
    const { container } = render(
      <LineChart
        series={[{ id: "activity", label: "Activity", color: "red", points: [
          { x: "2026-08-01", y: 4 },
          { x: "2026-08-02", y: 3 },
        ] }]}
        ariaLabel="Activity"
        formatValue={formatValue}
        onSelectPoint={onSelectPoint}
      />,
    );
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(area, { clientX: 200, clientY: 20 });
    expect(onSelectPoint).toHaveBeenCalledWith("2026-08-02");
    expect(container.querySelector('[data-x="2026-08-02"]')).toHaveFocus();
  });

  it("keeps line point Enter and Space activation on the native point button", async () => {
    const user = userEvent.setup();
    const onSelectPoint = vi.fn();
    const { container } = render(
      <LineChart
        series={[{ id: "activity", label: "Activity", color: "red", points: [{ x: "2026-08-01", y: 4 }] }]}
        ariaLabel="Activity"
        formatValue={formatValue}
        onSelectPoint={onSelectPoint}
      />,
    );
    const point = container.querySelector(".line-chart-point") as HTMLElement;
    act(() => point.focus());
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelectPoint.mock.calls).toEqual([["2026-08-01"], ["2026-08-01"]]);
  });

  it("activates a stacked column with Enter and Space", () => {
    const onSelectColumn = vi.fn();
    const { container } = render(
      <StackedColumnChart
        series={[{ id: "one", label: "One", color: "red" }]}
        columns={[
          { key: "2026-08-01", label: "Aug 1", tooltipLabel: "Aug 1, 2026", values: { one: 4 } },
          { key: "2026-08-02", label: "Aug 2", tooltipLabel: "Aug 2, 2026", values: { one: 3 } },
        ]}
        format={formatValue}
        ariaLabel="Spend"
        onSelectColumn={onSelectColumn}
      />,
    );
    const column = container.querySelectorAll<HTMLElement>(".chart-col")[1];
    fireEvent.keyDown(column, { key: "Enter" });
    fireEvent.keyDown(column, { key: " " });
    expect(onSelectColumn.mock.calls).toEqual([["2026-08-02"], ["2026-08-02"]]);
    expect(column).toHaveFocus();
  });

  it("does not announce non-selectable columns as buttons", () => {
    const { container } = render(
      <StackedColumnChart
        series={[{ id: "one", label: "One", color: "red" }]}
        columns={[{ key: "2026-08-01", label: "Aug 1", tooltipLabel: "Aug 1, 2026", values: { one: 4 } }]}
        format={formatValue}
        ariaLabel="Grouped spend"
      />,
    );
    expect(container.querySelector(".chart-col")).not.toHaveAttribute("role", "button");
  });

  it("passes day, week, and month activation while leaving year buckets inert", () => {
    const onSelectPeriod = vi.fn();
    const { container, rerender } = render(
      <UsageActivityCard kind="skills" days={timelineDays} bucket="week" onSelectPeriod={onSelectPeriod} />,
    );
    const weeklyColumn = container.querySelector(".line-chart-area") as HTMLElement;
    weeklyColumn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(weeklyColumn, { clientX: 0, clientY: 20 });
    fireEvent.click(weeklyColumn);
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-07-27", "week");

    rerender(<UsageActivityCard kind="skills" days={timelineDays} bucket="month" onSelectPeriod={onSelectPeriod} />);
    const monthlyArea = container.querySelector(".line-chart-area") as HTMLElement;
    monthlyArea.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(monthlyArea, { clientX: 0, clientY: 20 });
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-08", "month");

    rerender(<UsageActivityCard kind="skills" days={timelineDays} bucket="day" onSelectPeriod={onSelectPeriod} />);
    const dailyArea = container.querySelector(".line-chart-area") as HTMLElement;
    dailyArea.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    movePointer(dailyArea, 200, 20);
    fireEvent.click(dailyArea, { clientX: 200, clientY: 20 });
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-08-02", "day");

    rerender(<UsageActivityCard kind="skills" days={timelineDays} bucket="year" onSelectPeriod={onSelectPeriod} />);
    const yearlyArea = container.querySelector(".line-chart-area") as HTMLElement;
    yearlyArea.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(yearlyArea, { clientX: 0, clientY: 20 });
    expect(onSelectPeriod).toHaveBeenCalledTimes(3);

    const spend = render(<UsageSpendChart daily={[dailyPoint("2026-08-01", 4)]} currency="USD" eurRate={1} bucket="week" onSelectPeriod={onSelectPeriod} />);
    expect(spend.container.querySelector(".chart-col")).toHaveAttribute("role", "button");
    fireEvent.click(spend.container.querySelector(".chart-col")!);
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-07-27", "week");
    spend.rerender(<UsageSpendChart daily={[dailyPoint("2026-08-01", 4)]} currency="USD" eurRate={1} bucket="month" onSelectPeriod={onSelectPeriod} />);
    fireEvent.click(spend.container.querySelector(".chart-col")!);
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-08", "month");
    spend.rerender(<UsageSpendChart daily={[dailyPoint("2026-08-01", 4)]} currency="USD" eurRate={1} bucket="year" onSelectPeriod={onSelectPeriod} />);
    expect(spend.container.querySelector(".chart-col")).not.toHaveAttribute("role", "button");
    fireEvent.click(spend.container.querySelector(".chart-col")!);
    expect(onSelectPeriod).toHaveBeenCalledTimes(5);
    spend.rerender(<UsageSpendChart daily={[dailyPoint("2026-08-01", 4)]} currency="USD" eurRate={1} bucket="day" onSelectPeriod={onSelectPeriod} />);
    fireEvent.click(spend.container.querySelector(".chart-col")!);
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-08-01", "day");
  });

  it("selects daily and cumulative cells, and sends every weekly square to its week boundary", () => {
    const selections: Array<[string, UsagePeriodKind]> = [];
    const onSelectPeriod = vi.fn((key: string, kind: UsagePeriodKind) => selections.push([key, kind]));
    const { container } = render(
      <UsageActivityHeatmap daily={[dailyPoint("2026-08-01", 4)]} harnessId={null} windowEnd="2026-08-01" onSelectPeriod={onSelectPeriod} />,
    );
    const dailyCell = screen.getByRole("gridcell", { name: /tokens on August 1, 2026/i });
    fireEvent.click(dailyCell);
    expect(onSelectPeriod).toHaveBeenCalledWith("2026-08-01", "day");

    fireEvent.click(screen.getByRole("radio", { name: "Cumulative" }));
    fireEvent.click(screen.getByRole("gridcell", { name: /tokens on August 1, 2026/i }));
    expect(onSelectPeriod).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
    const weeklyCells = screen.getAllByRole("gridcell", { name: /tokens in the week of/i });
    fireEvent.click(weeklyCells[0]);
    fireEvent.click(weeklyCells[52]);
    fireEvent.click(weeklyCells[104]);
    expect(selections.slice(-3).map(([, kind]) => kind)).toEqual(["week", "week", "week"]);
    expect(selections.slice(-3).map(([key, kind]) => periodFromKey(kind, key)?.key)).toEqual([
      "2025-08-04",
      "2025-08-04",
      "2025-08-04",
    ]);
    expect(container.querySelector('[role="grid"]')).toBeInTheDocument();
  });

  it("persists heatmap mode through remounts and falls back to daily for invalid storage", () => {
    const props = { daily: [] as UsageDailyPoint[], harnessId: null, windowEnd: "2026-08-01" };
    const first = render(<UsageActivityHeatmap {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
    expect(window.localStorage.getItem("st:usage:heatmapMode")).toBe("weekly");
    first.unmount();

    const second = render(<UsageActivityHeatmap {...props} />);
    expect(screen.getByRole("radio", { name: "Weekly" })).toBeChecked();
    second.unmount();

    window.localStorage.setItem("st:usage:heatmapMode", "invalid");
    render(<UsageActivityHeatmap {...props} />);
    expect(screen.getByRole("radio", { name: "Daily" })).toBeChecked();
  });
});
