import { describe, it, expect } from "vitest";
import {
  GROUP_FOR_SECTION,
  GROUP_IDS,
  GROUP_META,
  SECTION_IDS,
  contentGroupForPath,
  groupForLocation,
  isContextMix,
  isInPlace,
  sectionForPath,
  type GroupId,
} from "@/lib/sections";

// The group layer is what the chrome hue and (milestone B) the panel body key
// off, so a section without a group is an unreachable surface, not a cosmetic
// gap. Totality is checked here rather than left to the Record<> type alone:
// the type catches a MISSING key, not a key mapped to a group nobody renders.

describe("GROUP_FOR_SECTION", () => {
  it("maps every section to a known group", () => {
    for (const section of SECTION_IDS) {
      const group = GROUP_FOR_SECTION[section];
      expect(GROUP_IDS, section).toContain(group);
    }
  });

  it("leaves no group without a section (an empty rail slot)", () => {
    const used = new Set<GroupId>(Object.values(GROUP_FOR_SECTION));
    for (const group of GROUP_IDS) expect(used, group).toContain(group);
  });

  it("names and glyphs every group", () => {
    for (const group of GROUP_IDS) {
      expect(GROUP_META[group].label.length).toBeGreaterThan(0);
      expect(GROUP_META[group].icon.length).toBeGreaterThan(0);
    }
  });
});

describe("sectionForPath", () => {
  it("strips a query string before matching, so a referrer's deep link resolves correctly", () => {
    expect(sectionForPath("/sources?focus=x")).toBe("sources");
    expect(sectionForPath("/sources")).toBe("sources");
  });

  it("strips a hash too", () => {
    expect(sectionForPath("/harness/claude-code#top")).toBe("harnesses");
  });
});

describe("groupForLocation", () => {
  it("resolves the plain routes", () => {
    expect(groupForLocation("/", null)).toBe("context");
    expect(groupForLocation("/snippets", null)).toBe("context");
    expect(sectionForPath("/snippet/x")).toBe("snippets");
    expect(groupForLocation("/snippet/x", null)).toBe("context");
    expect(groupForLocation("/project/example-app", null)).toBe("projects");
    expect(groupForLocation("/permissions", null)).toBe("guardrails");
    expect(groupForLocation("/hook/lsp-report", null)).toBe("guardrails");
    expect(groupForLocation("/harness/claude-code", null)).toBe("agents");
    expect(groupForLocation("/usage", null)).toBe("agents");
    expect(groupForLocation("/usage/project/skill-hub", null)).toBe("agents");
    expect(groupForLocation("/usage/session/123e4567-e89b-12d3-a456-426614174000", null)).toBe("agents");
    expect(groupForLocation("/sources", null)).toBe("elsewhere");
    expect(groupForLocation("/cloud/claude-ai", null)).toBe("elsewhere");
    expect(groupForLocation("/backup", null)).toBe("elsewhere");
  });

  it("follows the referrer, so a skill opened from a project stays Projects", () => {
    const fromProject = {
      from: { label: "example-app", path: "/project/example-app" },
    };
    expect(groupForLocation("/skill/brainstorm", fromProject)).toBe("projects");
    expect(groupForLocation("/bundle/android", fromProject)).toBe("projects");
  });

  it("crosses group boundaries with the referrer", () => {
    const fromRemote = {
      from: { label: "hermes-main", path: "/remote/hermes-main" },
    };
    expect(groupForLocation("/skill/brainstorm", fromRemote)).toBe("elsewhere");
    // No referrer ⇒ the route's own group.
    expect(groupForLocation("/skill/brainstorm", null)).toBe("context");
  });

  it("ignores unusable history state", () => {
    expect(groupForLocation("/skill/brainstorm", { backupNow: true })).toBe(
      "context",
    );
  });
});

describe("contentGroupForPath", () => {
  it("is the route's own group, ignoring any referrer entirely", () => {
    expect(contentGroupForPath("/skill/brainstorm")).toBe("context");
    expect(contentGroupForPath("/project/example-app")).toBe("projects");
    expect(contentGroupForPath("/permissions")).toBe("guardrails");
    expect(contentGroupForPath("/usage/project/skill-hub")).toBe("agents");
    expect(contentGroupForPath("/usage/session/123e4567-e89b-12d3-a456-426614174000")).toBe("agents");
  });
});

describe("isContextMix", () => {
  it("is false when the chrome and content groups agree", () => {
    expect(isContextMix("/skill/brainstorm", null)).toBe(false);
    expect(isContextMix("/project/example-app", null)).toBe(false);
  });

  it("is true once a referrer pulls the chrome into a different group", () => {
    const fromProject = {
      from: { label: "example-app", path: "/project/example-app" },
    };
    expect(isContextMix("/skill/brainstorm", fromProject)).toBe(true);
  });

  it("stays false when the referrer names a different SECTION in the same group", () => {
    // library and snippets are both "context" — the group agrees even though
    // the section doesn't, so there is nothing for the header to blend.
    const fromSnippets = {
      from: { label: "Snippets", path: "/snippets" },
    };
    expect(isContextMix("/skill/brainstorm", fromSnippets)).toBe(false);
  });
});

describe("isInPlace", () => {
  it("is false without a referrer", () => {
    expect(isInPlace("/skill/brainstorm", null)).toBe(false);
  });

  it("is false when the referrer only restates the route's own section", () => {
    const fromLibrary = { from: { label: "Library", path: "/" } };
    expect(isInPlace("/skill/brainstorm", fromLibrary)).toBe(false);
  });

  it("is true once the referrer names a different section", () => {
    const fromProject = {
      from: { label: "example-app", path: "/project/example-app" },
    };
    expect(isInPlace("/skill/brainstorm", fromProject)).toBe(true);
  });

  it("is false for malformed history state", () => {
    expect(isInPlace("/skill/brainstorm", { backupNow: true })).toBe(false);
    expect(isInPlace("/skill/brainstorm", "nonsense")).toBe(false);
  });
});
