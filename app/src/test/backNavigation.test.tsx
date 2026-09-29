import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import {
  backReturnOptions,
  bundleBackTarget,
  fromNav,
  harnessDocBackTarget,
  projectAgentDocsBackTarget,
  projectBackTarget,
  readBackTarget,
  snippetBackTarget,
  subagentBackTarget,
} from "@/lib/backTarget";
import {
  GROUP_META,
  navAnchorPath,
  sectionForLocation,
} from "@/lib/sections";
import { IconRail } from "@/components/IconRail";
import { NavPanel } from "@/components/NavPanel";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkillEditor } from "@/screens/SkillEditor";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { GlobalPermissions } from "@/screens/GlobalPermissions";
import { Sources } from "@/screens/Sources";
import { Harnesses } from "@/screens/Harnesses";
import { useAppStore } from "@/store";
import {
  makeQueryClient,
  primeRegistry,
  renderWithProviders,
  sampleRegistry,
} from "./helpers";

// App calls getCurrentWindow() for fullscreen tracking — stub the window API
// (only the full-App-root tests below mount it; inert for everything else).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    setFullscreen: () => Promise.resolve(),
  }),
}));

/** Renders the router state of whatever route it lands on, so a test can prove
 *  the REFERRER travelled with the navigation — not just the pathname. */
function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="loc" data-from={JSON.stringify(loc.state ?? null)}>
      {loc.pathname}
    </div>
  );
}

function probeFrom() {
  return JSON.parse(screen.getByTestId("loc").dataset.from ?? "null");
}

function installHarness() {
  useAppStore.setState({
    harnesses: [
      {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        on_globally: true,
        used_by_projects: [],
      },
    ],
  });
}

describe("readBackTarget", () => {
  it("accepts a complete in-app target", () => {
    expect(readBackTarget(fromNav(projectBackTarget("example-app")).state)).toEqual(
      {
        label: "example-app",
        path: "/project/example-app",
        crumbs: ["project", "example-app"],
      },
    );
  });

  it("percent-encodes the path so an odd project name still routes", () => {
    expect(projectBackTarget("a b/c").path).toBe("/project/a%20b%2Fc");
  });

  it("returns null for absent or malformed state", () => {
    expect(readBackTarget(null)).toBeNull();
    expect(readBackTarget({})).toBeNull();
    expect(readBackTarget({ from: "/project/x" })).toBeNull();
    expect(readBackTarget({ from: { label: "x" } })).toBeNull();
    expect(readBackTarget({ from: { path: "/project/x" } })).toBeNull();
    expect(readBackTarget({ from: { label: "", path: "/x" } })).toBeNull();
  });

  it("rejects a path that would steer navigation off-app", () => {
    // History state survives a reload and is user-reachable; a protocol-
    // relative or external href must never become the back arrow's target.
    expect(readBackTarget({ from: { label: "x", path: "https://evil" } })).toBeNull();
    expect(readBackTarget({ from: { label: "x", path: "//evil.test" } })).toBeNull();
    expect(readBackTarget({ from: { label: "x", path: "/\\evil.test" } })).toBeNull();
    expect(readBackTarget({ from: { label: "x", path: "project/x" } })).toBeNull();
  });

  it("rejects a crumb trail that is not a list of strings", () => {
    expect(
      readBackTarget({ from: { label: "x", path: "/x", crumbs: "project" } }),
    ).toBeNull();
    expect(
      readBackTarget({ from: { label: "x", path: "/x", crumbs: [1, 2] } }),
    ).toBeNull();
  });

  // H1/H10: `restore` is an opaque payload (the Library's cursor/focus state)
  // carried through unchanged for a plain object, absent otherwise.
  it("accepts a query string in the path (R2: the Library's referrer carries its own search)", () => {
    expect(
      readBackTarget({ from: { label: "Library", path: "/?q=an" } }),
    ).toEqual({ label: "Library", path: "/?q=an" });
  });

  it("carries a plain-object restore payload through unchanged", () => {
    const restore = { cursorKey: "skill:brainstorm", focus: "bar" };
    const target = { label: "Library", path: "/?q=an", crumbs: ["library"], restore };
    expect(readBackTarget(fromNav(target).state)).toEqual(target);
  });

  it("drops the whole target when restore is anything other than a plain object", () => {
    expect(
      readBackTarget({ from: { label: "x", path: "/x", restore: "nope" } }),
    ).toBeNull();
    expect(
      readBackTarget({ from: { label: "x", path: "/x", restore: [1, 2] } }),
    ).toBeNull();
    expect(
      readBackTarget({ from: { label: "x", path: "/x", restore: null } }),
    ).toBeNull();
  });
});

