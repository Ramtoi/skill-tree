import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { NavPanel, computeSourceSummary } from "@/components/NavPanel";
import { renderWithProviders, makeQueryClient, primeRegistry, sampleRegistry } from "./helpers";
import { useAppStore } from "@/store";
import type { Registry, Project, Bundle } from "@/types";

function clearNavStorage() {
  window.localStorage.removeItem("st:sb:pinned");
  window.localStorage.removeItem("st:sb:collapsed");
}

function registryWithProjects(n: number): Registry {
  const projects: Record<string, Project> = {};
  for (let i = 0; i < n; i++) {
    const name = String.fromCharCode(97 + i).repeat(3) + `-proj-${i}`;
    projects[name] = { path: `/x/${name}`, bundles: [], enabled: [] };
  }
  return { ...sampleRegistry, projects };
}

function registryWithBundles(names: string[]): Registry {
  const bundles: Record<string, Bundle> = {};
  for (const name of names) {
    bundles[name] = { description: name, icon: "📦", scope: "global", skills: [] };
  }
  return { ...sampleRegistry, bundles };
}

describe("NavPanel — Pinned section", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("clicking the pin button on a project row updates localStorage and renders Pinned", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    // No Pinned group at first
    expect(container.querySelector(".side-group.is-featured")).toBeNull();
    // Find the project row's pin button
    const projectRow = screen.getByRole("button", { name: /example-app/i });
    const pinBtn = within(projectRow.parentElement as HTMLElement)
      .getAllByLabelText("Pin to top")
      .find((el) => projectRow.contains(el) || el.closest(".side-item") === projectRow);
    // Fallback: query inside the row itself
    const inRow = projectRow.querySelector('[aria-label="Pin to top"]');
    await userEvent.click(inRow ?? pinBtn!);
    expect(window.localStorage.getItem("st:sb:pinned")).toContain("project:example-app");
    expect(container.querySelector(".side-group.is-featured")).not.toBeNull();
    expect(within(container.querySelector(".side-group.is-featured")!).getByText(/project/i)).toBeInTheDocument();
  });
});

describe("NavPanel — Collapsible groups", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("respects pre-set collapsed state and toggles via chevron", async () => {
    window.localStorage.setItem("st:sb:collapsed", JSON.stringify(["projects"]));
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    const projectsGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.includes("Projects"),
    ) as HTMLElement;
    expect(projectsGroup.getAttribute("data-collapsed")).toBe("true");
    expect(projectsGroup.querySelector(".side-group-items")).toBeNull();
    // Click chevron
    const chev = projectsGroup.querySelector(".chev-btn") as HTMLElement;
    await userEvent.click(chev);
    expect(projectsGroup.getAttribute("data-collapsed")).toBeNull();
    expect(projectsGroup.querySelector(".side-group-items")).not.toBeNull();
    const stored = JSON.parse(window.localStorage.getItem("st:sb:collapsed") || "[]");
    expect(stored).not.toContain("projects");
  });

  it("collapses Sources by default for first-time users", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    const sourcesGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.toLowerCase().includes("sources"),
    ) as HTMLElement;
    expect(sourcesGroup.getAttribute("data-collapsed")).toBe("true");
  });
});

describe("NavPanel — Truncation", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("renders 6 of 10 projects with a Show 4 more button", async () => {
    const client = makeQueryClient();
    primeRegistry(client, registryWithProjects(10));
    const { container } = renderWithProviders(<NavPanel />, { client });
    const projectsGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.includes("Projects"),
    ) as HTMLElement;
    const rows = projectsGroup.querySelectorAll(".side-group-items .side-item");
    expect(rows.length).toBe(6);
    const showMore = projectsGroup.querySelector(".side-show-more") as HTMLElement;
    expect(showMore).not.toBeNull();
    expect(showMore.textContent).toContain("Show 4 more");
    await userEvent.click(showMore);
    expect(projectsGroup.querySelectorAll(".side-group-items .side-item").length).toBe(10);
    expect(projectsGroup.querySelector(".side-show-more")?.textContent).toContain("Show less");
  });

  it("forces the active project into the truncated slice", () => {
    const reg = registryWithProjects(10);
    // Pick the 9th project name; navigate to its route.
    const names = Object.keys(reg.projects);
    const lateName = names[8];
    const client = makeQueryClient();
    primeRegistry(client, reg);
    const { container } = renderWithProviders(<NavPanel />, {
      client,
      initialRoute: `/project/${encodeURIComponent(lateName)}`,
    });
    const projectsGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.includes("Projects"),
    ) as HTMLElement;
    const rows = projectsGroup.querySelectorAll(".side-group-items .side-item");
    expect(rows.length).toBe(6);
    const visibleNames = [...rows].map((r) => r.querySelector(".name")?.textContent);
    expect(visibleNames).toContain(lateName);
    // And the active one carries aria-current.
    const activeRow = projectsGroup.querySelector(
      '.side-group-items .side-item[aria-current="true"]',
    );
    expect(activeRow?.querySelector(".name")?.textContent).toBe(lateName);
  });
});

