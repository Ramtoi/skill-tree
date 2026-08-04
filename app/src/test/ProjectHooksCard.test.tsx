import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { ProjectHooksCard } from "@/components/ProjectHooksCard";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";

const HOOK_ROW = {
  name: "lint-after-edit",
  provenance: "user" as const,
  event: "PostToolUse",
  command: "eslint --fix",
  description: "",
  tools: [] as string[],
  matcher: "",
  timeout: null,
  harnesses: null,
  settings: {},
  attached_global: false,
  attached_projects: [] as string[],
};

/** Answer `hook_list` with `rows`, chaining to the default impl otherwise.
 *  `fail` names hook_* commands that should resolve `{success:false}` — the
 *  shape hub.py returns for a CLI rejection (the IPC itself still succeeds). */
function mockHookList(
  rows: (typeof HOOK_ROW)[],
  fail: Record<string, string> = {},
) {
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) => {
    if (cmd === "hook_list") return Promise.resolve({ hooks: rows, reach: {} });
    if (fail[cmd]) return Promise.resolve({ success: false, output: fail[cmd] });
    return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
  }) as never);
}

function renderCard() {
  const client = makeQueryClient();
  primeRegistry(client);
  return renderWithProviders(
    <>
      <ProjectHooksCard projectName="example-app" />
      <ToastContainer />
    </>,
    { client },
  );
}

describe("ProjectHooksCard", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  it("renders nothing when the hook library is empty", async () => {
    mockHookList([]);
    const { container } = renderCard();
    // No hooks → the card collapses (discovery lives on /hooks). Give the query
    // a tick to resolve, then assert the group never appears.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_list"),
    );
    expect(
      container.querySelector(".project-hooks-card"),
    ).toBeNull();
  });

  it("attaching from the card invokes hook_attach and surfaces an undo toast", async () => {
    mockHookList([{ ...HOOK_ROW, attached_projects: [] }]);
    renderCard();
    const toggle = await screen.findByLabelText("Attach lint-after-edit");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_attach", {
        name: "lint-after-edit",
        global: false,
        project: "example-app",
      }),
    );
    expect(
      await screen.findByText(/Attached lint-after-edit to example-app/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("detaching an attached hook invokes hook_detach and surfaces an undo toast", async () => {
    mockHookList([{ ...HOOK_ROW, attached_projects: ["example-app"] }]);
    renderCard();
    const toggle = await screen.findByLabelText("Detach lint-after-edit");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_detach", {
        name: "lint-after-edit",
        global: false,
        project: "example-app",
      }),
    );
    expect(
      await screen.findByText(/Detached lint-after-edit from example-app/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  // ── Failure paths ────────────────────────────────────────────────────────
  // The success toast ("Attached X to Y" + Undo) is pushed by the undo layer
  // AFTER `do()` resolves. If the {success:false} branch regresses, the user
  // sees a confident "Attached" toast — and an Undo button — for a hook that
  // was never attached. These pin the honest failure instead.

  it("a rejected attach surfaces an error toast and no false 'Attached' claim", async () => {
    mockHookList([{ ...HOOK_ROW, attached_projects: [] }], {
      hook_attach: "hook 'lint-after-edit' is quarantined",
    });
    renderCard();
    await userEvent.click(await screen.findByLabelText("Attach lint-after-edit"));

    expect(await screen.findByText("Couldn't attach hook")).toBeInTheDocument();
    expect(screen.getByText(/quarantined/)).toBeInTheDocument();
    expect(screen.queryByText(/Attached lint-after-edit to example-app/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(
      useAppStore.getState().toasts.some((t) => t.kind === "success"),
    ).toBe(false);
  });

  it("a rejected detach surfaces an error toast and no false 'Detached' claim", async () => {
    mockHookList([{ ...HOOK_ROW, attached_projects: ["example-app"] }], {
      hook_detach: "hook not attached to example-app",
    });
    renderCard();
    await userEvent.click(await screen.findByLabelText("Detach lint-after-edit"));

    expect(await screen.findByText("Couldn't detach hook")).toBeInTheDocument();
    expect(screen.queryByText(/Detached lint-after-edit from example-app/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
