import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";

import { Harnesses } from "@/screens/Harnesses";
import { useAppStore, type HarnessStatus } from "@/store";
import { renderWithProviders, primeRegistry } from "./helpers";

function setHarnesses(
  list: Array<Partial<HarnessStatus> & {
    id: string;
    label: string;
    installed: boolean;
    on_globally: boolean;
  }>,
) {
  useAppStore.setState({
    mutating: false,
    harnesses: list.map((h) => ({ used_by_projects: [], ...h })),
  });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

beforeEach(() => {
  useAppStore.setState({ mutating: false, harnesses: [] });
});

describe("Harnesses — no-active-harness banner (F7)", () => {
  it("shows the banner when a harness is enabled globally but none installed", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: false, on_globally: true },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.getByText(/No active harness/)).toBeInTheDocument();
    expect(
      screen.getByText(/synced skills won't reach any harness yet/),
    ).toBeInTheDocument();
  });

  it("hides the banner when an enabled harness is installed", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: true, on_globally: true },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.queryByText(/No active harness/)).not.toBeInTheDocument();
  });

  it("hides the banner when nothing is enabled globally", () => {
    setHarnesses([
      { id: "claude-code", label: "Claude Code", installed: false, on_globally: false },
      { id: "codex", label: "Codex", installed: true, on_globally: false },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.queryByText(/No active harness/)).not.toBeInTheDocument();
  });
});

describe("Harnesses — global instruction-doc affordance", () => {
  it("renders an Instructions affordance per harness with a global_doc", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { container, client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(
      screen.getByRole("button", { name: /Instructions/i }),
    ).toBeInTheDocument();
    // The doc filename renders in mono inside the instructions affordance.
    const affordance = container.querySelector(".harness-card-instructions");
    expect(affordance?.textContent).toContain("CLAUDE.md");
  });

  it("shows a 'not created' hint when the global doc is missing", () => {
    setHarnesses([
      {
        id: "codex",
        label: "Codex",
        installed: true,
        on_globally: false,
        global_doc: "/home/test/.codex/AGENTS.md",
        global_doc_exists: false,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(screen.getByText(/not created/i)).toBeInTheDocument();
  });

  it("navigates to /harness/:id/doc on click", () => {
    setHarnesses([
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        global_doc: "/home/test/.claude/CLAUDE.md",
        global_doc_exists: true,
      },
    ]);
    const { client } = renderWithProviders(
      <>
        <Harnesses />
        <LocationProbe />
      </>,
    );
    primeRegistry(client);
    fireEvent.click(screen.getByRole("button", { name: /Instructions/i }));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/harness/claude-code/doc",
    );
  });

  it("omits the affordance for a harness without a global_doc", () => {
    setHarnesses([
      {
        id: "mystery",
        label: "Mystery",
        installed: true,
        on_globally: false,
      },
    ]);
    const { client } = renderWithProviders(<Harnesses />);
    primeRegistry(client);
    expect(
      screen.queryByRole("button", { name: /Instructions/i }),
    ).not.toBeInTheDocument();
  });
});
