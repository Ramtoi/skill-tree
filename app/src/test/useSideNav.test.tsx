import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { NavPanel } from "@/components/NavPanel";
import { useSideNav } from "@/hooks/useSideNav";
import { useChords } from "@/hooks/useChords";
import { KEYMAP, type KeymapCtx } from "@/lib/keymap";
import { useAppStore } from "@/store";
import {
  renderWithProviders,
  makeQueryClient,
  primeRegistry,
  sampleRegistry,
} from "./helpers";
import type { Project, Registry } from "@/types";

// The roving-tabindex + keyboard contract (spec §3.1/§8.3): rendered through
// the real NavPanel (the hook has no meaning outside a `.side-scroll` host).

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

/** Mirrors App.tsx's own `<main className="app-main" tabIndex={-1}>` — the
 *  Escape target — so the docked-Escape assertion has something real to find. */
function Harness() {
  return (
    <>
      <NavPanel />
      <main className="app-main" tabIndex={-1} />
      <LocationProbe />
    </>
  );
}

/** M-2: `useChords` is a WINDOW listener — mounted next to the real panel,
 *  the way `App.tsx` actually wires the two together, so a `g`-chord's
 *  second key reaches BOTH `useSideNav.onKeyDown` (bound on `.side-scroll`)
 *  and the chord handler for the same native event. */
function HarnessWithChords({ lastProjectRoute }: { lastProjectRoute: string }) {
  const navigate = useNavigate();
  const ctx: KeymapCtx = {
    navigate,
    openPalette: () => {},
    lastProjectRoute: () => lastProjectRoute,
    firstBundleRoute: () => "/bundle/android",
    focusNavigator: () => {},
  };
  useChords(KEYMAP, ctx);
  return (
    <>
      <NavPanel />
      <main className="app-main" tabIndex={-1} />
      <LocationProbe />
    </>
  );
}

function manyProjects(n: number): Record<string, Project> {
  const projects: Record<string, Project> = {};
  for (let i = 0; i < n; i++) {
    const name = `proj-${String(i).padStart(2, "0")}`;
    projects[name] = { path: `/x/${name}`, bundles: [], enabled: [] };
  }
  return projects;
}

function renderPanel(route: string, registry: Registry = sampleRegistry) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return renderWithProviders(<Harness />, {
    client,
    initialRoute: route,
  });
}

function renderPanelWithChords(
  route: string,
  registry: Registry,
  lastProjectRoute: string,
) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return renderWithProviders(
    <HarnessWithChords lastProjectRoute={lastProjectRoute} />,
    { client, initialRoute: route },
  );
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-side-row]")];
}

describe("useSideNav — roving tabindex", () => {
  it("exactly one row is tabbable, and it is the aria-current row", () => {
    const reg = { ...sampleRegistry, projects: manyProjects(5) };
    const { container } = renderPanel("/project/proj-02", reg);
    const tabbable = rows(container).filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-current")).toBe("true");
    expect(tabbable[0].textContent).toContain("proj-02");
  });

  it("falls back to the first row when nothing is active", () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/__none__", reg);
    const tabbable = rows(container).filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rows(container)[0]);
  });

  it("pins are never in the ring (tabindex -1, always)", () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    const pins = [...container.querySelectorAll<HTMLElement>(".side-item-pin")];
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin.tabIndex).toBe(-1);
  });

  it("a collapsed group holding the active row starts the ring at the first mounted row", async () => {
    window.localStorage.setItem("st:sb:collapsed", JSON.stringify(["guardrails.hooks"]));
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "hook_list") {
        return {
          hooks: [
            {
              name: "lsp-report",
              provenance: "builtin",
              event: "PostToolUse",
              command: "",
              description: "",
              tools: [],
              matcher: "",
              timeout: null,
              harnesses: null,
              settings: {},
              attached_global: true,
              attached_projects: [],
            },
          ],
          reach: {},
        };
      }
      if (cmd === "read_registry") return sampleRegistry;
      return undefined;
    }) as never);
    const { container } = renderPanel("/hook/lsp-report");
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
    // The hook row is unmounted (its group is collapsed) — no aria-current row
    // exists in the DOM at all, so the ring starts at the first mounted row.
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    const tabbable = rows(container).filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rows(container)[0]);
    window.localStorage.clear();
  });
});

