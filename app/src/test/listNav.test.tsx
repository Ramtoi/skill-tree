import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useListNav } from "@/hooks/useListNav";
import { ResourceRow } from "@/components/ResourceRow";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { readAppCss } from "./readAppCss";

function activeIndexOf(container: HTMLElement): number {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-listnav-active]"),
  );
  return rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
}

function Harness({
  onOpen,
  onSecondary,
  count = 3,
}: {
  onOpen: (i: number) => void;
  onSecondary: (i: number) => void;
  count?: number;
}) {
  const nav = useListNav({ count, onOpen, onSecondary });
  return (
    <div data-testid="list" {...nav.containerProps}>
      {Array.from({ length: count }, (_, i) => {
        const { ref, ...rest } = nav.itemProps(i);
        return (
          <div key={i} data-testid={`row-${i}`} ref={ref} {...rest}>
            row {i}
          </div>
        );
      })}
      <input data-testid="filter" />
    </div>
  );
}

describe("useListNav — roving focus", () => {
  it("j/k and arrows move the active row; Home/End jump", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    expect(activeIndexOf(list)).toBe(0);

    fireEvent.keyDown(list, { key: "j" });
    expect(activeIndexOf(list)).toBe(1);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(activeIndexOf(list)).toBe(2);
    fireEvent.keyDown(list, { key: "k" });
    expect(activeIndexOf(list)).toBe(1);
    fireEvent.keyDown(list, { key: "Home" });
    expect(activeIndexOf(list)).toBe(0);
    fireEvent.keyDown(list, { key: "End" });
    expect(activeIndexOf(list)).toBe(2);
  });

  it("Enter opens and e runs the secondary action on the active row", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(1);
    fireEvent.keyDown(list, { key: "e" });
    expect(onSecondary).toHaveBeenCalledWith(1);
  });

  it("clamps the active row when the list shrinks under it", () => {
    // A filter can drop the list below the active index. Left unclamped the
    // index strands past the end: no row carries the roving tabindex, nothing
    // is marked active, and the listbox is dead until the filter is cleared.
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId, rerender } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} count={3} />,
    );
    const list = getByTestId("list");
    fireEvent.keyDown(list, { key: "End" });
    expect(activeIndexOf(list)).toBe(2);

    rerender(<Harness onOpen={onOpen} onSecondary={onSecondary} count={1} />);
    expect(activeIndexOf(list)).toBe(0);
    expect(getByTestId("row-0").getAttribute("tabindex")).toBe("0");

    // …and the surviving row still opens.
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it("does not move the active row when typing in a field inside the list", () => {
    const onOpen = vi.fn();
    const onSecondary = vi.fn();
    const { getByTestId } = render(
      <Harness onOpen={onOpen} onSecondary={onSecondary} />,
    );
    const list = getByTestId("list");
    fireEvent.keyDown(getByTestId("filter"), { key: "j" });
    expect(activeIndexOf(list)).toBe(0);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// A roving-list wrapper mirroring SkillLibrary's `.lib-nav-row` pattern
// (itemProps on the WRAPPER, not on ResourceRow's own root), so a real
// `<ResourceRow detail>` chevron sits inside a real `useListNav` container —
// the exact shape REVIEW-A #1 says the standalone `ResourceRowDetail.test.tsx`
// cannot see.
function DetailHarness({
  onOpen,
  onToggleDetail,
  count = 3,
}: {
  onOpen: (i: number) => void;
  onToggleDetail?: (i: number) => void;
  count?: number;
}) {
  const nav = useListNav({ count, onOpen, onToggleDetail });
  return (
    <div data-testid="list" {...nav.containerProps}>
      {Array.from({ length: count }, (_, i) => {
        const { ref, ...rest } = nav.itemProps(i);
        return (
          <div key={i} ref={ref} {...rest}>
            <ResourceRow
              name={`row ${i}`}
              ariaLabel={`row ${i}`}
              tabIndex={-1}
              onClick={() => onOpen(i)}
              detail={<span>Body {i}</span>}
              detailLabel={`row ${i} details`}
            />
          </div>
        );
      })}
    </div>
  );
}

describe("ResourceRow chevron inside a roving list (REVIEW-A #1 — blocker)", () => {
  it("Enter on the chevron toggles aria-expanded and never reaches the container's onOpen", async () => {
    const onOpen = vi.fn();
    render(<DetailHarness onOpen={onOpen} />);

    const chevron = screen.getByRole("button", { name: "Show row 1 details" });
    chevron.focus();
    await userEvent.keyboard("{Enter}");

    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Space on the chevron toggles aria-expanded and never reaches the container's onOpen", async () => {
    const onOpen = vi.fn();
    render(<DetailHarness onOpen={onOpen} />);

    const chevron = screen.getByRole("button", { name: "Show row 1 details" });
    chevron.focus();
    await userEvent.keyboard(" ");

    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ArrowRight/ArrowLeft on the active row calls onToggleDetail (REVIEW-A #2 keyboard path)", () => {
    const onOpen = vi.fn();
    const onToggleDetail = vi.fn();
    const { getByTestId } = render(
      <DetailHarness onOpen={onOpen} onToggleDetail={onToggleDetail} />,
    );
    const list = getByTestId("list");

    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onToggleDetail).toHaveBeenCalledWith(1);

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onToggleDetail).toHaveBeenCalledWith(1);
    expect(onToggleDetail).toHaveBeenCalledTimes(2);
  });
});

describe("SkillLibrary — roving nav wiring", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "read_registry") return sampleRegistry;
      if (cmd === "local_skill_candidates") return [];
      if (cmd === "harness_list") return [];
      if (cmd === "hub_cmd")
        return { success: true, output: '{"sources":[],"errors":[]}' };
      // Finding 2: unmocked below (falling through to `undefined`) let
      // react-query's background refetch (`staleTime: 0`) settle a
      // `FloatingSearch` prop update (kinds counts) OUTSIDE any act() scope,
      // well after this test's own interactions — a late act warning
      // unrelated to anything this test exercises. Mocked to a real,
      // resolved shape so both queries settle deterministically instead.
      if (cmd === "snippets_list") return [];
      if (cmd === "read_search_corpus") return { skills: {}, snippets: {} };
      return undefined;
    }) as never);
  });

  it("`e` on the focused row opens the equip picker; typing the filter does not move focus", async () => {
    const client = makeQueryClient();
    renderWithProviders(<SkillLibrary />, { client });

    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".lib-list");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(activeIndexOf(list)).toBe(0);

    // Typing in the search filter resets the cursor to row 0 (G9) — use "b"
    // (matches only the "brainstorm" skill, not the "android" bundle's own
    // name/description) so row 0 stays a SKILL row, same as this test always
    // asserted; a query that also matched the "android" bundle would legally
    // land the G1-unified cursor on that cross-entity row instead (`e` is a
    // no-op there — see FloatingSearch/SkillLibrarySearch tests for that).
    const search = document.querySelector<HTMLInputElement>(
      ".main-header input, .subheader input, input",
    );
    if (search) {
      await userEvent.type(search, "b");
    }

    // `e` on the list opens the skill→projects equip picker.
    fireEvent.keyDown(list, { key: "e" });
    await waitFor(() =>
      expect(document.querySelector(".equip-picker")).not.toBeNull(),
    );
  });

  it("Tab from the search field lands on exactly one row; ArrowRight opens the focused row's detail (REVIEW-A #2)", async () => {
    const client = makeQueryClient();
    renderWithProviders(<SkillLibrary />, { client });

    const list = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".lib-list");
      expect(el).not.toBeNull();
      return el!;
    });

    // Tab all the way from the search field to the list: exactly ONE
    // element inside it is a tab stop — the roving `.lib-nav-row` wrapper —
    // never the ResourceRow root beneath it or its disclosure chevron.
    const search = screen.getByTestId("floating-search-input");
    fireEvent.focus(search);
    fireEvent.keyDown(search, { key: "Tab" });
    expect(list.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveClass("lib-nav-row");
    expect(list.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    // rt-android-expert (flat index 2: brainstorm, fs-mcp, rt-android-expert,
    // android-compose-ui) is in the "android" bundle, so it renders a
    // disclosure chevron — ArrowRight on it opens that row's detail.
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "j" });
    expect(activeIndexOf(list)).toBe(2);

    fireEvent.keyDown(list, { key: "ArrowRight" });
    // The label flips Show→Hide the same tick aria-expanded flips true.
    const chevron = screen.getByRole("button", {
      name: "Hide rt-android-expert details",
    });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });
});

