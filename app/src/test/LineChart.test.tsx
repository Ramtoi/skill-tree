import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineChart } from "@/components/charts/LineChart";

const series = [
  { id: "a", label: "Alpha", color: "var(--id-0)", points: [{ x: "2026-03-16", y: 10 }, { x: "2026-03-17", y: 4 }] },
  { id: "b", label: "Beta", color: "var(--id-1)", points: [{ x: "2026-03-16", y: 2 }, { x: "2026-03-17", y: 9 }] },
];

afterEach(() => vi.restoreAllMocks());

function movePointer(target: Element, clientX: number, clientY: number): void {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

describe("LineChart", () => {
  it("F1 keeps the ordinary chart rendering contract", () => {
    render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    expect(screen.getByRole("group", { name: "Activity" })).toBeInTheDocument();
  });

  it("F2 shows one vertical guide while a pointer tooltip is active", () => {
    const { container } = render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(area, { clientX: 100, clientY: 10 });
    expect(container.querySelectorAll(".line-chart-guide")).toHaveLength(1);
    fireEvent.pointerLeave(area);
    expect(container.querySelectorAll(".line-chart-guide")).toHaveLength(0);
  });

  it("F3 keeps the roving tab stop after a focused point blurs", () => {
    const { container } = render(<LineChart series={[series[0]]} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const points = container.querySelectorAll<HTMLButtonElement>(".line-chart-point");
    fireEvent.focus(points[1]);
    fireEvent.blur(points[1]);
    expect(points[0]).toHaveAttribute("tabindex", "-1");
    expect(points[1]).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("F4 marks tooltip labels with the row label class", () => {
    const { container } = render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(area, { clientX: 0, clientY: 10 });
    expect(container.querySelector(".chart-tooltip-row-label")).toBeInTheDocument();
  });

  it("shows every series in a pointer tooltip and emphasises the nearest series", () => {
    const { container } = render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} formatX={(x) => `Tip ${x}`} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(area, { clientX: 0, clientY: 10 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tip 2026-03-16");
    expect(screen.getByRole("tooltip").querySelectorAll(".chart-tooltip-row")).toHaveLength(2);
    expect(container.querySelectorAll('.line-chart-line[data-emphasis="true"]')).toHaveLength(1);
  });

  it("moves the informative overlay with the pointer and flips near viewport edges", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("line-chart-tooltip")) {
        return { left: 0, top: 0, width: 160, height: 100, right: 160, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
      }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    const { container } = render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 720, right: 1000, bottom: 720, x: 0, y: 0, toJSON: () => ({}) });

    movePointer(area, 120, 140);
    let tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveStyle({ left: "132px", top: "152px" });
    expect(tooltip).toHaveAttribute("data-side", "right");
    expect(tooltip).toHaveAttribute("data-vertical", "below");

    movePointer(area, 900, 700);
    tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveStyle({ left: "728px", top: "588px" });
    expect(tooltip).toHaveAttribute("data-side", "left");
    expect(tooltip).toHaveAttribute("data-vertical", "above");
  });

  it("R2 hit-tests the interpolated line at fractional x positions", () => {
    const hitSeries = [
      { id: "steep", label: "Steep", color: "red", points: [{ x: "a", y: 0 }, { x: "b", y: 10 }] },
      { id: "flat", label: "Flat", color: "blue", points: [{ x: "a", y: 5 }, { x: "b", y: 5 }] },
    ];
    const { container } = render(<LineChart series={hitSeries} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    const yFor = (value: number) => 8 + (1 - value / 11) * 144;
    movePointer(area, 50, yFor(5));
    expect(container.querySelector('.line-chart-line[data-series="flat"]')).toHaveAttribute("data-emphasis", "true");
    expect(container.querySelector('.line-chart-line[data-series="steep"]')).toHaveAttribute("data-emphasis", "false");
    fireEvent.pointerLeave(area);
    movePointer(area, 50, yFor(2.5));
    expect(container.querySelector('.line-chart-line[data-series="steep"]')).toHaveAttribute("data-emphasis", "true");
    expect(container.querySelector('.line-chart-line[data-series="flat"]')).toHaveAttribute("data-emphasis", "false");
  });

  it("R3 clamps roving state and clears a stale tooltip when the chart shrinks", () => {
    const points = Array.from({ length: 10 }, (_, pointIndex) => ({ x: String(pointIndex), y: pointIndex }));
    const large = [0, 1, 2].map((seriesIndex) => ({
      id: `series-${seriesIndex}`,
      label: `Series ${seriesIndex}`,
      color: `color-${seriesIndex}`,
      points,
    }));
    const { container, rerender } = render(<LineChart series={large} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    fireEvent.focus(container.querySelectorAll<HTMLButtonElement>(".line-chart-point")[29]);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(<LineChart series={[{ ...large[0], points: points.slice(0, 3) }]} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    expect(container.querySelectorAll('.line-chart-point[tabindex="0"]')).toHaveLength(1);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("clears pointer state and emphasises a legend without opening a tooltip", () => {
    const { container } = render(<LineChart series={series} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    const area = container.querySelector(".line-chart-area") as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(area, { clientX: 100, clientY: 10 });
    fireEvent.pointerLeave(area);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Beta").closest(".chart-legend-item")!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByText("Beta").closest(".chart-legend-item")).toHaveAttribute("data-emphasis", "true");
  });

  it("keeps the axis to six labels with edge anchors and supports keyboard focus", () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ x: `2026-03-${String(i + 1).padStart(2, "0")}`, y: i }));
    const { container } = render(<LineChart series={[{ ...series[0], points }]} ariaLabel="Activity" formatValue={(v) => String(v)} />);
    expect(container.querySelectorAll(".line-chart-x-axis span")).toHaveLength(6);
    expect(container.querySelector('.line-chart-x-axis span[data-edge="start"]')).toBeInTheDocument();
    expect(container.querySelector('.line-chart-x-axis span[data-edge="end"]')).toBeInTheDocument();
    fireEvent.focus(container.querySelector(".line-chart-point")!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mar 1");
  });
});