describe("backReturnOptions", () => {
  it("returns undefined when the target has no restore payload", () => {
    expect(backReturnOptions({ label: "Library", path: "/" })).toBeUndefined();
  });

  // Finding 9: `restore` is opaque — `backReturnOptions` hands it back as
  // the WHOLE `state` object verbatim, never wrapping it under a hardcoded
  // key. The Library shapes it as `{ libReturn }` itself (`libraryBackTarget`);
  // `backTarget.ts` never knows that.
  it("carries a restore payload through as the whole state object, unwrapped", () => {
    const restore = { libReturn: { cursorKey: "skill:brainstorm", focus: "bar" } };
	    expect(backReturnOptions({ label: "Library", path: "/", restore })).toEqual({
	      state: restore,
		});
	});

	it("preserves the original filtered surface through two contributor hops", () => {
		const original = { label: "Library", path: "/?class=process&focus=skill:b", crumbs: ["library"], restore: { libReturn: { focus: "skill:b" } } };
		const b = { label: "b", path: "/skill/b", crumbs: ["skill", "b"], restore: { from: original } };
		const a = { label: "a", path: "/skill/a", crumbs: ["skill", "a"], restore: { from: b } };
		expect(readBackTarget(backReturnOptions(a)?.state)).toEqual(b);
		expect(readBackTarget(b.restore)).toEqual(original);
	});
});

// ─── The four doc-host back-target helpers (§Interfaces 3). Each returns the
// exact `{label,path,crumbs}` shape; `readBackTarget` accepts every one of
// them unchanged. ──────────────────────────────────────────────────────────

describe("harnessDocBackTarget", () => {
  it("returns the exact {label,path,crumbs} shape", () => {
    expect(harnessDocBackTarget("claude-code", "Claude Code")).toEqual({
      label: "Claude Code",
      path: "/harness/claude-code/doc",
      crumbs: ["harness", "claude-code"],
    });
  });

  it("percent-encodes the harness id in the path", () => {
    expect(harnessDocBackTarget("a b", "A B").path).toBe("/harness/a%20b/doc");
  });

  it("survives readBackTarget(fromNav(...))", () => {
    const t = harnessDocBackTarget("codex", "Codex");
    expect(readBackTarget(fromNav(t).state)).toEqual(t);
  });
});

describe("snippetBackTarget (F11)", () => {
  it("returns the create-form target for an empty name, with no restore", () => {
    expect(snippetBackTarget("")).toEqual({
      label: "New snippet",
      path: "/snippet/new",
      crumbs: ["snippet", "new"],
    });
  });

  it('returns the create-form target for the literal "new", with no restore', () => {
    expect(snippetBackTarget("new")).toEqual({
      label: "New snippet",
      path: "/snippet/new",
      crumbs: ["snippet", "new"],
    });
  });

  it("round-trips the create form's draft through restore.snippetDraft", () => {
    const draft = { name: "wip", desc: "d", tags: ["a"], body: "b" };
    const t = snippetBackTarget("", draft);
    expect(t).toEqual({
      label: "New snippet",
      path: "/snippet/new",
      crumbs: ["snippet", "new"],
      restore: { snippetDraft: draft },
    });
    expect(readBackTarget(fromNav(t).state)).toEqual(t);
    expect(backReturnOptions(t)).toEqual({ state: { snippetDraft: draft } });
  });

  it("returns an identity target for a real name, with no restore", () => {
    expect(snippetBackTarget("android-conventions")).toEqual({
      label: "android-conventions",
      path: "/snippet/android-conventions",
      crumbs: ["snippet", "android-conventions"],
    });
    expect(backReturnOptions(snippetBackTarget("android-conventions"))).toBeUndefined();
  });
});

