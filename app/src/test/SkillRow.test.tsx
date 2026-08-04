import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillRow } from "@/components/SkillRow";
import { renderWithProviders, sampleRegistry } from "./helpers";

describe("SkillRow (new API)", () => {
  it("renders the skill name (mono), kind tag, and description", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={onClick}
      />,
    );
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
    expect(screen.getByText("SKILL")).toBeInTheDocument();
    expect(
      screen.getByText("Brainstorm a feature with multiple experts."),
    ).toBeInTheDocument();
  });

  it("fires onClick when the row is activated", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByText("brainstorm"));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders MCP kind tag for mcp-server skills", () => {
    renderWithProviders(
      <SkillRow
        name="fs-mcp"
        skill={sampleRegistry.skills["fs-mcp"]}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });

  it("shows version", () => {
    renderWithProviders(
      <SkillRow
        name="brainstorm"
        skill={sampleRegistry.skills.brainstorm}
        registry={sampleRegistry}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });
});
