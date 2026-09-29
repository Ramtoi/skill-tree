import { describe, it, expect, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import {
  useAppStore,
  readRecent,
  writeRecent,
  isValidRecent,
  RECENT_KEY,
  RECENT_CAP,
} from "@/store";
import { parsePath, useTrackRecent } from "@/hooks/useRecent";
import { recentHref, recentIcon } from "@/components/NavPanel";
import { recentResolves, resolvableRecent } from "@/lib/recentResolve";
import { sampleRegistry } from "./helpers";
import { RECENT_TYPES, type RecentItem } from "@/types";
import { ICONS } from "@/components/icons";

function reset() {
  localStorage.clear();
  useAppStore.setState({ recentlyVisited: [] });
}

beforeEach(reset);

// ─── Store: persistence, cap, validation ─────────────────────────────────────

describe("Recent — store", () => {
  it("persists every push under st:recent", () => {
    useAppStore.getState().addRecentlyVisited({ type: "skill", name: "unslop" });
    const raw = localStorage.getItem(RECENT_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([{ type: "skill", name: "unslop" }]);
  });

  it("rehydrates from localStorage through readRecent", () => {
    writeRecent([
      { type: "project", name: "example-app" },
      { type: "bundle", name: "android" },
    ]);
    expect(readRecent()).toEqual([
      { type: "project", name: "example-app" },
      { type: "bundle", name: "android" },
    ]);
  });

  it("drops stored entries whose kind no longer has a route", () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { type: "source", name: "permissions" },
        { type: "skill", name: "unslop" },
      ]),
    );
    expect(readRecent()).toEqual([{ type: "skill", name: "unslop" }]);
  });

  it("survives a corrupt stored value instead of throwing", () => {
    localStorage.setItem(RECENT_KEY, "{not json");
    expect(readRecent()).toEqual([]);
    localStorage.setItem(RECENT_KEY, JSON.stringify({ nope: true }));
    expect(readRecent()).toEqual([]);
  });

  it(`caps the strip at ${RECENT_CAP} and keeps the newest first`, () => {
    for (let i = 0; i < RECENT_CAP + 4; i += 1) {
      useAppStore
        .getState()
        .addRecentlyVisited({ type: "skill", name: `skill-${i}` });
    }
    const items = useAppStore.getState().recentlyVisited;
    expect(items).toHaveLength(RECENT_CAP);
    expect(items[0].name).toBe(`skill-${RECENT_CAP + 3}`);
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toHaveLength(
      RECENT_CAP,
    );
  });

  it("de-duplicates by (type, name), promoting the repeat to the front", () => {
    const add = useAppStore.getState().addRecentlyVisited;
    add({ type: "skill", name: "a" });
    add({ type: "project", name: "b" });
    add({ type: "skill", name: "a" });
    expect(useAppStore.getState().recentlyVisited).toEqual([
      { type: "skill", name: "a" },
      { type: "project", name: "b" },
    ]);
  });

  it("rejects router sentinel names (__none__ and friends)", () => {
    const add = useAppStore.getState().addRecentlyVisited;
    add({ type: "project", name: "__none__" });
    add({ type: "bundle", name: "__new__" });
    expect(useAppStore.getState().recentlyVisited).toEqual([]);
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
  });

  it("rejects empty and non-recordable kinds at the door", () => {
    expect(isValidRecent({ type: "skill", name: "" })).toBe(false);
    expect(isValidRecent({ type: "source", name: "x" })).toBe(false);
    expect(isValidRecent(null)).toBe(false);
    expect(isValidRecent({ type: "skill", name: "ok" })).toBe(true);
  });
});

// ─── parsePath: explicit route table ─────────────────────────────────────────