describe("projectAgentDocsBackTarget", () => {
  it("returns the exact {label,path,crumbs} shape with no rel", () => {
    expect(projectAgentDocsBackTarget("example-app")).toEqual({
      label: "example-app",
      path: "/project/example-app?tab=agent-docs",
      crumbs: ["project", "example-app", "agent docs"],
    });
  });

  it("omits restore for a null/absent rel, and backReturnOptions is undefined", () => {
    const t = projectAgentDocsBackTarget("example-app", null);
    expect(t.restore).toBeUndefined();
    expect(backReturnOptions(t)).toBeUndefined();
  });

  it("carries the open file through restore.adSelected, surviving a round trip", () => {
    const t = projectAgentDocsBackTarget("p", "a/AGENTS.md");
    expect(t).toEqual({
      label: "p",
      path: "/project/p?tab=agent-docs",
      crumbs: ["project", "p", "agent docs"],
      restore: { adSelected: "a/AGENTS.md" },
    });
    expect(readBackTarget(fromNav(t).state)).toEqual(t);
    expect(backReturnOptions(t)).toEqual({ state: { adSelected: "a/AGENTS.md" } });
  });
});

describe("subagentBackTarget (F5)", () => {
  it("yields /harness/<h>?agent=<n> for a user-scoped agent", () => {
    expect(
      subagentBackTarget({ harness: "claude-code", name: "code-reviewer", scope: "user" }),
    ).toEqual({
      label: "code-reviewer",
      path: "/harness/claude-code?agent=code-reviewer",
      crumbs: ["harnesses", "claude-code", "sub-agents", "code-reviewer"],
    });
  });

  it("yields /project/<p>?tab=subagents — the list, with no ?agent= param — for a project-scoped agent", () => {
    const t = subagentBackTarget({
      harness: "claude-code",
      name: "code-reviewer",
      scope: "project",
      project: "example-app",
    });
    expect(t).toEqual({
      label: "example-app",
      path: "/project/example-app?tab=subagents",
      crumbs: ["project", "example-app", "sub-agents"],
    });
    expect(t.path).not.toContain("agent=");
  });

  it("falls back to the user-scope shape when scope is 'project' but no project is given", () => {
    expect(
      subagentBackTarget({ harness: "claude-code", name: "code-reviewer", scope: "project", project: null }),
    ).toEqual({
      label: "code-reviewer",
      path: "/harness/claude-code?agent=code-reviewer",
      crumbs: ["harnesses", "claude-code", "sub-agents", "code-reviewer"],
    });
  });

  it("survives readBackTarget(fromNav(...)) in both shapes", () => {
    const user = subagentBackTarget({ harness: "codex", name: "x", scope: "user" });
    expect(readBackTarget(fromNav(user).state)).toEqual(user);
    const project = subagentBackTarget({
      harness: "codex",
      name: "x",
      scope: "project",
      project: "example-app",
    });
    expect(readBackTarget(fromNav(project).state)).toEqual(project);
  });
});

describe("SkillEditor back arrow", () => {
  function renderEditor(state?: unknown) {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    return renderWithProviders(
      <Routes>
        <Route path="/skill/:name" element={<SkillEditor />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        client,
        initialRoute: { pathname: "/skill/brainstorm", state },
      },
    );
  }

  it("returns to the library when the skill was opened without a referrer", async () => {
    renderEditor();
    const back = await screen.findByRole("button", { name: "Back to Library" });
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/"),
    );
  });

  it("returns to the project the skill was opened from", async () => {
    renderEditor(fromNav(projectBackTarget("example-app")).state);
    const back = await screen.findByRole("button", { name: "Back to example-app" });
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-app"),
    );
  });

  it("names the referrer in the crumb trail instead of the library", async () => {
    const { container } = renderEditor(
      fromNav(projectBackTarget("example-app")).state,
    );
    await screen.findByRole("button", { name: "Back to example-app" });
    const crumbs = container.querySelector(".crumbs")?.textContent ?? "";
    expect(crumbs).toContain("project");
    expect(crumbs).toContain("example-app");
    expect(crumbs).not.toContain("library");
  });

  // H1/finding 9: a Library referrer's `restore` is the WHOLE state object
  // it wants back (opaque to `backTarget.ts`) — the explicit back arrow
  // hands it to `navigate` unchanged, so it behaves like a real history pop.
  it("carries the referrer's restore payload back as libReturn state (H1)", async () => {
    const restore = { libReturn: { cursorKey: "skill:brainstorm", focus: "bar" } };
    renderEditor(
      fromNav({ label: "Library", path: "/?q=brainstorm", crumbs: ["library"], restore })
        .state,
    );
    const back = await screen.findByRole("button", { name: "Back to Library" });
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/"),
    );
    expect(probeFrom()).toEqual(restore);
  });
});

