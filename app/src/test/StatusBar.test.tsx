import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { StatusBar } from "@/components/StatusBar";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import { renderWithProviders, primeRegistry, makeQueryClient } from "./helpers";

describe("StatusBar", () => {
  it("renders runtime, registry path, counts, version, and palette segments", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<StatusBar />, { client });

    expect(screen.getByText(/registry · in sync/)).toBeInTheDocument();
    expect(screen.getByText("~/skill-hub")).toBeInTheDocument();
    expect(screen.getByText(/tauri 2.0/)).toBeInTheDocument();
    expect(screen.getByText(/⌘K palette/)).toBeInTheDocument();
  });

  it("clicking the palette segment opens the command palette", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<StatusBar />, { client });

    await userEvent.click(screen.getByRole("button", { name: /⌘K palette/ }));
    expect(useAppStore.getState().paletteOpen).toBe(true);
    useAppStore.getState().closePalette();
  });

  it("the registry chip is a sync button that invokes hub sync", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ syncStatus: "idle" });
    vi.mocked(invoke).mockClear();
    renderWithProviders(<StatusBar />, { client });

    const chip = screen.getByTitle("Sync registry to disk");
    await userEvent.click(chip);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("hub_cmd", { args: ["sync"] }),
    );
  });

  it("the sync chip reflects the syncing state with a non-color dot", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    useAppStore.setState({ syncStatus: "syncing" });
    const { container } = renderWithProviders(<StatusBar />, { client });
    const chip = container.querySelector(".sync-chip[data-state='syncing']");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".sync-dot[data-state='syncing']")).not.toBeNull();
    useAppStore.setState({ syncStatus: "idle" });
  });

  it("flips to error state when python check fails", () => {
    const client = makeQueryClient();
    client.setQueryData(["registry"], {
      version: "1",
      hub_path: "~/skill-hub",
      skills: {},
      projects: {},
      bundles: {},
    });
    client.setQueryData(["python"], false);

    const { container } = renderWithProviders(<StatusBar />, { client });
    expect(screen.getByText(/python 3: not found/)).toBeInTheDocument();
    const errSeg = container.querySelector(".status-segment[data-state='error']");
    expect(errSeg).not.toBeNull();
  });

  it("shows the working segment while a process runs, hiding the idle label", () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const id = Processes.start({ title: "Registry sync", body: "writing", kind: "local" });
    try {
      const { container } = renderWithProviders(<StatusBar />, { client });
      expect(container.querySelector(".lds-status-working")).not.toBeNull();
      expect(screen.queryByText(/registry · in sync/)).not.toBeInTheDocument();
    } finally {
      Processes.dismiss(id);
    }
  });

  it("yields to a python error even when a process is running", () => {
    const client = makeQueryClient();
    client.setQueryData(["registry"], {
      version: "1",
      hub_path: "~/skill-hub",
      skills: {},
      projects: {},
      bundles: {},
    });
    client.setQueryData(["python"], false);
    const id = Processes.start({ title: "Registry sync", kind: "local" });
    try {
      const { container } = renderWithProviders(<StatusBar />, { client });
      expect(screen.getByText(/python 3: not found/)).toBeInTheDocument();
      expect(container.querySelector(".lds-status-working")).toBeNull();
    } finally {
      Processes.dismiss(id);
    }
  });
});