describe("Recent — parsePath", () => {
  const cases: Array<[string, RecentItem | null]> = [
    ["/skill/unslop", { type: "skill", name: "unslop" }],
    ["/project/example-app", { type: "project", name: "example-app" }],
    ["/bundle/android", { type: "bundle", name: "android" }],
    ["/hook/lsp-report", { type: "hook", name: "lsp-report" }],
    ["/harness/claude-code", { type: "harness", name: "claude-code" }],
    ["/remote/hermes-main", { type: "remote", name: "hermes-main" }],
    ["/cloud/claude-ai", { type: "cloud", name: "claude-ai" }],
    ["/snippet/house-rules", { type: "snippet", name: "house-rules" }],
    // Sub-routes record the parent entity, never "id/doc".
    ["/harness/claude-code/doc", { type: "harness", name: "claude-code" }],
    // Encoded ids come back decoded.
    ["/skill/my%20skill", { type: "skill", name: "my skill" }],
    // Screens that ARE their own list record nothing.
    ["/", null],
    ["", null],
    ["/permissions", null],
    ["/sources", null],
    ["/snippets", null],
    ["/remotes", null],
    ["/hooks", null],
    ["/harnesses", null],
    ["/usage", null],
    ["/backup", null],
    // Create routes are VERBS. `/hook/new` used to leave a permanent chip
    // called "new" that navigated back into a blank, unsaved form.
    ["/hook/new", null],
    ["/skill/new", null],
    ["/project/new", null],
    ["/bundle/new", null],
    ["/snippet/new", null],
    // …but only on the segments that actually spend the word on a verb.
    ["/harness/new", { type: "harness", name: "new" }],
  ];

  it.each(cases)("%s", (path, expected) => {
    expect(parsePath(path)).toEqual(expected);
  });

  it("covers exactly the recordable types", () => {
    const produced = new Set(
      cases
        .map(([, item]) => item?.type)
        .filter((t): t is RecentItem["type"] => !!t),
    );
    expect([...produced].sort()).toEqual([...RECENT_TYPES].sort());
  });

  it("keeps usage drill-down routes silent by design D14.1", () => {
    expect(parsePath("/usage/project/skill-hub")).toBeNull();
    expect(parsePath("/usage/session/123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });
});

// ─── Regression: a sentinel route leaves the strip empty ─────────────────────

function Tracker() {
  useTrackRecent();
  return null;
}

describe("Recent — route recorder", () => {
  it("visiting /project/__none__ leaves Recent empty", () => {
    render(
      <MemoryRouter initialEntries={["/project/__none__"]}>
        <Tracker />
      </MemoryRouter>,
    );
    expect(useAppStore.getState().recentlyVisited).toEqual([]);
  });

  it("visiting /permissions records nothing (the old fake source chip)", () => {
    render(
      <MemoryRouter initialEntries={["/permissions"]}>
        <Tracker />
      </MemoryRouter>,
    );
    expect(useAppStore.getState().recentlyVisited).toEqual([]);
  });

  it("visiting a real project route records it", () => {
    render(
      <MemoryRouter initialEntries={["/project/example-app"]}>
        <Tracker />
      </MemoryRouter>,
    );
    expect(useAppStore.getState().recentlyVisited).toEqual([
      { type: "project", name: "example-app" },
    ]);
  });
});

// ─── Chip rendering is exhaustive over the union ─────────────────────────────

describe("Recent — chip href/icon", () => {
  /** Mirrors the `<Route path>` list in App.tsx. A chip href that matches none
   *  of these would land on the `*` redirect back to the Library. */
  const ROUTES = [
    /^\/skill\/[^/]+$/,
    /^\/project\/[^/]+$/,
    /^\/bundle\/[^/]+$/,
    /^\/hook\/[^/]+$/,
    /^\/harness\/[^/]+$/,
    /^\/remote\/[^/]+$/,
    /^\/cloud\/[^/]+$/,
    /^\/snippet\/[^/]+$/,
  ];

  it.each([...RECENT_TYPES])("%s resolves to a real route + icon", (type) => {
    const href = recentHref({ type, name: "thing" });
    expect(ROUTES.some((r) => r.test(href))).toBe(true);
    const icon = recentIcon({ type, name: "thing" });
    expect(Object.keys(ICONS)).toContain(icon);
  });

  it("encodes the name into the href", () => {
    expect(recentHref({ type: "skill", name: "a b" })).toBe("/skill/a%20b");
  });
});

// ─── Reconciling persisted chips with the live registry (finding 3) ──────────

describe("recentResolves", () => {
  const reg = sampleRegistry;

  it("keeps registry-backed entities that still exist", () => {
    expect(recentResolves({ type: "project", name: "example-app" }, reg)).toBe(true);
    expect(recentResolves({ type: "bundle", name: "android" }, reg)).toBe(true);
    expect(recentResolves({ type: "skill", name: "brainstorm" }, reg)).toBe(true);
  });

  it("drops registry-backed entities that are gone", () => {
    expect(recentResolves({ type: "project", name: "gone" }, reg)).toBe(false);
    expect(recentResolves({ type: "bundle", name: "gone" }, reg)).toBe(false);
    expect(recentResolves({ type: "skill", name: "gone" }, reg)).toBe(false);
  });

  it("validates cloud ids against the fixed in-code catalog", () => {
    expect(recentResolves({ type: "cloud", name: "claude-ai" }, reg)).toBe(true);
    expect(recentResolves({ type: "cloud", name: "made-up" }, reg)).toBe(false);
  });

  it("validates a remote only when the registry has a remotes block at all", () => {
    expect(recentResolves({ type: "remote", name: "hermes-main" }, reg)).toBe(true);
    const withRemotes = {
      ...reg,
      remotes: { "hermes-main": { connector: "hermes" } },
    };
    expect(recentResolves({ type: "remote", name: "hermes-main" }, withRemotes)).toBe(
      true,
    );
    expect(recentResolves({ type: "remote", name: "other" }, withRemotes)).toBe(false);
  });

  it("passes through kinds the registry cannot describe", () => {
    expect(recentResolves({ type: "hook", name: "lsp-report" }, reg)).toBe(true);
    expect(recentResolves({ type: "harness", name: "codex" }, reg)).toBe(true);
  });

  it("keeps everything while the registry is still loading", () => {
    expect(recentResolves({ type: "project", name: "gone" }, undefined)).toBe(true);
    expect(
      resolvableRecent([{ type: "project", name: "gone" }], undefined),
    ).toHaveLength(1);
  });

  it("filters in recorded order", () => {
    expect(
      resolvableRecent(
        [
          { type: "project", name: "gone" },
          { type: "bundle", name: "android" },
          { type: "skill", name: "brainstorm" },
        ],
        reg,
      ),
    ).toEqual([
      { type: "bundle", name: "android" },
      { type: "skill", name: "brainstorm" },
    ]);
  });
});
