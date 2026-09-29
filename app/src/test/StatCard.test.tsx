import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatCard } from "@/components/StatCard";

describe("StatCard", () => {
  it("stamps an optional title on the hero value, for the exact figure a compacted value rounds away", () => {
    render(<StatCard label="Tokens" value="29.5B" title="29,500,000,000" />);
    expect(screen.getByText("29.5B")).toHaveAttribute("title", "29,500,000,000");
  });

  it("omits the title attribute when none is given", () => {
    render(<StatCard label="Sessions" value="42" />);
    const value = screen.getByText("42");
    expect(value.hasAttribute("title")).toBe(false);
  });
});

describe("StatCard clauses", () => {
  it("renders each clause in its own .stat-clause with a middot .stat-sep between", () => {
    const { container } = render(
      <StatCard label="Tokens" value="4" clauses={["18% output", "6% cache read"]} />,
    );
    const sub = container.querySelector(".sub")!;
    const clauses = sub.querySelectorAll(".stat-clause");
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toHaveTextContent("18% output");
    expect(clauses[1]).toHaveTextContent("6% cache read");
    expect(sub.querySelectorAll(".stat-sep")).toHaveLength(1);
    expect(sub.textContent).toBe("18% output · 6% cache read");
  });

  it("a single clause renders with no separator", () => {
    const { container } = render(<StatCard label="Sessions" value="8" clauses={["across 3 harnesses"]} />);
    const sub = container.querySelector(".sub")!;
    expect(sub.querySelectorAll(".stat-clause")).toHaveLength(1);
    expect(sub.querySelectorAll(".stat-sep")).toHaveLength(0);
  });

  it("a clause is an inline-block that moves whole to the next line, and only wraps inside itself when wider than the tile", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "rows-cards.css"), "utf8");
    expect(css).toMatch(/\.stat-card \.stat-clause \{ display: inline-block; white-space: normal; \}/);
    // A nowrap clause ran out of the tile once the card showed its overflow.
    expect(css).not.toMatch(/\.stat-clause \{ white-space: nowrap/);
  });

  it("still renders a plain sub string when clauses is omitted", () => {
    render(<StatCard label="Cache hit rate" value="7%" sub="of prompt tokens read from cache" />);
    expect(screen.getByText("of prompt tokens read from cache")).toBeInTheDocument();
  });

  it("clauses wins when both sub and clauses are passed", () => {
    render(<StatCard label="Tokens" value="4" sub="fallback" clauses={["a", "b"]} />);
    expect(screen.queryByText("fallback")).not.toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });
});

