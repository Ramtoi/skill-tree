import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import {
  BootstrapWizard,
  type BootstrapState,
} from "@/screens/BootstrapWizard";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

beforeEach(() => {
  // Default: at least one harness installed → no "no harness" nudge unless a
  // test opts into the all-missing state.
  useAppStore.setState({
    degradedMode: false,
    harnesses: [
      { id: "claude-code", label: "Claude Code", installed: true, on_globally: true, used_by_projects: [] },
    ],
  });
});

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

  it("passes the ticked selection paths through to bootstrap_run", async () => {
    const state = makeState({
      candidates: [
        {
          origin: "claude",
          path: "/home/u/.claude/skills/freshie",
          name: "freshie",
          category: "NEW",
        },
        {
          origin: "claude",
          path: "/home/u/.claude/skills/second",
          name: "second",
          category: "NEW",
        },
      ],
    });
    renderWithProviders(<BootstrapWizard state={state} />);
    // Untick "second" so only "freshie" is registered.
    const secondRow = screen.getByText("second").closest("label")!;
    const secondBox = secondRow.querySelector("input[type=checkbox]")!;
    await userEvent.click(secondBox);

    await userEvent.click(await screen.findByText(/Initialize Skill Hub/));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "bootstrap_run",
        expect.objectContaining({
          selections: expect.objectContaining({
            register: ["/home/u/.claude/skills/freshie"],
            conflict_actions: {},
            adopt: [],
          }),
        }),
      );
    });
  });

  it("sends conflict_actions=replace for a ticked CONFLICT row", async () => {
    const state = makeState({
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
    // Conflicts start unticked — tick it to opt into replacing.
    const row = screen.getByText("brainstorm").closest("label")!;
    const box = row.querySelector("input[type=checkbox]")!;
    await userEvent.click(box);

    await userEvent.click(await screen.findByText(/Initialize Skill Hub/));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "bootstrap_run",
        expect.objectContaining({
          selections: expect.objectContaining({
            register: ["/home/u/.codex/skills/brainstorm"],
            conflict_actions: { "/home/u/.codex/skills/brainstorm": "replace" },
          }),
        }),
      );
    });
  });

  it("shows a 'Set up later' escape only after an Initialize failure", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "bootstrap_run") throw new Error("boom");
      if (cmd === "read_registry") return { skills: {} };
      return undefined;
    });
    renderWithProviders(<BootstrapWizard state={makeState()} />);

    // No escape before any attempt.
    expect(screen.queryByText("Set up later")).not.toBeInTheDocument();

    await userEvent.click(await screen.findByText(/Initialize Skill Hub/));

    // After failure: escape appears, primary flips to Retry.
    const escape = await screen.findByText("Set up later");
    expect(escape).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();

    await userEvent.click(escape);
    expect(useAppStore.getState().degradedMode).toBe(true);
  });

  it("nudges when no harness is installed", () => {
    useAppStore.setState({
      harnesses: [
        { id: "claude-code", label: "Claude Code", installed: false, on_globally: false, used_by_projects: [] },
        { id: "codex", label: "Codex", installed: false, on_globally: false, used_by_projects: [] },
      ],
    });
    renderWithProviders(<BootstrapWizard state={makeState()} />);
    expect(
      screen.getByText(/No coding agent is installed on this machine yet/),
    ).toBeInTheDocument();
  });

  it("omits the no-harness nudge when a harness is installed", () => {
    renderWithProviders(<BootstrapWizard state={makeState()} />);
    expect(
      screen.queryByText(/No coding agent is installed on this machine yet/),
    ).not.toBeInTheDocument();
  });
});
