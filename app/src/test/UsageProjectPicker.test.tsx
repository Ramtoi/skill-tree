import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { UsageProjectPicker } from "@/screens/usage/UsageProjectPicker";
import type { ProjectTotal } from "@/screens/usage/usageAggregate";
import { renderWithProviders } from "./helpers";

function project(label: string, costUsd: number, sessions = 2): ProjectTotal {
  return { key: label, label, hubProject: label, sessions, tokens: { total: costUsd * 1000 } as ProjectTotal["tokens"], costUsd, toolCalls: 1 };
}

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname} {JSON.stringify(location.state)}</output>;
}

describe("UsageProjectPicker", () => {
  it("ranks registered projects and exposes the dialog trigger", async () => {
    renderWithProviders(<><UsageProjectPicker projects={[project("low", 1), project("high", 9)]} projectKeys={new Set(["low", "high"])} range="7d" harness={null} currency="USD" eurRate={.86} /><Probe /></>);
    const trigger = screen.getByRole("button", { name: "Open project" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Open project" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(expect.arrayContaining(["high$9.009k tokens · 2 sessions", "low$1.001k tokens · 2 sessions"]));
  });

  it("filters nine candidates and Enter opens the first match with the window handoff", async () => {
    const projects = Array.from({ length: 9 }, (_, index) => project(`project-${index}`, 9 - index));
    renderWithProviders(<><UsageProjectPicker projects={projects} projectKeys={new Set(projects.map((item) => item.hubProject!))} range="7d" harness={null} currency="USD" eurRate={.86} /><Probe /></>);
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const search = screen.getByRole("searchbox", { name: "Search projects" });
    await userEvent.type(search, "project-4");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent('/usage/project/project-4');
    expect(screen.getByTestId("location")).toHaveTextContent('"usageWindow":7');
  });

  it("limits rows to registered projects and gives a discoverable empty reason", () => {
    renderWithProviders(<UsageProjectPicker projects={[project("unregistered", 4)]} projectKeys={new Set()} range="all" harness="codex" harnessName="Codex" currency="USD" eurRate={.86} />);
    const trigger = screen.getByRole("button", { name: "Open project" });
    expect(trigger).toHaveAttribute("title", "No projects with usage in this range for Codex in the latest scan");
    expect(trigger).toHaveAttribute("aria-disabled", "true");
  });

  it("opens the clicked project with the 90-day handoff for the all range", async () => {
    renderWithProviders(<><UsageProjectPicker projects={[project("alpha", 4)]} projectKeys={new Set(["alpha"])} range="all" harness={null} currency="USD" eurRate={.86} /><Probe /></>);
    const trigger = screen.getByRole("button", { name: "Open project" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/opens the last 90 days/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /alpha/ }));
    expect(screen.getByTestId("location")).toHaveTextContent('/usage/project/alpha');
    expect(screen.getByTestId("location")).toHaveTextContent('"usageWindow":90');
  });
});
