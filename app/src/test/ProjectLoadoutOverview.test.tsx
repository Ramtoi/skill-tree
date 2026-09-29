import { ProjectOverviewBand } from "@/screens/project/ProjectOverviewBand";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { ProjectHookAttachments } from "@/screens/project/ProjectHooksSheet";
import { useLoadoutOrderStore } from "@/hooks/useProjectLoadoutOrder";
import { useAppStore } from "@/store";
import { orderStorageKey } from "@/lib/projectLoadoutOrder";
import { backReturnOptions, useBackTarget } from "@/lib/backTarget";
import { invoke } from "@tauri-apps/api/core";
import {
  makeQueryClient,
  primeRegistry,
  renderWithProviders,
  sampleRegistry,
} from "./helpers";
import { qk } from "@/lib/queryKeys";

beforeEach(() => {
  localStorage.clear();
  useLoadoutOrderStore.setState({ values: {}, edits: {} });
  useAppStore.setState({ toasts: [] });
});

// A throwing `Storage.prototype.setItem` spy restored only at the end of an
// `it()` body leaks into later tests if an earlier assertion throws
// (TA-1-d9f4 / R7).
afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const registry = structuredClone(sampleRegistry);
  registry.bundles = {
    first: {
      description: "",
      icon: "",
      skills: ["brainstorm", "fs-mcp"],
      playbook: [{ id: "a", title: "Plan", skills: ["brainstorm", "fs-mcp"] }],
    },
    second: {
      description: "",
      icon: "",
      skills: ["brainstorm", "fs-mcp"],
      playbook: [{ id: "b", title: "Build", skills: ["brainstorm", "fs-mcp"] }],
    },
  };
  registry.projects["example-app"].bundles = ["first", "second"];
  const client = makeQueryClient();
  primeRegistry(client, registry);
  function Detail() {
    const back = useBackTarget({ path: "/", label: "Library" });
    const nav = useNavigate();
    return (
      <button onClick={() => nav(back.path, backReturnOptions(back))}>
        Back to project
      </button>
    );
  }
  function Location() {
    return <output data-testid="route">{useLocation().pathname}</output>;
  }
  const result = renderWithProviders(
    <>
      <Location />
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
        <Route path="/skill/:name" element={<Detail />} />
      </Routes>
    </>,
    { client, initialRoute: "/project/example-app" },
  );
  return { ...result, registry };
}
it("starts with context, links every occurrence on hover and keyboard focus, and keeps unique totals", async () => {
  const { container } = setup();
  expect(
    screen.getByRole("region", { name: "Context estimate" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByPlaceholderText("Filter library…"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "1 skills · 1 MCPs" }),
  ).toBeInTheDocument();
  const rows = container.querySelectorAll<HTMLElement>(
    '[data-member="brainstorm"]',
  );
  expect(rows).toHaveLength(2);
  fireEvent.pointerEnter(rows[0].parentElement!);
  expect([...rows].every((row) => row.dataset.sharedHighlight === "true")).toBe(
    true,
  );
  fireEvent.pointerLeave(rows[0].parentElement!);
  expect([...rows].every((row) => !row.dataset.sharedHighlight)).toBe(true);
  act(() => rows[1].focus());
  expect([...rows].every((row) => row.dataset.sharedHighlight === "true")).toBe(
    true,
  );
  act(() => rows[1].blur());
  expect([...rows].every((row) => !row.dataset.sharedHighlight)).toBe(true);
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command, payload]) =>
            command === "hub_cmd" &&
            JSON.stringify(payload).includes('"mcp","show","fs-mcp"'),
        ),
    ).toHaveLength(1),
  );
});
it("moves complete sections, persists locally, filters collapsed members and restores filters from an editor", async () => {
  const { registry, container } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Move Build up" }));
  expect(container.querySelector(".loadout-section-toggle")).toHaveTextContent(
    "Build",
  );
  expect(
    localStorage.getItem(
      orderStorageKey(registry.projects["example-app"].path),
    ),
  ).toContain('"second"');
  const mutation = vi
    .mocked(invoke)
    .mock.calls.filter(
      ([command, payload]) =>
        command === "hub_cmd" &&
        /"bundle","update"/.test(JSON.stringify(payload)),
    );
  expect(mutation).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Build" }));
  fireEvent.change(screen.getByPlaceholderText("Find in loadout…"), {
    target: { value: "brainstorm" },
  });
  expect(screen.getAllByRole("button", { name: "brainstorm" })).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Move Build down" }),
  ).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "brainstorm" })[0]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to project" }),
  );
  expect(await screen.findByPlaceholderText("Find in loadout…")).toHaveValue(
    "brainstorm",
  );
  expect(container.querySelector(".loadout-section-toggle")).toHaveTextContent(
    "Build",
  );
});
it("keeps the current arrangement when local storage fails and reports it", () => {
  const { container } = setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  fireEvent.click(screen.getByRole("button", { name: "Move Build up" }));
  expect(container.querySelector(".loadout-section-toggle")).toHaveTextContent(
    "Build",
  );
  expect(
    useAppStore
      .getState()
      .toasts.some((toast) => toast.title === "Layout kept for this session"),
  ).toBe(true);
  vi.restoreAllMocks();
});
it("locks global-only hooks, keeps dual inheritance after local detach and sends project scope only", async () => {
  const client = makeQueryClient();
  const hook = {
    event: "Stop",
    command: "true",
    description: "",
    tools: [],
    matcher: "",
    timeout: null,
    harnesses: null,
    settings: {},
    provenance: "user" as const,
  };
  client.setQueryData(qk.hooks.list(), {
    hooks: [
      { ...hook, name: "global", attached_global: true, attached_projects: [] },
      {
        ...hook,
        name: "dual",
        attached_global: true,
        attached_projects: ["example-app"],
      },
    ],
  });
  renderWithProviders(
    <ProjectHookAttachments projectName="example-app" navigate={vi.fn()} />,
    { client },
  );
  expect(
    screen.getByRole("checkbox", { name: "Inherited global" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Detach dual" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "hook_detach",
      expect.objectContaining({
        name: "dual",
        project: "example-app",
        global: false,
      }),
    ),
  );
});

it("undoes a section move against refreshed membership and reset follows current bundle order", async () => {
  const { registry, client, container } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Move Build up" }));
  const undo = useAppStore
    .getState()
    .toasts.find(
      (toast) => toast.title === "Section order saved on this machine",
    )?.action;
  expect(undo).toBeDefined();
  const changed = structuredClone(registry);
  changed.bundles.first.playbook = [
    { id: "new", title: "New section", skills: ["brainstorm", "fs-mcp"] },
  ];
  act(() => client.setQueryData(qk.registry(), changed));
  expect(container.querySelector(".loadout-section-toggle")).toHaveTextContent(
    "Build",
  );
  await screen.findByRole("button", { name: "New section" });
  act(() => undo!.onClick());
  await waitFor(() =>
    expect(
      container.querySelector(".loadout-section-toggle"),
    ).toHaveTextContent("New section"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move Build up" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
  expect(
    localStorage.getItem(
      orderStorageKey(registry.projects["example-app"].path),
    ),
  ).toBeNull();
  expect(container.querySelector(".loadout-section-toggle")).toHaveTextContent(
    "New section",
  );
});

it("preserves the prior hook attachment on failure, blocks duplicate writes and retries", async () => {
  const client = makeQueryClient();
  const hook = {
    name: "local",
    event: "Stop",
    command: "true",
    description: "",
    tools: [],
    matcher: "",
    timeout: null,
    harnesses: null,
    settings: {},
    provenance: "user" as const,
    attached_global: false,
    attached_projects: ["example-app"],
  };
  client.setQueryData(qk.hooks.list(), { hooks: [hook] });
  const original = vi.mocked(invoke).getMockImplementation()!;
  let fail!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "hook_detach"
      ? new Promise((resolve) => {
          fail = resolve;
        })
      : command === "hook_list"
        ? (Promise.resolve({ hooks: [hook], reach: {} }) as ReturnType<
            typeof invoke
          >)
        : original(command, args),
  );
  renderWithProviders(
    <ProjectHookAttachments projectName="example-app" navigate={vi.fn()} />,
    { client },
  );
  const toggle = screen.getByRole("checkbox", { name: "Detach local" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(toggle).toBeDisabled();
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "hook_detach"),
    ).toHaveLength(1),
  );
  await act(async () => fail({ success: false, output: "controlled failure" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Attachment unchanged");
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry local" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "hook_detach"),
    ).toHaveLength(2),
  );
  await act(async () => fail({ success: false, output: "controlled failure" }));
  vi.mocked(invoke).mockImplementation(original);
});

it("keeps shared unresolved entries visible and linked without inventing an editor target", async () => {
  const { registry, client, container } = setup();
  const updated = structuredClone(registry);
  for (const bundle of Object.values(updated.bundles)) {
    bundle.skills.push("missing-member");
    bundle.playbook![0].skills.push("missing-member");
  }
  act(() => client.setQueryData(qk.registry(), updated));
  await waitFor(() =>
    expect(
      container.querySelectorAll('[data-member="missing-member"]'),
    ).toHaveLength(2),
  );
  const rows = container.querySelectorAll<HTMLElement>(
    '[data-member="missing-member"]',
  );
  expect(rows).toHaveLength(2);
  act(() => rows[0].focus());
  expect([...rows].every((row) => row.dataset.sharedHighlight === "true")).toBe(
    true,
  );
  expect(
    screen.getByRole("button", { name: "1 skills · 1 MCPs · 1 missing" }),
  ).toBeInTheDocument();
  fireEvent.click(rows[0]);
  expect(screen.getByTestId("route")).toHaveTextContent("/project/example-app");
});

it("shows a globally inherited bundle once while keeping its explicit project removal reachable", () => {
  const registry = structuredClone(sampleRegistry);
  registry.bundles.shared = {
    description: "",
    icon: "",
    scope: "global",
    skills: ["brainstorm"],
  };
  const proj = { ...registry.projects["example-app"], bundles: ["shared"] };
  const remove = vi.fn();
  renderWithProviders(
    <ProjectOverviewBand
      projectName="example-app"
      proj={proj}
      registry={registry}
      globalBundles={[["shared", registry.bundles.shared]]}
      availableBundles={[]}
      onApplyBundle={vi.fn()}
      onRemoveBundle={remove}
    />,
  );
  expect(screen.getAllByText("shared", { exact: true })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: /Active bundles/ })).toHaveTextContent("Active bundles1");
  fireEvent.click(
    screen.getByTitle(
      "Remove project attachment of shared; remains globally applied",
    ),
  );
  expect(remove).toHaveBeenCalledWith("shared");
});
