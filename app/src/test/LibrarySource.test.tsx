import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, sampleRegistry, primeRegistry, makeQueryClient } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { deriveSources, inferSkillSourceId, sourceForSkill } from "@/lib/skillSource";

describe("skillSource helpers", () => {
  it("infers local ownership when managed is absent and path is under hub", () => {
    expect(
      inferSkillSourceId({
        source: "~/skill-hub/skills/foo",
        type: "claude-skill",
        scope: "global",
        version: "1.0.0",
        description: "",
        upstream: null,
      }),
    ).toBe("local");
  });

  it("uses origin.source for external skills", () => {
    expect(
      inferSkillSourceId({
        source: "/cache",
        type: "claude-skill",
        scope: "portable",
        version: "1.0.0",
        description: "",
        upstream: null,
        managed: "external",
        origin: { source: "org-skills" },
      }),
    ).toBe("org-skills");
  });

  it("deriveSources includes builtins and configured git sources with skill counts", () => {
    const views = deriveSources(sampleRegistry);
    const byId = Object.fromEntries(views.map((v) => [v.id, v]));
    expect(byId.local).toBeTruthy();
    expect(byId.starter).toBeTruthy();
    expect(byId["org-skills"]?.type).toBe("git");
    expect(byId["org-skills"]?.skill_count).toBe(1);
    expect(byId.local?.skill_count).toBeGreaterThanOrEqual(1);
  });

  it("sourceForSkill returns the configured Git view for an external skill", () => {
    const view = sourceForSkill("android-compose-ui", sampleRegistry);
    expect(view.id).toBe("org-skills");
    expect(view.status).toBe("update-available");
  });
});

describe("SkillLibrary source filter + grouping", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders source chips next to each skill row", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });
    // External and local rows both render their owning source chip; the chip
    // text also appears in the source-filter chip bar, so use getAllByText.
    expect(screen.getAllByText("Org Skills").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Local").length).toBeGreaterThan(0);
  });

  it("filters skills by source when a source chip is selected", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });

    // brainstorm is local; android-compose-ui is external (org-skills).
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
    expect(screen.getByText("android-compose-ui")).toBeInTheDocument();

    // Filter to Org Skills only.
    fireEvent.click(screen.getByTitle(/Filter by source: Org Skills/));
    expect(screen.queryByText("brainstorm")).toBeNull();
    expect(screen.getByText("android-compose-ui")).toBeInTheDocument();
  });

  it("groups by source when BY SOURCE is selected and persists the choice", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });

    // Default is by scope — GLOBAL/PORTABLE/PROJECT section labels are present.
    expect(screen.getAllByText("GLOBAL").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByTitle("Group by source"));
    // The Org Skills section header (uppercase rendering) replaces the scope headers.
    expect(screen.getByText("ORG SKILLS")).toBeInTheDocument();
    // Persistence: pref written to localStorage.
    expect(window.localStorage.getItem("st-library-grouping")).toBe("source");
  });

  it("shows an amber status dot on the Org Skills source chip when update-available", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(<SkillLibrary />, { client });
    const orgChip = container.querySelector('[title*="Org Skills"]');
    expect(orgChip).toBeTruthy();
    // The chip dot inherits --amber for update-available; the dot element
    // exists inside the chip.
    const dot = orgChip?.querySelector(".dot");
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.background).toContain("amber");
  });
});
