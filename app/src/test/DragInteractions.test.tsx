import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { BundleManager } from "@/screens/BundleManager";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
  renderWithProviders,
  makeQueryClient,
  primeRegistry,
} from "./helpers";

/**
 * Drag-only persisted mutations (B2-04 equip-via-drop, B2-05 bundle reorder).
 * These edges are reachable ONLY by drag — no button path duplicates the
 * reorder, and the equip drop routes equipped↔available — so a broken
 * `onDrop`/`dataTransfer` handler silently corrupts state with green tests.
 *
 * jsdom has no drag engine, so we hand-roll a `DataTransfer` stub and fire the
 * `dragStart`/`drop` React synthetic events directly; the SAME stub instance is
 * threaded through both so `getData` reads what `setData` wrote — exactly the
 * contract the handlers rely on.
 */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    data: store,
    setData: (k: string, v: string) => {
      store[k] = String(v);
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "all",
    dropEffect: "move",
    types: [] as string[],
    files: [] as File[],
    items: [] as unknown[],
    clearData: () => {},
    setDragImage: () => {},
  };
}

describe("DragInteractions", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  // ── B2-05: Bundle Manager drag-to-reorder ───────────────────────────────────
  it("reordering bundle cards by drag persists the new skills order on save", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/bundle/:name" element={<BundleManager />} />
      </Routes>,
      { client, initialRoute: "/bundle/android" },
    );

    // The android bundle contents render in registry order:
    //   card[0] = rt-android-expert   card[1] = android-compose-ui
    await waitFor(() =>
      expect(container.querySelectorAll(".bundle-skill-card")).toHaveLength(2),
    );
    const cards = container.querySelectorAll<HTMLElement>(".bundle-skill-card");
    const dragEl = (cards[1].querySelector(".resource-card") ??
      cards[1]) as HTMLElement;

    // Drag card[1] onto card[0]'s slot → the two swap.
    const dt = makeDataTransfer();
    fireEvent.dragStart(dragEl, { dataTransfer: dt });
    fireEvent.drop(cards[0], { dataTransfer: dt });

    // Reorder is a persisted mutation; save writes the new `--skills` CSV order.
    await userEvent.click(await screen.findByRole("button", { name: /^Save/ }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
        args: [
          "bundle",
          "update",
          "android",
          "--skills",
          "android-compose-ui,rt-android-expert",
        ],
      }),
    );
  });

  // ── B2-04: Project Workspace drag-to-equip ──────────────────────────────────
  it("dragging an available skill onto the equipped zone equips it (enable invoke)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
      </Routes>,
      { client, initialRoute: "/project/example-app" },
    );

    // fs-mcp is the sole unequipped library skill → it's in the Available panel.
    const availCard = await screen.findByRole("button", { name: "Equip fs-mcp" });
    const equippedZone = document.querySelector(".skill-grid") as HTMLElement;
    expect(equippedZone).not.toBeNull();

    const dt = makeDataTransfer();
    fireEvent.dragStart(availCard, { dataTransfer: dt });
    // Sanity: the card wrote its identity onto the transfer.
    expect(dt.getData("text/skill")).toBe("fs-mcp");
    fireEvent.drop(equippedZone, { dataTransfer: dt });

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", {
        args: ["enable", "fs-mcp", "--project", "example-app"],
      }),
    );
  });

  it("dropping a skill already-equipped-via-bundle onto the equipped zone does not re-enable it", async () => {
    // Guards the equipped↔available routing: handleDrop only enables when the
    // skill isn't already directly enabled. A bundle-provided skill dropped on
    // the equipped zone must not fire a redundant enable.
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <Routes>
        <Route path="/project/:name" element={<ProjectWorkspace />} />
      </Routes>,
      { client, initialRoute: "/project/example-app" },
    );

    const equippedZone = (await waitFor(() => {
      const z = document.querySelector(".skill-grid");
      expect(z).not.toBeNull();
      return z as HTMLElement;
    }))!;

    // brainstorm is directly enabled already; re-dropping it must be a no-op.
    const dt = makeDataTransfer();
    dt.setData("text/skill", "brainstorm");
    fireEvent.drop(equippedZone, { dataTransfer: dt });

    // Give any (erroneous) async enable a chance to fire, then assert it did not.
    await Promise.resolve();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("hub_cmd", {
      args: ["enable", "brainstorm", "--project", "example-app"],
    });
  });
});