describe("useSideNav — keys", () => {
  // `userEvent.keyboard(...)` (no target) dispatches on `document.activeElement`
  // WITHOUT stealing focus first — `userEvent.type(el, ...)` would (it treats
  // `el` as a text field and clicks/focuses it, which is exactly wrong for a
  // plain `<div>` scroll container).
  it("ArrowDown/j moves to the next row, ArrowUp/k to the previous", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(5) };
    const { container } = renderPanel("/project/proj-00", reg);
    const list = rows(container);
    list[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(list[1]);
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(list[2]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(list[1]);
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(list[0]);
  });

  it("Home/End jump to the first/last row", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(5) };
    const { container } = renderPanel("/project/proj-00", reg);
    const list = rows(container);
    list[2].focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(list[list.length - 1]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(list[0]);
  });

  it("Enter activates the focused row via native button semantics", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    const list = rows(container);
    list[1].focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("loc").textContent).toBe("/project/proj-01");
  });

  it("p toggles the focused row's sibling pin without navigating", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    const list = rows(container);
    list[0].focus();
    const pin = list[0].parentElement?.querySelector(".side-item-pin") as HTMLElement;
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await userEvent.keyboard("p");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("loc").textContent).toBe("/project/proj-00");
  });

  it("M-2: g p from a focused row runs the chord and does NOT also pin the row", async () => {
    window.localStorage.clear();
    useAppStore.getState().setChordPending(null);
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanelWithChords(
      "/project/proj-00",
      reg,
      "/project/proj-02",
    );
    const list = rows(container);
    list[0].focus();
    const pin = list[0].parentElement?.querySelector(".side-item-pin") as HTMLElement;
    expect(pin.getAttribute("aria-pressed")).toBe("false");

    await userEvent.keyboard("gp");

    // The chord ran…
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/project/proj-02"),
    );
    expect(useAppStore.getState().chordPending).toBeNull();
    // …but the row's own `p` binding (pin toggle) must NOT have also fired.
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("st:sb:pinned")).not.toContain(
      "project:proj-00",
    );
    window.localStorage.clear();
  });

  it("/ focuses the panel filter when one is present", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(9) };
    const { container } = renderPanel("/project/proj-00", reg);
    await userEvent.click(screen.getByRole("button", { name: "Search projects" }));
    rows(container)[0].focus();
    await userEvent.keyboard("/");
    const input = container.querySelector(".side-filter input");
    expect(document.activeElement).toBe(input);
  });

  it("/ bubbles to the global handler when no filter is present", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    rows(container)[0].focus();
    await userEvent.keyboard("/");
    // No filter to steal focus — the row keeps it (nothing in-panel handled it).
    expect(document.activeElement).toBe(rows(container)[0]);
  });

  it("Escape (docked) focuses .app-main without stopping propagation", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    rows(container)[0].focus();
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(container.querySelector(".app-main"));
  });

  it("keys are ignored while the filter input is focused", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(9) };
    const { container } = renderPanel("/project/proj-00", reg);
    await userEvent.click(screen.getByRole("button", { name: "Search projects" }));
    const input = container.querySelector(".side-filter input") as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("j");
  });

  it("a modifier chord (metaKey) does nothing", async () => {
    const reg = { ...sampleRegistry, projects: manyProjects(3) };
    const { container } = renderPanel("/project/proj-00", reg);
    const list = rows(container);
    list[0].focus();
    await userEvent.keyboard("{Meta>}{ArrowDown}{/Meta}");
    expect(document.activeElement).toBe(list[0]);
  });

  it("nested detail rows are part of the ring", async () => {
    const { container } = renderPanel("/project/example-app");
    const list = rows(container);
    const activeIdx = list.findIndex((r) => r.getAttribute("aria-current") === "true");
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    list[activeIdx].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("android");
    expect((document.activeElement as HTMLElement).hasAttribute("data-side-row")).toBe(true);
  });
});

// A focused unit harness for the hook's M5 mechanism in isolation: NavPanel's
// own rows always carry `fromNav` on a cross-group destination precisely so
// they never hit this path in practice — the safety net exists for the row
// that forgets to. `locationKey` swaps like it would inside the real panel
// when `location.pathname` changes; the swapped-in route's row is a
// DIFFERENT `[data-side-row]` element, so the old one is genuinely unmounted
// (no React reconciliation preserving it under a stable key, unlike the
// nested-detail case NavPanel.test.tsx pins).
function FocusReturnHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const { scrollRef, onKeyDown } = useSideNav({
    narrow: false,
    locationKey: location.pathname,
  });
  return (
    <div className="side-scroll" role="listbox" tabIndex={-1} ref={scrollRef} onKeyDown={onKeyDown}>
      <Routes>
        <Route
          path="/a"
          element={
            <button type="button" data-side-row aria-current="true" onClick={() => navigate("/b")}>
              A
            </button>
          }
        />
        <Route path="/b" element={<button type="button" data-side-row>B</button>} />
      </Routes>
    </div>
  );
}

describe("useSideNav — focus return after activation (M5)", () => {
  it("returns focus to the new tabindex-0 row when the active row's own click swaps it out from under it", async () => {
    renderWithProviders(<FocusReturnHarness />, { initialRoute: "/a" });
    const rowA = screen.getByRole("button", { name: "A" });
    rowA.focus();
    expect(document.activeElement).toBe(rowA);

    await userEvent.click(rowA);
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();

    // Without the return effect, focus would be stranded on <body> here.
    await waitFor(() => {
      const activeElement = document.activeElement;
      expect(activeElement).not.toBe(document.body);
      expect(activeElement?.hasAttribute("data-side-row")).toBe(true);
      expect(activeElement?.getAttribute("tabindex")).toBe("0");
      expect(activeElement?.textContent).toBe("B");
    });
  });

  it("does nothing when focus was never inside the panel", async () => {
    renderWithProviders(
      <>
        <button type="button">outside</button>
        <FocusReturnHarness />
      </>,
      { initialRoute: "/a" },
    );
    (screen.getByRole("button", { name: "outside" }) as HTMLElement).focus();
    // Simulate the same route swap without ever focusing inside `.side-scroll`.
    screen.getByRole("button", { name: "A" }).click();
    await waitFor(() => expect(screen.queryByRole("button", { name: "A" })).toBeNull());
    // The effect must not have moved focus onto row B.
    expect(document.activeElement?.textContent).not.toBe("B");
  });
});
