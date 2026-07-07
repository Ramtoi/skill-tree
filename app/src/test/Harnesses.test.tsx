import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { Harnesses } from "@/screens/Harnesses";
import { useAppStore } from "@/store";
import { renderWithProviders, primeRegistry } from "./helpers";

function setHarnesses(
  list: Array<{
    id: string;
    label: string;
    installed: boolean;
    on_globally: boolean;
  }>,
) {
  useAppStore.setState({
    mutating: false,
    harnesses: list.map((h) => ({ ...h, used_by_projects: [] })),
  });
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
      screen.getByText(/synced skills won't reach any agent yet/),
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