describe("five-tile KPI row rebalancing (COMPONENTS.md §Layout > Tile rows fill)", () => {
  const rows = () => readFileSync(join(process.cwd(), "src", "styles", "rows-cards.css"), "utf8");
  const usage = () => readFileSync(join(process.cwd(), "src", "styles", "screens", "usage.css"), "utf8");

  it("`.tile-row` is an inline-size container named tilerow", () => {
    const css = rows();
    expect(css).toMatch(/\.tile-row \{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.tile-row \{[^}]*container-name:\s*tilerow/);
  });

  it("steps to 3+2 once five tiles no longer fit (947px = 5×180 + 4×12 − 1)", () => {
    const css = usage();
    const step = css.match(/@container tilerow \(max-width: 947px\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(step).toMatch(/flex-basis:\s*calc\(\(100% - 2 \* 12px\) \/ 3\)/);
  });

  it("steps to halves once three no longer fit (563px = 3×180 + 2×12), pulling the accent tile full-width and first", () => {
    const css = usage();
    const step = css.match(/@container tilerow \(max-width: 563px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(step).toMatch(/flex-basis:\s*calc\(\(100% - 12px\) \/ 2\)/);
    expect(step).toMatch(/\.usage-kpis > \.stat-card\.accent \{ flex-basis: 100%; order: -1; \}/);
  });
});

describe("harness row meta stacking (usage.css)", () => {
  const usage = () => readFileSync(join(process.cwd(), "src", "styles", "screens", "usage.css"), "utf8");

  it("`.usage-harness-row` is an inline-size container named harnessrow", () => {
    const css = usage();
    expect(css).toMatch(/\.usage-harness-row \{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.usage-harness-row \{[^}]*container-name:\s*harnessrow/);
  });

  it("stacks the meta clauses and hides separators once the row is narrow", () => {
    const css = usage();
    const step = css.match(/@container harnessrow \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(step).toMatch(/\.usage-harness-meta \{ flex-direction: column; gap: 2px; \}/);
    expect(step).toMatch(/\.usage-harness-sep \{ display: none; \}/);
  });
});

describe("stat card container-query contract", () => {
  it("is its own inline-size container, steps the hero type down by value length, and once more when the card is narrow", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "rows-cards.css"), "utf8");
    expect(css).toMatch(/\.stat-card\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.stat-card\s*\{[^}]*container-name:\s*statcard/);
    expect(css).toMatch(/\.stat-card\[data-value-len="long"\] \.value \{ font-size: var\(--fs-d-12\)/);
    expect(css).toMatch(/\.stat-card\[data-value-len="xlong"\] \.value \{ font-size: var\(--fs-d-9\)/);
    expect(css).toMatch(/@container statcard \(max-width: 150px\)/);
    expect(css).not.toMatch(/@container statcard \(max-width: 230px\)/);
  });

  it("stamps the value's length band so a short hero beside a long one keeps its full size", () => {
    const { container, rerender } = render(<StatCard label="Cost" value="$693.75" />);
    expect(container.querySelector(".stat-card")?.getAttribute("data-value-len")).toBeNull();
    rerender(<StatCard label="Tokens" value="1,234,567" />);
    expect(container.querySelector(".stat-card")?.getAttribute("data-value-len")).toBe("long");
    rerender(<StatCard label="Cost" value="$3,885,000.00" />);
    expect(container.querySelector(".stat-card")?.getAttribute("data-value-len")).toBe("xlong");
    rerender(<StatCard label="Cost" value={<span>a very long custom node value</span>} />);
    expect(container.querySelector(".stat-card")?.getAttribute("data-value-len")).toBeNull();
  });

  it("the value ellipsizes past its two type-scale shrink steps — never a literal px override", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "rows-cards.css"), "utf8");
    const valueRule = css.match(/\.stat-card \.value\s*\{[^}]*\}/)?.[0] ?? "";
    expect(valueRule).toMatch(/overflow:\s*hidden/);
    expect(valueRule).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("stat-card container blast radius", () => {
  const rowsCards = () => readFileSync(join(process.cwd(), "src", "styles", "rows-cards.css"), "utf8");

  it("the container name does not collide with any other named container", () => {
    const files = [
      ["src", "styles", "rows-cards.css"],
      ["src", "styles", "shell-scaffold.css"],
      ["src", "styles", "editor.css"],
      ["src", "styles", "screens", "harnesses.css"],
      ["src", "styles", "screens", "project-workspace.css"],
    ];
    const names = files.flatMap((parts) =>
      [...readFileSync(join(process.cwd(), ...parts), "utf8").matchAll(/container-name:\s*([\w-]+)/g)].map(
        (m) => m[1],
      ),
    );
    // statcard, appmain, editorpane, harnesscard, areastrip — one each.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("statcard");
  });

  it("`.area-card` gives the container type back up — its escaping menu needs the card NOT to be a stacking context", () => {
    // `container-type` carries layout containment, which makes the element a
    // stacking context. `.harness-add-menu` is `position: absolute` with
    // `z-index: --z-menu` INSIDE an area card and must paint over the sibling
    // cards to its right; trapped in the card's own stacking context it would
    // slide underneath them.
    const css = readFileSync(
      join(process.cwd(), "src", "styles", "screens", "project-workspace.css"),
      "utf8",
    );
    const rule = css.match(/^\.area-card\s*\{[^}]*\}/m)?.[0] ?? "";
    expect(rule).toMatch(/container-type:\s*normal/);
    expect(rule).toMatch(/overflow:\s*visible/);
  });

  it("`.harness-card` keeps its own container name, so its own query still resolves", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "screens", "harnesses.css"), "utf8");
    const rule = css.match(/^\.harness-card\s*\{[^}]*\}/m)?.[0] ?? "";
    expect(rule).toMatch(/container-name:\s*harnesscard/);
    // Loaded after rows-cards.css (see styles/index.css), so this wins.
    const index = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");
    expect(index.indexOf("rows-cards.css")).toBeLessThan(index.indexOf("screens/harnesses.css"));
    expect(index.indexOf("rows-cards.css")).toBeLessThan(index.indexOf("screens/project-workspace.css"));
  });

  it("the shrink steps stay on the type scale — never a raw px font-size", () => {
    const steps = [...rowsCards().matchAll(/@container statcard \([^)]*\)\s*\{([^}]*)\}/g)].map(
      (m) => m[1],
    );
    expect(steps.length).toBe(2);
    for (const body of steps) {
      expect(body).toMatch(/font-size:\s*var\(--fs-[\w-]+\)/);
      expect(body).not.toMatch(/font-size:\s*\d/);
    }
  });
});