describe("Library bundle mode back arrow", () => {
  function renderBundle(state?: unknown) {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    // `staleTime: 0` fires a background refetch of every active query on
    // mount; setup.ts's default reply doesn't cover these commands, and
    // react-query drops a query's data when its queryFn resolves
    // `undefined` — each needs a real reply so it never clobbers state.
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === "read_registry") return Promise.resolve(client.getQueryData(["registry"]));
      if (cmd === "local_skill_candidates" || cmd === "snippets_list") return Promise.resolve([]);
      if (cmd === "read_search_corpus") return Promise.resolve({ skills: {}, snippets: {} });
      return Promise.resolve({ success: true, output: "" });
    }) as never);
    return renderWithProviders(
      <Routes>
        <Route path="/bundle/:name" element={<SkillLibrary />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { client, initialRoute: { pathname: "/bundle/android", state } },
    );
  }

  it("returns to the project a bundle chip was clicked from", async () => {
    renderBundle(fromNav(projectBackTarget("example-app")).state);
    fireEvent.click(await screen.findByRole("button", { name: "Back to example-app" }));
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-app"),
    );
  });

  it("hands its own identity to a skill opened from it", async () => {
    expect(bundleBackTarget("android")).toEqual({
      label: "android",
      path: "/bundle/android",
      crumbs: ["bundle", "android"],
    });
  });

  it("carries the bundle as the referrer when an Applied-to project's open link is clicked", async () => {
    // Applied to is a band Chip anchoring an inline EquipPicker whose rows
    // toggle equip rather than navigate — the row's own "open" link (in its
    // meta slot) is the screen's only route TO a project.
    renderBundle();
    fireEvent.click(await screen.findByTestId("bundle-applied-chip"));
    const row = (await screen.findByText("example-app")).closest(
      ".equip-option",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("link", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-app"),
    );
    expect(probeFrom()).toEqual({
      from: bundleBackTarget("android"),
    });
  });
});

describe("ProjectWorkspace hands its identity to detail routes", () => {
  function renderWorkspace() {
    installHarness();
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    return renderWithProviders(
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { client, initialRoute: "/project/example-app" },
    );
  }

  it("carries the project as the referrer when an equipped skill is opened", async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByText("brainstorm"));
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm"),
    );
    expect(probeFrom()).toMatchObject({
      from: {
        label: "example-app",
        path: "/project/example-app",
        crumbs: ["project", "example-app"],
      },
    });
  });

  it("carries the project as the referrer when an applied bundle is opened", async () => {
    const { container } = renderWorkspace();
    const chip = await waitFor(() => {
      const el = container.querySelector(".bundle-chip");
      if (!el) throw new Error("no applied-bundle chip");
      return el;
    });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android"),
    );
    expect(probeFrom()).toMatchObject({
      from: {
        label: "example-app",
        path: "/project/example-app",
        crumbs: ["project", "example-app"],
      },
    });
  });
});

// ─── ScreenHeader's automatic back arrow, on a real "shown in place" screen ──
// ProjectWorkspace never passes its own `back` prop — it relies entirely on
// the primitive deriving one from `isInPlace` (see ScreenHeader.tsx). A
// project reached from Permissions (guardrails) is exactly that: a project
// detail shown inside a different section's context.

