import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { WorktreeAccessSection } from "@/components/permissions/WorktreeAccessSection";
import type { Capabilities, NormalizedPermissions } from "@/types/permissions";

const draft: NormalizedPermissions = { allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] };
const caps: Capabilities = { "claude-code": ["additional_directories"], codex: ["additional_directories"] };

describe("WorktreeAccessSection", () => {
  it("uses the backend suggestion until the user saves a value", () => {
    render(<WorktreeAccessSection draft={draft} onChange={() => {}} suggestion="/home/dev/Dev/worktrees/alpha" installed={["claude-code"]} capabilities={caps} labels={{ "claude-code": "Claude Code" }} />);
    expect(screen.getByLabelText("Worktree directory")).toHaveValue("/home/dev/Dev/worktrees/alpha");
    expect(screen.getByText(/Suggested path/)).toBeInTheDocument();
  });

  it("stages a custom path and toggle in the shared draft", () => {
    function Harness() {
      const [value, setValue] = useState(draft);
      return <WorktreeAccessSection draft={value} onChange={setValue} suggestion="/home/dev/default" installed={[]} capabilities={{}} labels={{}} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Worktree directory"), { target: { value: "/tmp/with spaces" } });
    fireEvent.click(screen.getByTestId("worktree-access-toggle"));
    expect(screen.getByTestId("worktree-access-toggle")).toBeChecked();
    expect(screen.getByLabelText("Worktree directory")).toHaveValue("/tmp/with spaces");
  });

  it("enables the suggested path without inventing a different saved path", () => {
    function Harness() {
      const [value, setValue] = useState(draft);
      return <WorktreeAccessSection draft={value} onChange={setValue} suggestion="/home/dev/default" installed={[]} capabilities={{}} labels={{}} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId("worktree-access-toggle"));
    expect(screen.getByLabelText("Worktree directory")).toHaveValue("/home/dev/default");
  });

  it("renders actual unsupported, missing, and failed statuses without inferring success", () => {
    render(<WorktreeAccessSection draft={{ ...draft, worktree_access: { enabled: true, path: "/tmp/wt" } }} onChange={() => {}} installed={[]} capabilities={{}} labels={{ codex: "Codex" }} status={{ requested_path: "/tmp/wt", missing_parent: true, harnesses: [
      { harness: "codex", config_state: "failed", runtime_state: "not_verified", reason: "Native file write failed" },
      { harness: "opencode", config_state: "unsupported", runtime_state: "not_applicable", reason: "Unsupported" },
      { harness: "pi", config_state: "not_installed", runtime_state: "not_applicable", reason: "Not installed" },
      { harness: "borrowed", config_state: "borrowed", runtime_state: "restart_required", reason: "Existing grant retained" },
      { harness: "legacy", config_state: "unmanaged", runtime_state: "not_applicable", reason: "Harness is unmanaged" },
      { harness: "old", config_state: "removed", runtime_state: "not_applicable", reason: "Grant removed" },
    ] }} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("unsupported")).toBeInTheDocument();
    expect(screen.getByText("not installed")).toBeInTheDocument();
    expect(screen.getByText("existing grant")).toBeInTheDocument();
    expect(screen.getByText("unmanaged")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
    expect(screen.getByText("restart required")).toBeInTheDocument();
    expect(screen.getByText("Create this directory before starting a fresh session.")).toBeInTheDocument();
    expect(screen.queryByText("configured")).toBeNull();
  });

  it("shows an unavailable state when an older backend omits status", () => {
    render(<WorktreeAccessSection draft={draft} onChange={() => {}} installed={["claude-code"]} capabilities={{}} labels={{}} />);
    expect(screen.getByText(/Harness status is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("configured")).toBeNull();
  });

  it("discloses nested metadata behavior", () => {
    render(<WorktreeAccessSection draft={draft} onChange={() => {}} installed={[]} capabilities={{}} labels={{}} />);
    fireEvent.click(screen.getByText("Nested metadata can differ"));
    expect(screen.getByText(/do not isolate agents/)).toBeInTheDocument();
  });
});