describe("tile rows fill (COMPONENTS.md §Layout > Tile rows fill)", () => {
  const css = (f: string) => readFileSync(join(process.cwd(), "src", "styles", f), "utf8");

  it("defines the tile-row rule once, as a wrapping flex row whose tiles grow to fill", () => {
    const rows = css("rows-cards.css");
    expect(rows).toMatch(/\.tile-row \{\s*display: flex; flex-wrap: wrap;/);
    expect(rows).toMatch(/\.tile-row > \* \{ flex: 1 1 var\(--tile-min, 180px\); min-width: 0; \}/);
  });

  it("no stat tile row still uses an auto-fit grid that can orphan a tile", () => {
    for (const f of ["screens/usage.css", "screens/styleguide.css", "screens/harnesses.css"]) {
      expect(css(f), f).not.toMatch(/auto-fit/);
    }
  });

  it("the Usage KPI row is a tile row", async () => {
    const { UsageKpiRow } = await import("@/screens/usage/UsageKpiRow");
    const { container } = render(
      <UsageKpiRow
        costUsd={693.75}
        currency="USD"
        eurRate={0.86}
        tokens={{ input: 1, output: 1, cacheCreation: 1, cacheRead: 1, total: 4 }}
        sessions={8}
        toolCalls={767}
        cacheHitRate={0.07}
        harnesses={[{ id: "claude", name: "Claude Code", tokens: { input: 1, output: 1, cacheCreation: 1, cacheRead: 1, total: 4 }, costUsd: 693.75, sessions: 8, toolCalls: 767, topModel: "claude-sonnet-5" }]}
      />,
    );
    expect(container.querySelector(".usage-kpis")?.classList.contains("tile-row")).toBe(true);
  });
});

describe("StatCard hint overlay", () => {
  const hint = { title: "Why a high cache hit rate is good", body: <p>because reasons</p> };

  it("renders the info mark, becomes focusable, and describes itself via a role=tooltip panel", () => {
    const { container } = render(<StatCard label="Cache hit rate" value="92%" hint={hint} />);
    const card = container.querySelector(".stat-card")!;
    expect(card.querySelector(".stat-hint-mark")).toBeInTheDocument();
    expect(card.getAttribute("tabindex")).toBe("0");
    const describedBy = card.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const tooltip = container.querySelector(`#${describedBy}`);
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip).toHaveTextContent("Why a high cache hit rate is good");
  });

  it("a tile without a hint renders none of the hint scaffolding — byte-identical to before", () => {
    const { container } = render(<StatCard label="Sessions" value="8" />);
    const card = container.querySelector(".stat-card")!;
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.hasAttribute("aria-describedby")).toBe(false);
    expect(card.querySelector(".stat-hint-mark")).toBeNull();
    expect(container.querySelector(".stat-hint")).toBeNull();
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("Escape marks the panel dismissed; leaving the tile clears it", () => {
    const { container } = render(<StatCard label="Cache hit rate" value="92%" hint={hint} />);
    const card = container.querySelector(".stat-card")!;
    expect(card.hasAttribute("data-hint-dismissed")).toBe(false);
    fireEvent.keyDown(card, { key: "Escape" });
    expect(card.getAttribute("data-hint-dismissed")).toBe("true");
    fireEvent.mouseLeave(card);
    expect(card.hasAttribute("data-hint-dismissed")).toBe(false);
  });

  it("moves the informative overlay with the pointer", () => {
    const { container } = render(<StatCard label="Cache hit rate" value="92%" hint={hint} />);
    const card = container.querySelector(".stat-card")!;
    const event = new Event("pointermove", { bubbles: true });
    Object.defineProperties(event, {
      clientX: { value: 900 },
      clientY: { value: 700 },
    });
    const tooltip = container.querySelector(".stat-hint") as HTMLElement;
    tooltip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 100, right: 260, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent(card, event);
    expect(tooltip).toHaveStyle({ left: "628px", top: "588px" });
    expect(tooltip).toHaveAttribute("data-side", "left");
    expect(tooltip).toHaveAttribute("data-vertical", "above");
  });
});
