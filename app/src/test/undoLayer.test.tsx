import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ToastContainer } from "@/components/Toast";
import {
  useUndoableAction,
  UNDO_TOAST_DURATION_MS,
  type UndoableAction,
} from "@/hooks/useUndoableAction";
import { BundleManager } from "@/screens/BundleManager";
import { useAppStore } from "@/store";
import { renderWithProviders, makeQueryClient, primeRegistry } from "./helpers";

function Harness({ action }: { action: UndoableAction }) {
  const run = useUndoableAction();
  return (
    <button type="button" onClick={() => void run(action)}>
      go
    </button>
  );
}

/** A tiny in-memory registry the mocked hub_cmd mutates, so undo round-trips
 *  are observable exactly like the real registry-backed verbs. */
function statefulInvoke() {
  const state = {
    enabled: new Set<string>(),
    bundles: new Set<string>(),
    snippets: new Set<string>(["review-checklist"]),
  };
  vi.mocked(invoke).mockImplementation((async (cmd: string, payload?: unknown) => {
    if (cmd === "hub_cmd") {
      const a = (payload as { args?: string[] })?.args ?? [];
      if (a[0] === "enable") state.enabled.add(a[1]);
      else if (a[0] === "disable") state.enabled.delete(a[1]);
      else if (a[0] === "bundle" && a[1] === "apply") state.bundles.add(a[2]);
      else if (a[0] === "bundle" && a[1] === "remove") state.bundles.delete(a[2]);
      else if (a[0] === "snippet" && a[1] === "apply") state.snippets.add(a[2]);
      else if (a[0] === "snippet" && a[1] === "remove") state.snippets.delete(a[2]);
      return { success: true, output: "" };
    }
    return { success: true, output: "" };
  }) as never);
  return state;
}

async function clickUndo() {
  await waitFor(() => expect(screen.getByText("Undo")).toBeInTheDocument());
  await userEvent.click(screen.getByText("Undo"));
}

describe("useUndoableAction — reverts registry state via the inverse verb", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  it("equip → undo removes the skill again", async () => {
    const state = statefulInvoke();
    const client = makeQueryClient();
    const action: UndoableAction = {
      do: () => invoke("hub_cmd", { args: ["enable", "brainstorm", "--project", "p"] }),
      undo: async () => {
        await invoke("hub_cmd", { args: ["disable", "brainstorm", "--project", "p"] });
      },
      label: "Equipped brainstorm on p",
      invalidate: [["registry"]],
    };
    renderWithProviders(
      <>
        <Harness action={action} />
        <ToastContainer />
      </>,
      { client },
    );
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(state.enabled.has("brainstorm")).toBe(true));
    await clickUndo();
    await waitFor(() => expect(state.enabled.has("brainstorm")).toBe(false));
  });

  it("bundle apply → undo removes the bundle", async () => {
    const state = statefulInvoke();
    const client = makeQueryClient();
    const action: UndoableAction = {
      do: () => invoke("hub_cmd", { args: ["bundle", "apply", "android", "--project", "p"] }),
      undo: async () => {
        await invoke("hub_cmd", { args: ["bundle", "remove", "android", "--project", "p"] });
      },
      label: "Applied android to p",
      invalidate: [["registry"]],
    };
    renderWithProviders(
      <>
        <Harness action={action} />
        <ToastContainer />
      </>,
      { client },
    );
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(state.bundles.has("android")).toBe(true));
    await clickUndo();
    await waitFor(() => expect(state.bundles.has("android")).toBe(false));
  });

  it("snippet remove → undo re-applies the snippet", async () => {
    const state = statefulInvoke();
    const client = makeQueryClient();
    const action: UndoableAction = {
      do: () => invoke("hub_cmd", { args: ["snippet", "remove", "review-checklist", "--project", "p"] }),
      undo: async () => {
        await invoke("hub_cmd", { args: ["snippet", "apply", "review-checklist", "--project", "p"] });
      },
      label: "Removed review-checklist",
      invalidate: [["snippets"]],
    };
    renderWithProviders(
      <>
        <Harness action={action} />
        <ToastContainer />
      </>,
      { client },
    );
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(state.snippets.has("review-checklist")).toBe(false));
    await clickUndo();
    await waitFor(() => expect(state.snippets.has("review-checklist")).toBe(true));
  });

  it("gives the undoable success toast the longer 7s duration (B3-13)", async () => {
    const state = statefulInvoke();
    const client = makeQueryClient();
    const action: UndoableAction = {
      do: () => invoke("hub_cmd", { args: ["enable", "brainstorm", "--project", "p"] }),
      undo: async () => {
        await invoke("hub_cmd", { args: ["disable", "brainstorm", "--project", "p"] });
      },
      label: "Equipped brainstorm on p",
      invalidate: [["registry"]],
    };
    renderWithProviders(
      <>
        <Harness action={action} />
        <ToastContainer />
      </>,
      { client },
    );
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(state.enabled.has("brainstorm")).toBe(true));
    const toast = useAppStore
      .getState()
      .toasts.find((t) => t.title === "Equipped brainstorm on p");
    expect(toast?.duration).toBe(UNDO_TOAST_DURATION_MS);
  });

  it("surfaces an error toast when the inverse verb fails", async () => {
    const client = makeQueryClient();
    const action: UndoableAction = {
      do: async () => {},
      undo: async () => {
        throw new Error("boom");
      },
      label: "Did a thing",
      invalidate: [["registry"]],
    };
    renderWithProviders(
      <>
        <Harness action={action} />
        <ToastContainer />
      </>,
      { client },
    );
    await userEvent.click(screen.getByText("go"));
    await clickUndo();
    await waitFor(() =>
      expect(screen.getByText("Couldn't undo")).toBeInTheDocument(),
    );
  });
});

describe("destructive actions keep their ConfirmDialog", () => {
  beforeEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  it("delete-bundle still opens a confirmation (no undo-only path)", async () => {
    const client = makeQueryClient();
    primeRegistry(client);
    renderWithProviders(
      <Routes>
        <Route path="/bundle/:name" element={<BundleManager />} />
      </Routes>,
      { client, initialRoute: "/bundle/android" },
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /Delete bundle…/ }),
    );

    // A confirmation dialog with blast radius appears; nothing is deleted yet.
    await waitFor(() =>
      expect(screen.getByText(/Delete bundle "android"\?/)).toBeInTheDocument(),
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("hub_cmd", {
      args: ["bundle", "delete", "android"],
    });
  });
});
