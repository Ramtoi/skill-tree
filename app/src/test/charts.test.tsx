import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StackedColumnChart, type Series, type Column } from "@/components/charts/StackedColumnChart";
import { HorizontalBarList, type BarRow } from "@/components/charts/HorizontalBarList";
import { CompositionBar, type Segment } from "@/components/charts/CompositionBar";
import { LineChart } from "@/components/charts/LineChart";
import { IDENTITY_SERIES, OTHER_SERIES_COLOR, seriesColorFor } from "@/components/charts/chartColors";

const fmt = (v: number) => `$${v.toFixed(2)}`;

const twoSeries: Series[] = [
  { id: "claude-code", label: "Claude Code", color: "var(--id-0)" },
  { id: "codex", label: "Codex", color: "var(--id-1)" },
];

function makeColumns(n: number): Column[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `d${i}`,
    label: `${i}`,
    tooltipLabel: `Day ${i}`,
    values: { "claude-code": i + 1, codex: (i % 3) + 1 },
  }));
}

function movePointer(target: Element, clientX: number, clientY: number): void {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

describe("StackedColumnChart", () => {
  it("renders a legend only with 2+ series, none with 1", () => {
    const { rerender } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();

    rerender(
      <StackedColumnChart
        series={[twoSeries[0]]}
        columns={makeColumns(3)}
        format={fmt}
        ariaLabel="Spend"
      />,
    );
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  });

  it("renders a one-series legend when requested", () => {
    const { container } = render(
      <StackedColumnChart
        series={[twoSeries[0]]}
        columns={makeColumns(3)}
        format={fmt}
        ariaLabel="Spend"
        legend="always"
      />,
    );
    expect(container.querySelectorAll(".chart-legend-item")).toHaveLength(1);
    expect(container.querySelector(".chart-legend-label")).toHaveTextContent("Claude Code");
  });

  it("renders marker counts, announces them, and lists marker rows in the tooltip", () => {
    const columns: Column[] = [{
      key: "d0", label: "0", tooltipLabel: "Day 0", values: { "claude-code": 1 },
      markers: [
        { id: "m1", label: "Loadout changed", harness: "claude-code" },
        { id: "m2", label: "Loadout changed", harness: "codex" },
      ],
    }];
    const { container } = render(
      <StackedColumnChart series={[twoSeries[0]]} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const column = container.querySelector(".chart-col")!;
    expect(column.querySelector(".chart-col-marker")).toHaveAttribute("data-count", "2");
    expect(column).toHaveAttribute("aria-label", expect.stringContaining(" · 2 loadout changes"));
    fireEvent.mouseEnter(column);
    expect(screen.getAllByText("Loadout changed")).toHaveLength(2);
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("places a marker at the baseline for a zero column", () => {
    const columns: Column[] = [{
      key: "z", label: "0", tooltipLabel: "Day 0", values: {},
      markers: [{ id: "m1", label: "Loadout changed" }],
    }];
    const { container } = render(
      <StackedColumnChart series={[twoSeries[0]]} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelector(".chart-col-marker")).toHaveStyle({ bottom: "0%" });
  });

  it("renders one column per entry and one segment per non-zero series", () => {
    const columns = makeColumns(4);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelectorAll(".chart-col")).toHaveLength(4);
    // every column has values for both series (both > 0) → 2 segments each
    expect(container.querySelectorAll("[data-series]")).toHaveLength(8);
    expect(container.querySelectorAll('[data-series="claude-code"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-series="codex"]')).toHaveLength(4);
  });

  it("shows the tooltip text on hover and on focus", () => {
    const columns = makeColumns(3);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const cols = container.querySelectorAll(".chart-col");
    fireEvent.mouseEnter(cols[0]);
    let tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Day 0");
    fireEvent.mouseLeave(cols[0]);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(cols[2]);
    tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Day 2");
    fireEvent.blur(cols[2]);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("follows the pointer and flips inside the viewport", () => {
    const columns = makeColumns(4);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    const tooltipElement = container.querySelector(".chart-tooltip") as HTMLElement;
    tooltipElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 120, right: 200, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.mouseEnter(cols[0]);
    movePointer(cols[0], 120, 140);
    let tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveStyle({ left: "132px", top: "152px" });
    expect(tooltip).toHaveAttribute("data-side", "right");
    expect(tooltip).toHaveAttribute("data-vertical", "below");

    movePointer(cols[0], 900, 700);
    tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveStyle({ left: "688px", top: "568px" });
    expect(tooltip).toHaveAttribute("data-side", "left");
    expect(tooltip).toHaveAttribute("data-vertical", "above");
  });

  it("hands a parked pointer's tooltip to keyboard navigation", () => {
    const columns = makeColumns(3);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll<HTMLElement>(".chart-col");
    fireEvent.mouseEnter(cols[0]);
    movePointer(cols[0], 120, 140);
    act(() => cols[0].focus());
    fireEvent.keyDown(cols[0], { key: "ArrowRight" });

    expect(document.activeElement).toBe(cols[1]);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Day 1");
    expect(cols[1]).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
  });

  it("thins x-axis labels past ~24 columns but keeps every column interactive", () => {
    const columns = makeColumns(40);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelectorAll(".chart-col")).toHaveLength(40);
    // k = ceil(40/12) = 4 → labels at 0,4,...,36 = 10 labels
    expect(container.querySelectorAll(".chart-col-label")).toHaveLength(10);
    // every column still carries a tooltip-triggering aria-label
    container.querySelectorAll(".chart-col").forEach((col) => {
      expect(col).toHaveAttribute("aria-label");
    });
  });

  it("renders emptyText when there are no columns", () => {
    render(
      <StackedColumnChart
        series={twoSeries}
        columns={[]}
        format={fmt}
        ariaLabel="Spend"
        emptyText="Nothing yet"
      />,
    );
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });

  it("renders a baseline stub for a zero-total column", () => {
    const columns: Column[] = [{ key: "z", label: "0", tooltipLabel: "Day 0", values: {} }];
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelector(".chart-col-stub")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-series]")).toHaveLength(0);
  });

  it("keeps finite geometry for a single all-zero column", () => {
    // The narrowest real case: one bucket, nothing spent in it. maxTotal
    // floors at 1 so the axis still reads, the bar is the baseline stub, and
    // no percentage can come out NaN.
    const columns: Column[] = [
      { key: "z", label: "0", tooltipLabel: "Day 0", values: { "claude-code": 0, codex: 0 } },
    ];
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelector(".chart-col-stub")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-series]")).toHaveLength(0);
    expect(container.querySelector(".chart-col")!.getAttribute("aria-label")).toBe(`Day 0: ${fmt(0)}`);
    Array.from(container.querySelectorAll(".chart-grid-label")).forEach((label) => {
      expect(label.textContent).not.toContain("NaN");
    });
  });

  it("treats a non-finite or negative value as zero", () => {
    // `values` comes from a normalizer over a user-editable cache. One NaN
    // used to poison maxTotal and render every segment at height "NaN%";
    // a negative value used to subtract from the announced total.
    const columns: Column[] = [
      { key: "bad", label: "b", tooltipLabel: "Bad", values: { "claude-code": Number.NaN, codex: -5 } },
      { key: "good", label: "g", tooltipLabel: "Good", values: { "claude-code": 10, codex: 10 } },
    ];
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    expect(cols[0].getAttribute("aria-label")).toBe(`Bad: ${fmt(0)}`);
    expect(cols[1].getAttribute("aria-label")).toBe(`Good: ${fmt(20)}`);
    // The bad column contributes no segments at all, and the good one scales
    // against its own total rather than against NaN.
    expect(cols[0].querySelectorAll("[data-series]")).toHaveLength(0);
    Array.from(container.querySelectorAll<HTMLElement>("[data-series]")).forEach((seg) => {
      expect(seg.style.height).toMatch(/^[\d.]+%$/);
    });
    // Both legend totals read through the same clamp: the bad column adds
    // nothing, so each series totals only its 10 from the good column.
    expect(
      Array.from(container.querySelectorAll(".chart-legend-value")).map((el) => el.textContent),
    ).toEqual([fmt(10), fmt(10)]);
  });

  it("renders every series past the identity ramp's eight slots", () => {
    const many: Series[] = Array.from({ length: 9 }, (_, i) => ({
      id: `h${i}`,
      label: `H${i}`,
      color: `var(--id-${i})`,
    }));
    const columns: Column[] = [
      {
        key: "d0",
        label: "0",
        tooltipLabel: "Day 0",
        values: Object.fromEntries(many.map((s) => [s.id, 1])),
      },
    ];
    const { container } = render(
      <StackedColumnChart series={many} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    expect(container.querySelectorAll("[data-series]")).toHaveLength(9);
    expect(container.querySelectorAll(".chart-legend-item")).toHaveLength(9);
  });

  it("dismisses the tooltip on Escape without giving up the column's focus", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const col = container.querySelectorAll(".chart-col")[0] as HTMLElement;
    fireEvent.focus(col);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(col, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("points the active column at the live tooltip with aria-describedby", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    expect(cols[0]).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(cols[0]);
    const tip = screen.getByRole("tooltip");
    expect(cols[0].getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.id).toBeTruthy();
    // Only the active column carries the relationship.
    expect(cols[1]).not.toHaveAttribute("aria-describedby");
  });

  it("aria-labels carry the formatted total", () => {
    const columns = makeColumns(1); // claude-code:1, codex:1 → total 2
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const col = container.querySelector(".chart-col")!;
    expect(col.getAttribute("aria-label")).toContain(fmt(2));
  });

  it("a backfilled column renders data-provenance='backfilled'; one with no provenance renders no attribute", () => {
    const columns: Column[] = [
      { key: "b", label: "b", tooltipLabel: "Backfilled", values: { "claude-code": 1 }, provenance: "backfilled" },
      { key: "n", label: "n", tooltipLabel: "None", values: { "claude-code": 1 } },
    ];
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    expect(cols[0]).toHaveAttribute("data-provenance", "backfilled");
    expect(cols[1]).not.toHaveAttribute("data-provenance");
  });
});

describe("StackedColumnChart hover with insight", () => {
  const oneSeries: Series[] = [{ id: "claude-code", label: "Claude Code", color: "var(--id-0)" }];

  function deltaColumns(prev: number, current: number): Column[] {
    return [
      { key: "d0", label: "0", tooltipLabel: "Day 0", values: { "claude-code": prev } },
      { key: "d1", label: "1", tooltipLabel: "Day 1", values: { "claude-code": current } },
    ];
  }

  it("shows an up-delta line under the total", () => {
    const { container } = render(
      <StackedColumnChart series={oneSeries} columns={deltaColumns(100, 123)} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[1]);
    expect(container.querySelector(".chart-tooltip-delta")!.textContent).toBe("▲ 23% vs previous");
  });

  it("shows a down-delta line under the total", () => {
    const { container } = render(
      <StackedColumnChart series={oneSeries} columns={deltaColumns(100, 88)} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[1]);
    expect(container.querySelector(".chart-tooltip-delta")!.textContent).toBe("▼ 12% vs previous");
  });

  it("shows 'no change' when the total is exactly the same as the previous column", () => {
    const { container } = render(
      <StackedColumnChart series={oneSeries} columns={deltaColumns(100, 100)} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[1]);
    expect(container.querySelector(".chart-tooltip-delta")!.textContent).toBe("no change");
  });

  it("omits the delta line for the first column", () => {
    const { container } = render(
      <StackedColumnChart series={oneSeries} columns={deltaColumns(100, 123)} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[0]);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(container.querySelector(".chart-tooltip-delta")).not.toBeInTheDocument();
  });

  it("omits the delta line when the previous column's total is zero", () => {
    const columns: Column[] = [
      { key: "d0", label: "0", tooltipLabel: "Day 0", values: {} },
      { key: "d1", label: "1", tooltipLabel: "Day 1", values: { "claude-code": 50 } },
    ];
    const { container } = render(
      <StackedColumnChart series={oneSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[1]);
    expect(container.querySelector(".chart-tooltip-delta")).not.toBeInTheDocument();
  });

  it("each tooltip row shows the series' value and its share of the column", () => {
    const columns: Column[] = [
      { key: "d0", label: "0", tooltipLabel: "Day 0", values: { "claude-code": 74, codex: 26 } },
    ];
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    fireEvent.mouseEnter(container.querySelectorAll(".chart-col")[0]);
    const rows = container.querySelectorAll(".chart-tooltip-row");
    expect(rows[0].querySelector(".chart-tooltip-row-value")!.textContent).toBe(`${fmt(74)} · 74%`);
    expect(rows[1].querySelector(".chart-tooltip-row-value")!.textContent).toBe(`${fmt(26)} · 26%`);
  });

  it("marks the hovered/focused column with data-active for the wash", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    expect(cols[0]).not.toHaveAttribute("data-active");

    fireEvent.mouseEnter(cols[0]);
    expect(cols[0]).toHaveAttribute("data-active", "true");
    expect(cols[1]).not.toHaveAttribute("data-active");

    fireEvent.mouseLeave(cols[0]);
    expect(cols[0]).not.toHaveAttribute("data-active");
  });

  it("stamps data-has-active on the column row while one column is active, so the others recede", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const row = container.querySelector(".chart-columns")!;
    const cols = container.querySelectorAll(".chart-col");
    expect(row).not.toHaveAttribute("data-has-active");

    fireEvent.mouseEnter(cols[1]);
    expect(row).toHaveAttribute("data-has-active", "true");

    fireEvent.mouseLeave(cols[1]);
    expect(row).not.toHaveAttribute("data-has-active");

    // Keyboard focus counts as active too — the receded columns must follow
    // the same signal the tooltip follows.
    fireEvent.focus(cols[2]);
    expect(row).toHaveAttribute("data-has-active", "true");
    fireEvent.keyDown(cols[2], { key: "Escape" });
    expect(row).not.toHaveAttribute("data-has-active");
  });

  it("hovering a segment fades every other series' segments everywhere and emphasizes its own tooltip row", () => {
    const columns = makeColumns(3);
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    fireEvent.mouseEnter(cols[0]); // activate the column so the tooltip is visible
    const seg = cols[0].querySelector('[data-series="claude-code"]') as HTMLElement;
    fireEvent.mouseEnter(seg);

    // Every codex segment, in every column, is faded — no claude-code segment is.
    const codexSegs = container.querySelectorAll('[data-series="codex"]');
    expect(codexSegs.length).toBeGreaterThan(0);
    codexSegs.forEach((el) => expect(el).toHaveAttribute("data-faded", "true"));
    container.querySelectorAll('[data-series="claude-code"]').forEach((el) => {
      expect(el).not.toHaveAttribute("data-faded");
    });

    const rows = container.querySelectorAll(".chart-tooltip-row");
    const claudeRow = Array.from(rows).find((r) => r.textContent?.includes("Claude Code"))!;
    const codexRow = Array.from(rows).find((r) => r.textContent?.includes("Codex"))!;
    expect(claudeRow).toHaveAttribute("data-emphasis", "true");
    expect(codexRow).not.toHaveAttribute("data-emphasis");

    // relatedTarget tells the (real, capture-phase) enter/leave algorithm the
    // pointer is moving to the still-hovered parent column, not away from it
    // entirely — matching a real mouse move from the segment back onto its
    // own column, which must not also clear the column's own hover.
    fireEvent.mouseLeave(seg, { relatedTarget: cols[0] });
    expect(container.querySelectorAll('[data-faded="true"]')).toHaveLength(0);
    expect(container.querySelector(".chart-tooltip-row[data-emphasis]")).not.toBeInTheDocument();
  });

  it("hovering a legend item does the same fading as hovering its segment", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const legendItems = container.querySelectorAll(".chart-legend-item");
    const claudeItem = Array.from(legendItems).find((el) => el.textContent?.includes("Claude Code"))!;

    fireEvent.mouseEnter(claudeItem);
    expect(claudeItem).toHaveAttribute("data-emphasis", "true");
    container.querySelectorAll('[data-series="codex"]').forEach((el) => {
      expect(el).toHaveAttribute("data-faded", "true");
    });

    fireEvent.mouseLeave(claudeItem);
    expect(claudeItem).not.toHaveAttribute("data-emphasis");
    expect(container.querySelectorAll('[data-faded="true"]')).toHaveLength(0);
  });

  it("ArrowRight/ArrowLeft on a focused column focuses its neighbour", () => {
    const { container } = render(
      <StackedColumnChart series={twoSeries} columns={makeColumns(3)} format={fmt} ariaLabel="Spend" />,
    );
    const cols = container.querySelectorAll(".chart-col");
    act(() => (cols[0] as HTMLElement).focus());
    expect(document.activeElement).toBe(cols[0]);

    fireEvent.keyDown(cols[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(cols[1]);

    fireEvent.keyDown(cols[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cols[0]);

    // No neighbour past the last column — focus stays put.
    act(() => (cols[2] as HTMLElement).focus());
    fireEvent.keyDown(cols[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(cols[2]);
  });
});

describe("HorizontalBarList", () => {
  const rows: BarRow[] = [
    { key: "a", label: "Alpha", value: 100, display: "$100" },
    { key: "b", label: "Beta", value: 50, display: "$50" },
    { key: "c", label: "Gamma", value: 25, display: "$25" },
  ];

  it("scales fill widths proportionally to the max", () => {
    const { container } = render(<HorizontalBarList rows={rows} ariaLabel="Top" />);
    const fills = container.querySelectorAll<HTMLElement>(".hbar-fill");
    expect(fills[0].style.width).toBe("100%");
    expect(fills[1].style.width).toBe("50%");
    expect(fills[2].style.width).toBe("25%");
  });

  it("renders the display text for each row", () => {
    render(<HorizontalBarList rows={rows} ariaLabel="Top" />);
    expect(screen.getByText("$100")).toBeInTheDocument();
    expect(screen.getByText("$50")).toBeInTheDocument();
    expect(screen.getByText("$25")).toBeInTheDocument();
  });

  it("honors an explicit max override", () => {
    const { container } = render(<HorizontalBarList rows={rows} ariaLabel="Top" max={200} />);
    const fills = container.querySelectorAll<HTMLElement>(".hbar-fill");
    expect(fills[0].style.width).toBe("50%");
  });

  it("does not let one bad value flatten every other bar", () => {
    // A NaN row used to make the derived max NaN, which failed the `> 0`
    // guard for the whole list — every bar rendered at 0%.
    const withBad: BarRow[] = [
      { key: "bad", label: "Bad", value: Number.NaN, display: "—" },
      { key: "a", label: "Alpha", value: 100, display: "$100" },
      { key: "b", label: "Beta", value: 50, display: "$50" },
    ];
    const { container } = render(<HorizontalBarList rows={withBad} ariaLabel="Top" />);
    const fills = container.querySelectorAll<HTMLElement>(".hbar-fill");
    expect(fills[0].style.width).toBe("0%");
    expect(fills[1].style.width).toBe("100%");
    expect(fills[2].style.width).toBe("50%");
  });

  it("the row's title is the display text by default", () => {
    const { container } = render(<HorizontalBarList rows={rows} ariaLabel="Top" />);
    expect(container.querySelectorAll(".hbar-row")[0]).toHaveAttribute("title", "$100");
  });

  it("titleText overrides the title when display is itself compacted", () => {
    const withTitleText: BarRow[] = [
      { key: "a", label: "Alpha", value: 29_500_000_000, display: "29.5B", titleText: "29,500,000,000" },
    ];
    const { container } = render(<HorizontalBarList rows={withTitleText} ariaLabel="Top" />);
    expect(container.querySelector(".hbar-row")).toHaveAttribute("title", "29,500,000,000");
  });
});

describe("CompositionBar", () => {
  const segments: Segment[] = [
    { id: "input", label: "Input", value: 60, color: "var(--id-0)" },
    { id: "output", label: "Output", value: 40, color: "var(--id-1)" },
    { id: "cache", label: "Cache", value: 0, color: "var(--id-2)" },
  ];

  it("drops zero-value segments from the bar but keeps them in the legend", () => {
    const { container } = render(<CompositionBar segments={segments} format={String} ariaLabel="Mix" />);
    expect(container.querySelectorAll(".comp-bar-seg")).toHaveLength(2);
    expect(container.querySelectorAll(".comp-bar-legend-item")).toHaveLength(3);
    expect(screen.getByText("Cache")).toBeInTheDocument();
  });

  it("sums legend percentages to exactly 100", () => {
    const { container } = render(<CompositionBar segments={segments} format={String} ariaLabel="Mix" />);
    const pcts = Array.from(container.querySelectorAll(".comp-bar-legend-pct")).map((el) =>
      Number(el.textContent!.replace("%", "")),
    );
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("sums to exactly 100 for shares that do not round cleanly", () => {
    // Three equal thirds independently rounded print 33/33/33 = 99% on a bar
    // whose whole claim is that it accounts for everything.
    const thirds: Segment[] = [
      { id: "a", label: "A", value: 1, color: "var(--id-0)" },
      { id: "b", label: "B", value: 1, color: "var(--id-1)" },
      { id: "c", label: "C", value: 1, color: "var(--id-2)" },
    ];
    const { container } = render(<CompositionBar segments={thirds} format={String} ariaLabel="Mix" />);
    const pcts = Array.from(container.querySelectorAll(".comp-bar-legend-pct")).map((el) =>
      Number(el.textContent!.replace("%", "")),
    );
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(pcts.filter((p) => p === 34)).toHaveLength(1);
  });

  it("renders an empty bar and 0% everywhere when every segment is zero", () => {
    const empty: Segment[] = [
      { id: "a", label: "A", value: 0, color: "var(--id-0)" },
      { id: "b", label: "B", value: 0, color: "var(--id-1)" },
    ];
    const { container } = render(<CompositionBar segments={empty} format={String} ariaLabel="Mix" />);
    // No segment is drawn (the .comp-bar keeps its own --bg-3 track), and no
    // percentage comes out NaN.
    expect(container.querySelectorAll(".comp-bar-seg")).toHaveLength(0);
    expect(container.querySelector(".comp-bar")).toBeInTheDocument();
    Array.from(container.querySelectorAll(".comp-bar-legend-pct")).forEach((el) => {
      expect(el.textContent).toBe("0%");
    });
  });
});

describe("charts.css color contract", () => {
  it("has no color literals — every color is a CSS variable", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "charts.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });

  it("has no radius literal on a mark — the 4px data end is --radius-sm", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "charts.css"), "utf8");
    expect(css).not.toMatch(/border-radius:\s*4px/);
  });
});

describe("usage.css color contract", () => {
  it("has no color literals — every color is a CSS variable or a color-mix of tokens", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "screens", "usage.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });

  it("never reaches for the raw brand triad or a section hue from body content", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "screens", "usage.css"), "utf8");
    expect(css).not.toMatch(/var\(--violet/);
    expect(css).not.toMatch(/var\(--sec(tion)?[-)]/);
  });
});

// ─── x-label thinning: the JS step and the CSS sweep, together ────────────
// `StackedColumnChart` renders a label only every `labelStep`-th column
// (step = ceil(n/12) past 24 columns); charts.css then hides every SECOND
// rendered label inside a narrow content column. The two thin the same axis
// and only the product of them is what a reader sees, so the product is what
// is pinned here.

/** The 0-based column indices that still carry a VISIBLE label at <600px. */
function visibleLabelIndices(n: number): number[] {
  const step = n > 24 ? Math.ceil(n / 12) : 1;
  const rendered: number[] = [];
  for (let i = 0; i < n; i++) if (i % step === 0) rendered.push(i);
  // The CSS sweep is gated on a quantity query: nothing is hidden below 8
  // columns; from 8 up, every even `nth-child` (odd 0-based index) goes.
  if (n < 8) return rendered;
  return rendered.filter((i) => i % 2 === 0);
}

describe("StackedColumnChart x-label thinning", () => {
  function renderedLabelCount(n: number): number {
    const columns: Column[] = Array.from({ length: n }, (_, i) => ({
      key: `k${i}`,
      label: `L${i}`,
      tooltipLabel: `T${i}`,
      values: { "claude-code": 10 },
    }));
    const { container, unmount } = render(
      <StackedColumnChart series={twoSeries} columns={columns} format={fmt} ariaLabel="C" />,
    );
    const count = container.querySelectorAll(".chart-col-label").length;
    unmount();
    return count;
  }

  it("renders at most ~12 labels however many columns there are", () => {
    expect(renderedLabelCount(14)).toBe(14);
    expect(renderedLabelCount(24)).toBe(24);
    expect(renderedLabelCount(25)).toBe(9); // step 3
    expect(renderedLabelCount(30)).toBe(10); // step 3
    expect(renderedLabelCount(60)).toBe(12); // step 5
  });

  it("never leaves fewer than four visible labels once the CSS sweep applies", () => {
    // 1..4 columns is the case a month/year bucket reaches (2 years = 2
    // columns): thinning them would leave one label, so the sweep is gated
    // off entirely below 8.
    for (let n = 1; n <= 7; n++) {
      expect(visibleLabelIndices(n).length).toBe(n);
    }
    for (const n of [8, 9, 12, 14, 20, 24, 25, 30, 36, 48, 60, 105, 730]) {
      expect(visibleLabelIndices(n).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("the CSS gates the sweep on a quantity query, not on nth-child alone", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "charts.css"), "utf8");
    const block = css.match(/@container appmain \(max-width: 600px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(block).toContain("nth-last-child(n + 8)");
    expect(block).toMatch(/nth-child\(even\)[\s\S]*visibility:\s*hidden/);
    // A bare `.chart-col:nth-child(even)` rule would hide half of a two-column
    // year chart; the quantity query is the whole guard.
    expect(block).not.toMatch(/^\s*\.chart-col:nth-child\(even\)/m);
  });
});

describe("LineChart", () => {
  const lineSeries = [
    { id: "a", label: "A", color: "var(--id-0)", points: [{ x: "2026-01-02", y: 2 }, { x: "2026-01-01", y: 1 }] },
    { id: "b", label: "B", color: "var(--id-1)", points: [{ x: "2026-01-02", y: 0 }] },
  ];

  it("uses the sorted union domain and zero-fills missing points", () => {
    const { container } = render(<LineChart series={lineSeries} ariaLabel="Trend" formatValue={fmt} />);
    expect(container.querySelectorAll(".line-chart-point")).toHaveLength(4);
    expect(container.querySelector('[data-series="a"][data-x="2026-01-01"]')).toBeInTheDocument();
    expect(container.querySelector('[data-series="b"][data-x="2026-01-01"]')).toHaveAttribute("aria-label", "B, 2026-01-01: $0.00");
  });

  it("has one tab stop and moves across points and series", () => {
    const { container } = render(<LineChart series={lineSeries} ariaLabel="Trend" formatValue={fmt} />);
    expect(container.querySelectorAll('.line-chart-point[tabindex="0"]')).toHaveLength(1);
    const first = container.querySelector('.line-chart-point[tabindex="0"]') as HTMLElement;
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(container.querySelector('[data-series="a"][data-x="2026-01-02"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(container.querySelector('[data-series="b"][data-x="2026-01-02"]')).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveAttribute("id");
  });

  it("centres a one-point series and renders the empty state", () => {
    const { container, rerender } = render(<LineChart series={[{ ...lineSeries[0], points: [{ x: "only", y: 0 }] }]} ariaLabel="Trend" formatValue={fmt} />);
    expect(container.querySelector(".line-chart-point")).toHaveStyle({ left: "50%" });
    rerender(<LineChart series={[]} ariaLabel="Trend" formatValue={fmt} emptyText="No events" />);
    expect(screen.getByText("No events")).toBeInTheDocument();
  });
});

describe("seriesColorFor", () => {
  it("is stable across calls and input order", () => {
    const ids = ["model-a", "model-b", "model-c"];
    const first = ids.map((id) => seriesColorFor(id));
    const second = [...ids].reverse().map((id) => seriesColorFor(id));
    expect(first).toEqual([...second].reverse());
    expect(seriesColorFor("model-a")).toBe(seriesColorFor("model-a"));
  });

  it("resolves known hash collisions into unused identity slots", () => {
    const ids = ["sonnet-5", "opus-5", "fable-5.1", "fable-5", "gpt-6-astra"];
    const colors = ids.map((id) => seriesColorFor(id, IDENTITY_SERIES, ids));
    expect(new Set(colors).size).toBe(ids.length);
    expect(colors).not.toContain(OTHER_SERIES_COLOR);
    const reversed = [...ids].reverse();
    expect(Object.fromEntries(reversed.map((id) => [id, seriesColorFor(id, IDENTITY_SERIES, reversed)])))
      .toEqual(Object.fromEntries(ids.map((id) => [id, seriesColorFor(id, IDENTITY_SERIES, ids)])));
  });

  it("reserves Other and folds only true palette overflow", () => {
    const ids = ["a", "b", "c"];
    const palette = IDENTITY_SERIES.slice(0, 2);
    expect(ids.map((id) => seriesColorFor(id, palette, ids)).filter((color) => color === OTHER_SERIES_COLOR)).toHaveLength(1);
    expect(seriesColorFor("Other", palette)).toBe(OTHER_SERIES_COLOR);
  });
});
