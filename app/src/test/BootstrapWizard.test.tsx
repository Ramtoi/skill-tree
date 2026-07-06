import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import {
  BootstrapWizard,
  type BootstrapState,
} from "@/screens/BootstrapWizard";
import { renderWithProviders } from "./helpers";

function makeState(overrides: Partial<BootstrapState> = {}): BootstrapState {
  return {
    needs_bootstrap: true,
    completed_at: null,
    version: 1,
    legacy_detected: [],
    data_home: "/home/u/.skill-hub",
    code_home: "/home/u/code/skill-hub",
    candidates: [],
    conflicts: [],
    blocked: [],
    already_managed: [],
    silent_skip: [],
    ...overrides,
  };
}

describe("BootstrapWizard", () => {
  it("renders fresh-install heading when registry is empty", async () => {
    renderWithProviders(<BootstrapWizard state={makeState()} />);
    expect(await screen.findByText("Set up Skill Tree")).toBeInTheDocument();
    expect(screen.getByText(/First-time setup/)).toBeInTheDocument();
  });

  it("renders upgrade heading when existing skills are present", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_registry") {
        return {
          skills: { brainstorm: { version: "1.0.0" } },
        };
      }
      return undefined;
    });
    renderWithProviders(<BootstrapWizard state={makeState()} />);
    expect(await screen.findByText("Finish upgrading Skill Tree")).toBeInTheDocument();
  });

  it("surfaces blocked candidates in a dedicated section", () => {
    const state = makeState({
      blocked: [
        {
          origin: "claude",
          path: "/home/u/.claude/skills/BadName",
          name: "BadName",
          category: "INVALID_NAME",
          reason: "must match ^[a-z0-9-]+$",
        },
      ],
    });
    renderWithProviders(<BootstrapWizard state={state} />);
    expect(screen.getByText(/Cannot import/)).toBeInTheDocument();
    expect(screen.getByText(/must match \^\[a-z0-9-\]\+\$/)).toBeInTheDocument();
  });

  it("renders importable candidates with category badges", () => {
    const state = makeState({
      candidates: [
        {
          origin: "claude",
          path: "/home/u/.claude/skills/freshie",
          name: "freshie",
          category: "NEW",
        },
      ],
      conflicts: [
        {
          origin: "codex",
          path: "/home/u/.codex/skills/brainstorm",
          name: "brainstorm",
          category: "CONFLICT",
          candidate_sha: "abcdef",
          existing_sha: "012345",
          existing_source: "/home/u/.skill-hub/skills/brainstorm",
        },
      ],
    });
    renderWithProviders(<BootstrapWizard state={state} />);
    expect(screen.getByText("freshie")).toBeInTheDocument();
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
    expect(screen.getByText("NEW")).toBeInTheDocument();
    // CONFLICT badge — at least one rendering present (heading copy uses it too).
    expect(screen.getAllByText("CONFLICT").length).toBeGreaterThanOrEqual(1);
  });

  it("shows legacy migration banner when legacy_detected is non-empty", () => {
    const state = makeState({
      legacy_detected: ["/home/u/Dev/.skill-hub"],
    });
    renderWithProviders(<BootstrapWizard state={state} />);
    expect(screen.getByText(/Legacy hub detected/)).toBeInTheDocument();
  });

  it("calls bootstrap_run when apply button is clicked", async () => {
    const state = makeState({
      candidates: [
        {
          origin: "claude",
          path: "/home/u/.claude/skills/freshie",
          name: "freshie",
          category: "NEW",
        },
      ],
    });
    renderWithProviders(<BootstrapWizard state={state} />);
    const button = await screen.findByText(/Initialize Skill Hub/);
    await userEvent.click(button);
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "bootstrap_run",
        expect.objectContaining({ selections: expect.any(Object) }),
      );
    });
  });
});
