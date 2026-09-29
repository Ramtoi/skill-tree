import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, sampleRegistry, primeRegistry, makeQueryClient } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { deriveSources, inferSkillSourceId, sourceForSkill } from "@/lib/skillSource";

/** Opens the inline SOURCE `Select` (the jsdom default renders it inline,
 *  not behind the Filter popover) and picks the option by name. */
async function pickSource(name: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: "Source" }));
  await userEvent.click(screen.getByRole("option", { name }));
}

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
    // `userEvent`'s awaits give react-query's `staleTime: 0` background
    // refetch time to land — an unmocked `read_registry` (setup.ts's default)
    // resolving to `undefined` would clobber the `primeRegistry`-seeded data
    // mid-test for every test here that opens the SOURCE combobox.
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "read_registry") return sampleRegistry;
      if (cmd === "local_skill_candidates") return [];
      if (cmd === "harness_list") return [];
      if (cmd === "hub_cmd") return { success: true, output: '{"sources":[],"errors":[]}' };
      return undefined;
    }) as never);
  });

  it("renders a source chip only for external sources", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });
    // External rows render their owning source chip. Local + starter are the
    // silent default (R1) on the ROW itself — a local skill's row carries no
    // `.source-chip`.
    const localRow = screen.getByText("brainstorm").closest(".resource-row")!;
    expect(localRow.querySelector(".source-chip")).toBeNull();
    const extRow = screen.getByText("android-compose-ui").closest(".resource-row")!;
    fireEvent.click(extRow.querySelector(".resource-disclosure")!);
    expect(screen.getByText("Org Skills")).toBeInTheDocument();
    expect(extRow.querySelector(".source-chip")).not.toBeNull();
  });

  it("filters skills by source when a source option is picked", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });

    // brainstorm is local; android-compose-ui is external (org-skills).
    expect(screen.getByText("brainstorm")).toBeInTheDocument();
    expect(screen.getByText("android-compose-ui")).toBeInTheDocument();

    // The SOURCE facet is the inline `Select`, in the subheader at the jsdom
    // default width (no Filter popover to open).
    await pickSource(/Org Skills/);
    expect(screen.queryByText("brainstorm")).toBeNull();
    expect(screen.getByText("android-compose-ui")).toBeInTheDocument();
  });

  it("groups by source when BY SOURCE is selected and persists the choice", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });

    // Default is by scope — GLOBAL/PORTABLE/PROJECT section labels are present.
    expect(screen.getAllByText("GLOBAL").length).toBeGreaterThanOrEqual(1);

    // GROUP is always in the right cluster — no Filter popover involved.
    fireEvent.click(screen.getByTitle("Group by source"));
    // The Org Skills section header (uppercase rendering) replaces the scope headers.
    expect(screen.getByText("ORG SKILLS")).toBeInTheDocument();
    // Persistence: pref written to localStorage.
    expect(window.localStorage.getItem("st-library-grouping")).toBe("source");
  });

  it("names the update-available status in the Org Skills option's hint", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<SkillLibrary />, { client });
    // The SOURCE facet is the inline `Select` at the jsdom default width.
    await userEvent.click(screen.getByRole("combobox", { name: "Source" }));
    const option = screen.getByRole("option", { name: /Org Skills/ });
    expect(option).toHaveTextContent("update available");
  });
});