describe("NavPanel — Inline filter", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("narrows bundles by substring, shows No matches on empty result", async () => {
    const reg = registryWithBundles(["android", "openspec", "android-ui", "tooling", "docs", "research", "extra"]);
    const client = makeQueryClient();
    primeRegistry(client, reg);
    const { container } = renderWithProviders(<NavPanel />, { client });
    const bundlesGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.toLowerCase().startsWith("bundles") ||
      g.querySelector(".t-name")?.textContent === "Bundles",
    ) as HTMLElement;
    // Open filter
    const filterBtn = bundlesGroup.querySelector('button[title="Filter"]') as HTMLElement;
    expect(filterBtn).not.toBeNull();
    await userEvent.click(filterBtn);
    const input = bundlesGroup.querySelector(".side-filter input") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "and" } });
    let names = [...bundlesGroup.querySelectorAll(".side-group-items .side-item .name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(expect.arrayContaining(["android", "android-ui"]));
    expect(names).not.toContain("openspec");
    fireEvent.change(input, { target: { value: "zzzzz" } });
    expect(bundlesGroup.querySelector(".side-empty")?.textContent).toBe("No matches.");
  });
});

describe("NavPanel — Bundles add affordance", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="loc">{loc.pathname + loc.search}</div>;
  }

  it("renders a New bundle + button that navigates to /?addBundle=1", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(
      <>
        <NavPanel />
        <LocationProbe />
      </>,
      { client },
    );
    const bundlesGroup = [...container.querySelectorAll(".side-group")].find(
      (g) => g.querySelector(".t-name")?.textContent === "Bundles",
    ) as HTMLElement;
    const addBtn = bundlesGroup.querySelector(
      'button[title="New bundle"]',
    ) as HTMLElement;
    expect(addBtn).not.toBeNull();
    await userEvent.click(addBtn);
    expect(screen.getByTestId("loc").textContent).toBe("/?addBundle=1");
  });
});

describe("NavPanel — Recent strip & Quick-jump footer", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("renders empty placeholder when no recent items", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    expect(container.querySelector(".side-recent-empty")?.textContent).toBe("— nothing yet —");
  });

  it("marks the active recent chip with aria-current", () => {
    useAppStore.setState({
      recentlyVisited: [{ type: "project", name: "example-app" }],
    });
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, {
      client,
      initialRoute: "/project/example-app",
    });
    const chip = container.querySelector(".side-recent-chip");
    expect(chip?.getAttribute("aria-current")).toBe("true");
  });

  it("clicking Quick-jump invokes openPalette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    expect(useAppStore.getState().paletteOpen).toBe(false);
    const foot = container.querySelector(".side-foot-btn") as HTMLElement;
    await userEvent.click(foot);
    expect(useAppStore.getState().paletteOpen).toBe(true);
  });
});

describe("NavPanel — Sources wiring (C4)", () => {
  beforeEach(() => {
    clearNavStorage();
    useAppStore.setState({ recentlyVisited: [], paletteOpen: false });
  });

  it("derives real source rows (built-ins + registered git source) instead of an empty group", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<NavPanel />, { client });
    const sourcesGroup = [...container.querySelectorAll(".side-group")].find((g) =>
      g.textContent?.toLowerCase().includes("sources"),
    ) as HTMLElement;

    // Count badge is no longer hardwired to 0 — sampleRegistry has 3 sources
    // (built-in Local, built-in Starter Pack, registered git "org-skills").
    expect(sourcesGroup.querySelector(".t-count")?.textContent).toBe("3");

    // Defaults collapsed (unchanged); expand to see the derived rows.
    const chev = sourcesGroup.querySelector(".chev-btn") as HTMLElement;
    await userEvent.click(chev);

    const names = [
      ...sourcesGroup.querySelectorAll(".side-group-items .side-item .name"),
    ].map((n) => n.textContent);
    expect(names).toEqual(
      expect.arrayContaining(["Local", "Starter Pack", "Org Skills"]),
    );
  });
});

describe("computeSourceSummary precedence", () => {
  it("returns N error tone=error when any source is in error", () => {
    expect(
      computeSourceSummary([
        { status: "error" },
        { status: "error" },
        { status: "update-available" },
      ]),
    ).toEqual({ tone: "error", label: "2 error" });
  });
  it("returns N update tone=warn when only updates pending", () => {
    expect(
      computeSourceSummary([
        { status: "update-available" },
        { status: "update-available" },
        { status: "update-available" },
        { status: "up-to-date" },
      ]),
    ).toEqual({ tone: "warn", label: "3 update" });
  });
  it("returns all ok tone=ok when healthy or empty", () => {
    expect(computeSourceSummary([])).toEqual({ tone: "ok", label: "all ok" });
    expect(computeSourceSummary([{ status: "up-to-date" }])).toEqual({
      tone: "ok",
      label: "all ok",
    });
  });
});
