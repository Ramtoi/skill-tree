import { describe, expect, it } from "vitest";
import { projectLoadout, sectionKey } from "@/lib/projectLoadout";
import {
  readSectionOrder,
  reconcileOrder,
  moveSection,
} from "@/lib/projectLoadoutOrder";
import { readLoadoutReturn } from "@/lib/projectLoadoutReturn";
import { sampleRegistry } from "./helpers";
import { loadoutActivity } from "@/screens/project/ProjectActivityOverview";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";

function fixture() {
  const registry = structuredClone(sampleRegistry);
  registry.bundles = {
    one: {
      description: "",
      icon: "",
      skills: ["brainstorm", "fs-mcp"],
      scope: "project-specific",
      playbook: [
        { id: "start", title: "Start", skills: ["brainstorm", "fs-mcp"] },
        { id: "empty", title: "Later", skills: [], guidance: "Future work" },
      ],
    },
    two: {
      description: "",
      icon: "",
      skills: ["brainstorm", "fs-mcp", "missing"],
      scope: "global",
      playbook: [
        { id: "start", title: "Shared", skills: ["brainstorm", "fs-mcp"] },
      ],
    },
  };
  const project = {
    ...registry.projects["example-app"],
    bundles: ["one", "two"],
    enabled: ["brainstorm", "rt-android-expert", "android-compose-ui"],
  };
  return { registry, project };
}
describe("project loadout projection", () => {
	it("keeps old return entries valid while defaulting a missing or malformed available query", () => {
		const prior = {
			project: "example-app",
			query: "loadout",
			exact: null,
			source: "bundle",
			collapsed: ["bundle:android"],
			disclosed: ["bundle:android:fs-mcp"],
			panel: "library" as const,
			hooks: false,
			scroll: 18,
			focus: "available:fs-mcp",
		};
		expect(readLoadoutReturn({ projectLoadout: prior }, "example-app")).toMatchObject({
			...prior,
			availableQuery: "",
		});
		expect(
			readLoadoutReturn(
				{ projectLoadout: { ...prior, availableQuery: 42 } },
				"example-app",
			),
		).toMatchObject({ ...prior, availableQuery: "" });
	});
	it("repeats shared members in each source, counts unique identities, and preserves named empty sections", () => {
    const { registry, project } = fixture();
    const before = structuredClone({ registry, project });
    const result = projectLoadout(project, registry);
    expect(result.sources).toEqual(["one", "two"]);
    expect(
      result.sections
        .flatMap((section) => section.members)
        .filter((name) => name === "fs-mcp"),
    ).toHaveLength(2);
    expect(result.mcp).toEqual(["fs-mcp"]);
    expect(result.skills).toHaveLength(3);
    expect(result.unresolved).toEqual(["missing"]);
    expect(result.sections[1]).toMatchObject({
      title: "Later",
      guidance: "Future work",
      members: [],
    });
    expect(result.sections[result.sections.length - 1]?.members).toEqual([
      "android-compose-ui",
      "rt-android-expert",
    ]);
    expect({ registry, project }).toEqual(before);
    expect(sectionKey(result.sections[0].ref)).not.toEqual(
      sectionKey(result.sections[2].ref),
    );
  });
  it("reconciles saved positions against fresh sections without restoring content or changing member order", () => {
    const { project, registry } = fixture();
    const sections = projectLoadout(project, registry).sections;
    const refs = sections.map((section) => section.ref);
    const moved = moveSection(refs, sectionKey(refs[2]), sectionKey(refs[0]));
    expect(moved[0]).toEqual(refs[2]);
    const next = [
      refs[0],
      refs[2],
      { kind: "bundle" as const, bundle: "new", section: "start" },
    ];
    expect(reconcileOrder([...moved, moved[0]], next)).toEqual([
      refs[2],
      refs[0],
      next[2],
    ]);
    expect(reconcileOrder(null, next)).toEqual(next);
    expect(sections[0].members).toEqual(["brainstorm", "fs-mcp"]);
  });
  it("rejects corrupt storage and malformed return state", () => {
    for (const value of [
      "x",
      "{}",
      '{"version":2,"sections":[]}',
      '{"version":1,"sections":[{"kind":"bundle"}]}',
    ])
      expect(readSectionOrder(value)).toBeNull();
    expect(
      readSectionOrder('{"version":1,"sections":[{"kind":"direct"}]}'),
    ).toEqual([{ kind: "direct" }]);
    expect(
      readLoadoutReturn({ projectLoadout: { project: "wrong" } }, "example-app")
        .panel,
    ).toBe("overview");
  });
});
it("activity excludes child sessions, old UTC days, removed skills and MCPs from the supplied skill set", () => {
  const payload = {
    sessions: [
      { harness: "codex", started_at: "2026-09-16T00:00:00Z" },
      {
        harness: "codex",
        started_at: "2026-09-16T00:00:00Z",
        parent_session_id: "parent",
      },
      { harness: "claude-code", started_at: "2026-08-18T00:00:00Z" },
      { harness: "claude-code", started_at: "2026-08-17T23:59:59Z" },
    ],
    utilization: [
      { key: "brainstorm", count: 4 },
      { key: "removed", count: 99 },
      { key: "fs-mcp", count: 20 },
    ],
  } as UsageProjectPayload;
  const data = loadoutActivity(
    payload,
    ["brainstorm"],
    new Date("2026-09-16T10:00:00Z"),
  );
  expect(data.sessions).toBe(2);
  expect(data.columns).toHaveLength(30);
  expect(data.observed.map((row) => row.key)).toEqual(["brainstorm"]);
  expect(data.datesMissing).toBe(false);
  payload.sessions.push({ harness: "codex" } as never);
  expect(loadoutActivity(payload, ["brainstorm"]).datesMissing).toBe(true);
});

it("keeps local order through explicit path changes and removes only that project's preference", async () => {
  const {
    migrateProjectLoadoutOrder,
    removeProjectLoadoutOrder,
    useLoadoutOrderStore,
  } = await import("@/hooks/useProjectLoadoutOrder");
  const { orderStorageKey } = await import("@/lib/projectLoadoutOrder");
  useLoadoutOrderStore.setState({ values: {} });
  const value = JSON.stringify({ version: 1, sections: [{ kind: "direct" }] });
  localStorage.setItem(orderStorageKey("/old"), value);
  localStorage.setItem(orderStorageKey("/other"), value);
  expect(migrateProjectLoadoutOrder("/old", "/new")).toBe(true);
  expect(localStorage.getItem(orderStorageKey("/old"))).toBeNull();
  expect(localStorage.getItem(orderStorageKey("/new"))).toBe(value);
  removeProjectLoadoutOrder("/new");
  expect(localStorage.getItem(orderStorageKey("/new"))).toBeNull();
  expect(localStorage.getItem(orderStorageKey("/other"))).toBe(value);
});
