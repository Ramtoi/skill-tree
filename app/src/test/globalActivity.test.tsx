import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, act, waitFor } from "@testing-library/react";
import { invoke as ipcInvoke } from "@/lib/ipc";
import { StatusBar } from "@/components/StatusBar";
import { useAppStore } from "@/store";
import {
  renderWithProviders,
  primeRegistry,
  makeQueryClient,
  deferredInvoke,
} from "./helpers";

beforeEach(() => {
  // The store is a singleton across tests — reset the counter + sync state.
  useAppStore.setState({ inFlight: 0, syncStatus: "idle" });
});

describe("ipc invoke wrapper — in-flight counter", () => {
  it("increments while pending and clears on resolve", async () => {
    const gate = deferredInvoke(() => true);
    expect(useAppStore.getState().inFlight).toBe(0);

    const p = ipcInvoke("hub_cmd", { args: ["enable", "x"] });
    expect(useAppStore.getState().inFlight).toBe(1);

    gate.resolve({ success: true, output: "" });
    await p;
    expect(useAppStore.getState().inFlight).toBe(0);
  });

  it("clears on reject too", async () => {
    const gate = deferredInvoke(() => true);
    const p = ipcInvoke("hub_cmd", { args: ["enable", "x"] });
    expect(useAppStore.getState().inFlight).toBe(1);

    gate.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(useAppStore.getState().inFlight).toBe(0);
  });

  it("counts concurrent calls", async () => {
    const gate = deferredInvoke(() => true);
    const a = ipcInvoke("hub_cmd");
    const b = ipcInvoke("hub_cmd");
    expect(useAppStore.getState().inFlight).toBe(2);
    gate.resolve({ success: true, output: "" });
    await Promise.all([a, b]);
    expect(useAppStore.getState().inFlight).toBe(0);
  });
});

describe("StatusBar global busy indicator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears after a debounce, gains a 5s hint, and clears when idle", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<StatusBar />, { client });

    // Let the mount-time read queries settle back to zero in-flight.
    await waitFor(() => expect(useAppStore.getState().inFlight).toBe(0));
    expect(screen.queryByText(/working…/)).toBeNull();

    vi.useFakeTimers();
    act(() => {
      useAppStore.getState().beginInFlight();
    });
    // Within the 300ms debounce — nothing yet (instant reads don't flicker).
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByText(/working…/)).toBeNull();

    // Past the debounce — the subtle busy segment shows.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText(/working…/)).toBeInTheDocument();
    // Idle sync label is hidden while busy.
    expect(screen.queryByText(/registry · in sync/)).toBeNull();

    // No "still working" hint before 5s.
    expect(screen.queryByText(/still working/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/still working/)).toBeInTheDocument();

    // Draining the counter clears the indicator and restores the idle chip.
    act(() => {
      useAppStore.getState().endInFlight();
    });
    expect(screen.queryByText(/working…/)).toBeNull();
    expect(screen.getByText(/registry · in sync/)).toBeInTheDocument();
  });

  it("defers to the syncing sync-chip rather than the generic indicator", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(<StatusBar />, { client });
    await waitFor(() => expect(useAppStore.getState().inFlight).toBe(0));

    vi.useFakeTimers();
    act(() => {
      useAppStore.setState({ syncStatus: "syncing" });
      useAppStore.getState().beginInFlight();
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // The sync chip owns the syncing view; the generic "working…" stays hidden.
    expect(screen.getByText(/hub sync · writing…/)).toBeInTheDocument();
    expect(screen.queryByText(/^working…/)).toBeNull();

    act(() => {
      useAppStore.getState().endInFlight();
      useAppStore.setState({ syncStatus: "idle" });
    });
  });
});
