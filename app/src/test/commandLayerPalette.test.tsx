import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { CommandPalette } from "@/components/CommandPalette";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";

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
