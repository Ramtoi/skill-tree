import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { CommandPalette } from "@/components/CommandPalette";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";

/** One hook-library row (mirrors the HookRow JSON from `hook_list`). */
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

/** Make the mocked `invoke` answer `hook_list` with `row`, chaining otherwise. */
function mockHookList(row: typeof HOOK_ROW) {
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) =>
    cmd === "hook_list"
      ? Promise.resolve({ hooks: [row], reach: {} })
      : prev
        ? prev(cmd as never, args as never)
        : Promise.resolve(undefined)) as never);
}

function openPalette() {
  act(() => useAppStore.getState().openPalette());
}

async function paletteInput() {
  await waitFor(() =>
    expect(document.querySelector(".palette input")).not.toBeNull(),
  );
  return document.querySelector(".palette input") as HTMLInputElement;
}

describe("CommandPalette stage machine + verbs", () => {
  beforeEach(() => {
    useAppStore.getState().closePalette();
    useAppStore.getState().setSyncStatus("idle");
    useAppStore.setState({ toasts: [] });
  });

  it("equip-skill runs only after skill AND project are picked (breadcrumb + verb)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Equip skill");
    await userEvent.click(screen.getByText("Equip skill…"));

    // Stage 1: skill. Breadcrumb shows the verb + first stage title.
    const crumbs = () => document.querySelector(".palette-crumbs")?.textContent ?? "";
    expect(crumbs()).toContain("Equip skill");
    expect(crumbs()).toContain("Pick a skill");

    await userEvent.click(screen.getByText("brainstorm"));
    // Stage 2: project. Breadcrumb carries the picked skill.
    expect(crumbs()).toContain("brainstorm");
    expect(crumbs()).toContain("Pick a project");

    await userEvent.click(screen.getByText("example-app"));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
        args: ["enable", "brainstorm", "--project", "example-app"],
      }),
    );
    // Palette closes after the terminal action.
    await waitFor(() => expect(document.querySelector(".palette")).toBeNull());
  });

  it("Esc clears a non-empty search first, then pops one stage", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Equip skill");
    await userEvent.click(screen.getByText("Equip skill…"));
    await userEvent.click(screen.getByText("brainstorm"));
    // Now on the project stage.
    expect(document.querySelector(".palette-crumbs")?.textContent).toContain(
      "Pick a project",
    );

    // Type a filter, first Esc clears it (stage unchanged, palette open).
    await userEvent.type(input, "zzz");
    expect((input as HTMLInputElement).value).toBe("zzz");
    await userEvent.keyboard("{Escape}");
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.querySelector(".palette-crumbs")?.textContent).toContain(
      "Pick a project",
    );

    // Second Esc pops back to the skill stage (not root, not closed).
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".palette")).not.toBeNull();
    expect(document.querySelector(".palette-crumbs")?.textContent).toContain(
      "Pick a skill",
    );
  });

  it("new-snippet rejects an invalid slug and accepts a valid one", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "New snippet");
    await userEvent.click(screen.getByText("New snippet…"));
    expect(document.querySelector(".palette-text-stage")).not.toBeNull();

    // Invalid slug — Enter does not advance (palette stays on the text stage).
    await userEvent.type(input, "Bad Name");
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector(".palette-text-stage")).not.toBeNull();

    // Valid slug — Enter routes to the snippet create flow and closes.
    await userEvent.clear(input);
    await userEvent.type(input, "my-snippet");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector(".palette")).toBeNull());
  });

  it("Detach hook… detaches from an attached scope and surfaces an undo toast", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    mockHookList({ ...HOOK_ROW, attached_projects: ["example-app"] });
    renderWithProviders(
      <>
        <CommandPalette />
        <ToastContainer />
      </>,
      { client },
    );
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Detach hook");
    await userEvent.click(screen.getByText("Detach hook…"));

    // Stage 1: pick the hook (loaded from hook_list).
    await userEvent.click(await screen.findByText("lint-after-edit"));
    // Stage 2: only the attached project scope is offered.
    await userEvent.click(await screen.findByText("example-app"));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_detach", {
        name: "lint-after-edit",
        global: false,
        project: "example-app",
      }),
    );
    // Reversible edge → an undo toast with a working Undo action.
    expect(await screen.findByText(/Detached lint-after-edit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("Attach hook… at global scope surfaces a machine-wide consequence confirm", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    mockHookList({ ...HOOK_ROW, attached_projects: [] });
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Attach hook");
    await userEvent.click(screen.getByText("Attach hook…"));
    await userEvent.click(await screen.findByText("lint-after-edit"));
    // Choose the global scope → the palette must NOT attach immediately.
    await userEvent.click(await screen.findByText(/Global — all sessions/));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "hook_attach",
      expect.anything(),
    );

    // A ConfirmDialog states the machine-wide consequence.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      /all sessions of that harness on this machine/,
    );

    // Confirming commits the global attach.
    await userEvent.click(
      screen.getByRole("button", { name: "Attach globally" }),
    );
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_attach", {
        name: "lint-after-edit",
        global: true,
        project: null,
      }),
    );
  });

  it("Attach hook… at a PROJECT scope attaches directly (no machine-wide confirm)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    mockHookList({ ...HOOK_ROW, attached_projects: [] });
    renderWithProviders(
      <>
        <CommandPalette />
        <ToastContainer />
      </>,
      { client },
    );
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Attach hook");
    await userEvent.click(screen.getByText("Attach hook…"));
    await userEvent.click(await screen.findByText("lint-after-edit"));
    await userEvent.click(await screen.findByText("example-app"));

    // A project attach is scoped to one directory — it must NOT gate behind the
    // machine-wide consequence dialog.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hook_attach", {
        name: "lint-after-edit",
        global: false,
        project: "example-app",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByText(/Attached lint-after-edit to example-app/),
    ).toBeInTheDocument();
  });

  it("Cancelling the machine-wide confirm attaches nothing", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    mockHookList({ ...HOOK_ROW, attached_projects: [] });
    renderWithProviders(
      <>
        <CommandPalette />
        <ToastContainer />
      </>,
      { client },
    );
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Attach hook");
    await userEvent.click(screen.getByText("Attach hook…"));
    await userEvent.click(await screen.findByText("lint-after-edit"));
    await userEvent.click(await screen.findByText(/Global — all sessions/));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Backing out is the guard against arming a command in EVERY directory.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "hook_attach",
      expect.anything(),
    );
    expect(screen.queryByText(/Attached lint-after-edit/)).toBeNull();
  });

  it("Detach hook… offers no scopes for an unattached hook (and detaches nothing)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    mockHookList({ ...HOOK_ROW, attached_global: false, attached_projects: [] });
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Detach hook");
    await userEvent.click(screen.getByText("Detach hook…"));
    await userEvent.click(await screen.findByText("lint-after-edit"));

    // The scope stage is reached but empty — nothing to detach from, so no
    // "Global" / project option may be offered (offering one would emit a CLI
    // error for a scope the hook was never attached to).
    await waitFor(() =>
      expect(document.querySelector(".palette-crumbs")?.textContent).toContain(
        "Detach from where",
      ),
    );
    expect(screen.queryByText(/Global — all sessions/)).toBeNull();
    expect(screen.queryByText("example-app")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "hook_detach",
      expect.anything(),
    );
  });

  it("Sync action routes through the shared useRunSync flow", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderWithProviders(<CommandPalette />, { client });
    openPalette();
    const input = await paletteInput();

    await userEvent.type(input, "Sync registry");
    await userEvent.click(screen.getByText("Sync registry to agent folders"));

    // Exactly one sync dispatch, and BOTH invalidations (the shared flow).
    await waitFor(() => {
      const syncCalls = vi
        .mocked(invoke)
        .mock.calls.filter(
          ([cmd, payload]) =>
            cmd === "hub_cmd" &&
            (payload as { args?: string[] })?.args?.[0] === "sync",
        );
      expect(syncCalls.length).toBe(1);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["registry"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["syncReport"] });
    });
    invalidateSpy.mockRestore();
  });
});
