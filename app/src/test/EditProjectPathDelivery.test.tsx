import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { useAppStore } from "@/store";
import { renderWithProviders } from "./helpers";

beforeEach(() => { useAppStore.setState({ mutating: false, toasts: [] }); });

it("reports saved path separately from failed delivery", async () => {
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "pick_directory") return "/new/project";
    if (command === "read_registry") return { projects: { alpha: { path: "/new/project" } } };
    if (command === "sync_report") return { report: {
      generated_at: new Date().toISOString(), ok: false,
      projects: { alpha: { ok: false, errors: [{ stage: "symlink", message: "source missing: guide" }] } },
    } };
    return undefined;
  });
  renderWithProviders(<EditProjectPathDialog open onClose={close} projectName="alpha" currentPath="/old/project" />);
  await userEvent.click(screen.getByText("Browse…"));
  await userEvent.click(screen.getByRole("button", { name: "Update path" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(useAppStore.getState().toasts.some(t => /path saved.*delivery/i.test(t.title))).toBe(true);
  expect(useAppStore.getState().toasts.some(t => /couldn't update path/i.test(t.title))).toBe(false);
});

it("does not attribute another project's delivery failure to the saved path", async () => {
  const close = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "pick_directory") return "/new/project";
    if (command === "read_registry") return { projects: { alpha: { path: "/new/project" } } };
    if (command === "sync_report") return { report: {
      generated_at: new Date().toISOString(), ok: false,
      projects: { alpha: { ok: true, errors: [] }, beta: { ok: false, errors: [] } },
    } };
    return undefined;
  });
  renderWithProviders(<EditProjectPathDialog open onClose={close} projectName="alpha" currentPath="/old/project" />);
  await userEvent.click(screen.getByText("Browse…"));
  await userEvent.click(screen.getByRole("button", { name: "Update path" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(useAppStore.getState().toasts.some(t => t.title === "Updated path for alpha")).toBe(true);
  expect(useAppStore.getState().toasts.some(t => /delivery still has errors/i.test(t.title))).toBe(false);
});
