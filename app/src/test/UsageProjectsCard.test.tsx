import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageProjectsCard } from "@/screens/usage/UsageProjectsCard";
import { zeroTokens, type ProjectTotal } from "@/screens/usage/usageAggregate";

function project(overrides: Partial<ProjectTotal> & { key: string; label: string }): ProjectTotal {
  return {
    key: overrides.key,
    label: overrides.label,
    hubProject: overrides.hubProject,
    sessions: overrides.sessions ?? 1,
    tokens: overrides.tokens ?? zeroTokens(),
    costUsd: overrides.costUsd ?? 1,
    toolCalls: overrides.toolCalls ?? 0,
  };
}

function baseProps(overrides: Partial<{ projects: ProjectTotal[]; projectKeys: ReadonlySet<string>; onOpenProject: (name: string) => void }> = {}) {
  return {
    projects: overrides.projects ?? [],
    currency: "USD" as const,
    eurRate: 0.86,
    projectKeys: overrides.projectKeys ?? new Set<string>(),
    onOpenProject: overrides.onOpenProject ?? vi.fn(),
  };
}

describe("UsageProjectsCard", () => {
  it("links a row whose hubProject is set AND present in projectKeys", async () => {
    const onOpenProject = vi.fn();
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [project({ key: "skill-tree", label: "skill-tree", hubProject: "skill-tree", costUsd: 10 })],
          projectKeys: new Set(["skill-tree"]),
          onOpenProject,
        })}
      />,
    );
    const link = screen.getByRole("button", { name: "skill-tree" });
    await userEvent.click(link);
    expect(onOpenProject).toHaveBeenCalledWith("skill-tree");
  });

  it("does not link a row whose hubProject is set but NOT in projectKeys", () => {
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [project({ key: "moon-base", label: "moon-base", hubProject: "moon-base", costUsd: 10 })],
          projectKeys: new Set(["some-other-project"]),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "moon-base" })).toBeNull();
    expect(screen.getByText("moon-base")).toBeInTheDocument();
  });

  it("does not link a row with no hubProject at all", () => {
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [project({ key: "anon-label", label: "anon-label", costUsd: 10 })],
          projectKeys: new Set(["anon-label"]),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "anon-label" })).toBeNull();
    expect(screen.getByText("anon-label")).toBeInTheDocument();
  });

  it("renders the Unregistered row named, hinted, and unlinked — even when it is the only row", () => {
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [project({ key: "No project", label: "No project", sessions: 4, costUsd: 3 })],
        })}
      />,
    );
    expect(screen.getByText("Unregistered")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unregistered" })).toBeNull();
    expect(screen.getByText(/sessions in directories no project covers/)).toBeInTheDocument();
    expect(screen.getByText("Register a project to attribute these.")).toBeInTheDocument();
  });

  it("survives a nine-registered-label list: the Unregistered bucket is hoisted OUT of the top-8 slice", () => {
    const registered = Array.from({ length: 9 }, (_, i) =>
      project({ key: `p${i}`, label: `p${i}`, hubProject: `p${i}`, costUsd: 100 - i }),
    );
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [...registered, project({ key: "No project", label: "No project", sessions: 2, costUsd: 1 })],
          projectKeys: new Set(registered.map((p) => p.hubProject!)),
        })}
      />,
    );
    // Top 8 registered rows show; the 9th registered ("p8", the cheapest) is
    // sliced away, but Unregistered — hoisted out of the slice — still shows.
    expect(screen.getByText("p0")).toBeInTheDocument();
    expect(screen.getByText("p7")).toBeInTheDocument();
    expect(screen.queryByText("p8")).not.toBeInTheDocument();
    expect(screen.getByText("Unregistered")).toBeInTheDocument();
  });

  it("renders nothing when there are no project totals at all", () => {
    const { container } = render(<UsageProjectsCard {...baseProps({ projects: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the row values (sessions, tool calls, cost) unchanged by the linking change", () => {
    render(
      <UsageProjectsCard
        {...baseProps({
          projects: [
            project({ key: "skill-tree", label: "skill-tree", hubProject: "skill-tree", sessions: 3, toolCalls: 12, costUsd: 5 }),
          ],
          projectKeys: new Set(["skill-tree"]),
        })}
      />,
    );
    expect(screen.getByText(/3 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/12 tool calls/)).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });
});