// CSS-contract tests for PLAN §A6/§A6-a: the dead `.skill-row` roving-focus
// stripe (which never painted — the attribute lands on the `.lib-nav-row`
// WRAPPER, not `.skill-row`) is replaced by the shared lit-slot ring, and the
// unscoped `outline: none` it shipped with is replaced by a keep SCOPED to
// the two other lists (`.hook-row`, `.sf-file`) that relied on it.
describe("List-nav roving focus — lit slot, not a stripe (PLAN §A6/§A6-a)", () => {
  // command-layer.css is deliberately excluded from readAppCss() (it was never
  // inlined into the old App.css) — read it directly so the "no unscoped
  // outline: none" assertion actually covers the file the rule used to live in.
  const commandLayerCss = readFileSync(
    resolve(process.cwd(), "src/styles/command-layer.css"),
    "utf8",
  );
  const appCss = readAppCss();

  it('has no unscoped [data-listnav-active="true"] { outline: none }', () => {
    // REVIEW-A #11: the old assertion only checked commandLayerCss, only at
    // line start — a re-add anywhere in appCss (e.g. rows-cards.css /
    // unit-rows.css), or one merely indented, would pass. Match the actual
    // RULE (a selector boundary before it, a same-declaration outline:none
    // inside its braces) across BOTH stylesheets instead.
    const unscopedRe =
      /(^|[\s},])\[data-listnav-active="true"\]\s*\{[^}]*outline:\s*none/m;
    expect(commandLayerCss).not.toMatch(unscopedRe);
    expect(appCss).not.toMatch(unscopedRe);
  });

  it("has no .skill-row[data-listnav-active] stripe rule anywhere in the app CSS", () => {
    // Matches an actual RULE (selector immediately followed by `{` on the
    // SAME line), not a documentation comment naming the retired selector.
    const ruleRe = /\.skill-row\[data-listnav-active[^{\n]*\{/;
    expect(appCss).not.toMatch(ruleRe);
    expect(commandLayerCss).not.toMatch(ruleRe);
  });

  it("keeps a scoped outline: none for .hook-row and .sf-file", () => {
    expect(appCss).toMatch(
      /\.hook-row\[data-listnav-active="true"\][\s\S]{0,80}outline:\s*none/,
    );
    expect(appCss).toMatch(
      /\.sf-file\[data-listnav-active="true"\][\s\S]{0,80}outline:\s*none/,
    );
  });

  it("paints the roving-focus lit slot with the shared --slot-* quartet", () => {
    expect(appCss).toMatch(
      /\.lib-nav-row\[data-listnav-active="true"\]\s*>\s*\.resource-row[\s\S]*?--slot-ring/,
    );
  });
});
