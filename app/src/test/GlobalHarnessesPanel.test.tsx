import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { GlobalHarnessesPanel } from "@/components/GlobalHarnessesPanel";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

function makeHarnesses() {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      installed: true,
      on_globally: true,
      used_by_projects: [],
    },
    {
      id: "codex",
      label: "Codex",
      installed: true,
      on_globally: false,
      used_by_projects: [],
    },
    {
      id: "pi",
      label: "Pi",
      installed: false,
      on_globally: false,
      used_by_projects: [],
    },
  ];
}

beforeEach(() => {
  useAppStore.setState({ mutating: false, harnesses: makeHarnesses() });
});

describe("GlobalHarnessesPanel", () => {
  it("renders one row per harness with installed/not-installed state", () => {
    renderWithProviders(<GlobalHarnessesPanel />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument();
    expect(screen.getByText("not installed")).toBeInTheDocument();
  });

  it("disables the not-installed row", () => {
    renderWithProviders(<GlobalHarnessesPanel />);
    const piCheckbox = screen.getByLabelText(/Enable Pi globally/i) as HTMLInputElement;
    expect(piCheckbox).toBeDisabled();
  });

  it("calls harness_set_global when toggled and re-rescans", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "harness_set_global") return undefined;
      if (cmd === "harness_list") return makeHarnesses();
      return undefined;
    });
    renderWithProviders(<GlobalHarnessesPanel />);
    await userEvent.click(screen.getByLabelText(/Enable Codex globally/i));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("harness_set_global", {
        id: "codex",
        enabled: true,
      });
    });
  });

  it("invokes rescan via the Rescan button", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "harness_list") return makeHarnesses();
      return undefined;
    });
    renderWithProviders(<GlobalHarnessesPanel />);
    await userEvent.click(screen.getByText("Rescan"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("harness_list");
    });
  });
});