describe("ProjectWorkspace's automatic back arrow", () => {
  function renderWorkspace(state?: unknown) {
    installHarness();
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    return renderWithProviders(
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { client, initialRoute: { pathname: "/project/example-app", state } },
    );
  }

  it("renders a back arrow to the referring section and follows it", async () => {
    renderWorkspace(
      fromNav({ label: "Permissions", path: "/permissions" }).state,
    );
    const back = await screen.findByRole("button", { name: "Back to Permissions" });
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/permissions"),
    );
  });

  it("renders no back arrow when the project was opened without a referrer", async () => {
    renderWorkspace();
    await screen.findByText("example-app");
    expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
  });
});

// ─── Section chrome follows the referrer ─────────────────────────────────────
// The back arrow and the shell must agree about where you are: a skill opened
// from a project belongs to Projects until you leave it.

describe("sectionForLocation", () => {
  const projectState = fromNav(projectBackTarget("example-app")).state;

  it("falls back to the route's own section without a referrer", () => {
    expect(sectionForLocation("/skill/brainstorm", null)).toBe("library");
    expect(sectionForLocation("/project/example-app", null)).toBe("projects");
  });

  it("follows the referrer on a detail route", () => {
    expect(sectionForLocation("/skill/brainstorm", projectState)).toBe(
      "projects",
    );
    expect(sectionForLocation("/bundle/android", projectState)).toBe("projects");
    expect(
      sectionForLocation(
        "/skill/brainstorm",
        fromNav({ label: "Sources", path: "/sources" }).state,
      ),
    ).toBe("sources");
    expect(
      sectionForLocation(
        "/skill/brainstorm",
        fromNav({ label: "hermes", path: "/remote/hermes" }).state,
      ),
    ).toBe("remotes");
  });

  it("ignores state that is not a valid referrer", () => {
    expect(
      sectionForLocation("/skill/brainstorm", { backupNow: true }),
    ).toBe("library");
  });
});

describe("navAnchorPath", () => {
  it("keeps the current route when this section can hold a row for it", () => {
    // Library holds skill rows, so a skill opened from a bundle still lights
    // its OWN row in the sibling list.
    expect(
      navAnchorPath(
        "/skill/brainstorm",
        fromNav(bundleBackTarget("android")).state,
      ),
    ).toBe("/skill/brainstorm");
    expect(navAnchorPath("/skill/brainstorm", null)).toBe("/skill/brainstorm");
  });

  it("stands the referrer in when the current route has no row here", () => {
    expect(
      navAnchorPath(
        "/skill/brainstorm",
        fromNav(projectBackTarget("example-app")).state,
      ),
    ).toBe("/project/example-app");
  });
});

describe("shell chrome on a skill opened from a project", () => {
  const projectState = fromNav(projectBackTarget("example-app")).state;

  function renderShell(ui: ReactElement, state?: unknown) {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    return renderWithProviders(ui, {
      client,
      initialRoute: { pathname: "/skill/brainstorm", state },
    });
  }

  it("moves the rail's active pill to Projects", () => {
    renderShell(<IconRail />, projectState);
    expect(screen.getByTitle("Projects")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTitle("Library")).toHaveAttribute(
      "aria-current",
      "false",
    );
  });

  it("leaves the pill on Library without a referrer", () => {
    renderShell(<IconRail />);
    expect(screen.getByTitle("Library")).toHaveAttribute("aria-current", "true");
  });

  it("shows the Projects group in the navigator with that project lit", () => {
    const { container } = renderShell(<NavPanel />, projectState);
    expect(container.querySelector(".side-head-name")?.textContent).toBe(
      GROUP_META.projects.label,
    );
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("example-app");
  });

  it("keeps the Library sibling list — and the skill's own row — when the referrer is a bundle", () => {
    const { container } = renderShell(
      <NavPanel />,
      fromNav(bundleBackTarget("android")).state,
    );
    // The panel header names the GROUP (context), not the section (library).
    expect(container.querySelector(".side-head-name")?.textContent).toBe(
      GROUP_META.context.label,
    );
    const active = container.querySelector('.side-item[data-active="true"]');
    expect(active?.querySelector(".name")?.textContent).toBe("brainstorm");
  });
});

// ─── `.app`'s two group attributes, on a real App mount ─────────────────────
// `data-section` (chrome) already has coverage above via IconRail/NavPanel;
// this proves the two NEW attributes on the actual `.app` element App.tsx
// renders — `data-content-section` never moves with the referrer, and
// `data-context-mix` appears only once chrome and content disagree.

describe("shell chrome: content-section and context-mix (App root)", () => {
  function mockReadRegistry() {
    const mock = vi.mocked(invoke);
    const prev = mock.getMockImplementation();
    mock.mockImplementation(((cmd: string, args?: unknown) =>
      cmd === "read_registry"
        ? Promise.resolve(sampleRegistry)
        : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
  }

  function renderApp() {
    mockReadRegistry();
    const client = makeQueryClient();
    return render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    window.location.hash = "";
  });

  it("mixes the header once a skill is opened from a project", async () => {
    window.location.hash = "#/project/example-app";
    const { container } = renderApp();
    const main = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".app-main");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(await within(main).findByText("brainstorm"));

    const app = await waitFor(() => {
      const el = container.querySelector(".app")!;
      expect(el.getAttribute("data-context-mix")).toBe("true");
      return el;
    });
    // The CONTENT group never follows the referrer — it's the skill's own
    // section (context) even while the CHROME (`data-section`) reads Projects.
    expect(app.getAttribute("data-content-section")).toBe("context");
    expect(app.getAttribute("data-section")).toBe("projects");
  });

  it("carries no context-mix on a skill opened directly from the library", async () => {
    window.location.hash = "#/skill/brainstorm";
    const { container } = renderApp();
    const app = await waitFor(() => {
      const el = container.querySelector(".app");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(app.getAttribute("data-content-section")).toBe("context");
    expect(app.getAttribute("data-section")).toBe("context");
    expect(app.getAttribute("data-context-mix")).toBeNull();
  });
});

// ─── Sources is a SECTION ROOT — a `?focus=` deep link is a real jump, never
// an in-place referrer (see DESIGN-CONTEXT-CHROME/CONTRACT.md).

describe("Sources' automatic back arrow", () => {
  it("renders no back arrow at a ?focus= deep link with no referrer", async () => {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    const { container } = renderWithProviders(<Sources />, {
      client,
      initialRoute: "/sources?focus=android",
    });
    await waitFor(() =>
      expect(container.querySelector(".main-header")).toBeTruthy(),
    );
    expect(container.querySelector(".header-back")).toBeNull();
  });
});

describe("Harnesses' 'used by' project chip", () => {
  it("carries the Harnesses section as the referrer", async () => {
    useAppStore.setState({
      mutating: false,
      harnesses: [
        {
          id: "claude-code",
          label: "Claude Code",
          installed: true,
          on_globally: true,
          used_by_projects: ["example-app"],
        },
      ],
    });
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    renderWithProviders(
      <Routes>
        <Route path="/harnesses" element={<Harnesses />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { client, initialRoute: "/harnesses" },
    );
    fireEvent.click(await screen.findByText("example-app"));
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-app"),
    );
    expect(probeFrom()).toEqual({
      from: { label: "Harnesses", path: "/harnesses" },
    });
  });
});

describe("ScreenHeader: explicit back beats a derived one", () => {
  it("keeps the explicit label/target even with a cross-section referrer in history state", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/skill/brainstorm",
            state: fromNav(projectBackTarget("example-app")).state,
          },
        ]}
      >
        <ScreenHeader
          back={{ label: "X", onClick: () => {} }}
          title="brainstorm"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Back to X" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to example-app" })).toBeNull();
  });
});

describe("GlobalPermissions has no Scope strip", () => {
  // The strip used to jump straight from Global to a project's
  // `?tab=permissions` — a real navigate that dropped the guardrails chrome.
  // The navigator now lists every project's own permissions, so the strip is
  // gone outright rather than made in-place.
  function renderScreen() {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    return renderWithProviders(<GlobalPermissions />, { client });
  }

  it("renders no Permission scope group or scope chips", async () => {
    const { container } = renderScreen();
    await waitFor(() =>
      expect(container.querySelector(".main-header")).toBeTruthy(),
    );
    expect(
      container.querySelector('[aria-label="Permission scope"]'),
    ).toBeNull();
    expect(container.querySelector(".perm-scope-switcher")).toBeNull();
    expect(screen.queryByText("Scope")).toBeNull();
  });
});
