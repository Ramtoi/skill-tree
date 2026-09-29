import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppStore } from "@/store";
import { qk } from "@/lib/queryKeys";
import { makeQueryClient, renderWithProviders } from "./helpers";

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ settingsOpen: true, settingsCategory: "remotes", degradedMode: false });
});

it("changes publication policy without delivering and preserves it on reopen", async () => {
  const user = userEvent.setup();
  const view = renderWithProviders(<SettingsDialog />);
  const toggle = await screen.findByRole("checkbox", { name: "Publish headless loadouts on Sync" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(vi.mocked(invoke).mock.calls.some(([cmd, payload]) => cmd === "hub_cmd" &&
    (payload as {args:string[]}).args.slice(0,3).join(" ") === "remote delivery run")).toBe(false);
  view.unmount();
  renderWithProviders(<SettingsDialog />);
  expect(await screen.findByRole("checkbox", { name: "Publish headless loadouts on Sync" })).not.toBeChecked();
});

it("delivers only on request and shows successful, paused and blocked machines", async () => {
  localStorage.setItem("st:mock:machines", JSON.stringify({
    ready: { id: "ready", connector: "headless-loadouts", phase: "active", sync_enabled: true },
    paused: { id: "paused", connector: "headless-loadouts", phase: "paused", sync_enabled: false },
    review: { id: "review", connector: "headless-loadouts", phase: "active", sync_enabled: true, delivery: { error: {code:"approval_required",message:"Review new native settings."} } },
  }));
  const user = userEvent.setup();
  const client = makeQueryClient();
  client.setQueryDefaults(qk.machines.show("ready"), { gcTime: Infinity });
  client.setQueryData(qk.machines.show("ready"), { delivery: null });
  renderWithProviders(<SettingsDialog />, { client });
  await user.click(await screen.findByRole("button", { name: "Deliver now to all" }));
  expect(await screen.findByText("Delivered")).toBeInTheDocument();
  await waitFor(() => expect(client.getQueryState(qk.machines.show("ready"))?.isInvalidated).toBe(true));
  expect(screen.getByText("Paused · skipped")).toBeInTheDocument();
  expect(screen.getByText("Needs approval")).toBeInTheDocument();
  expect(screen.getByText("Review new native settings.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Default polling interval for new machines" })).toHaveValue("60");
});

it("keeps the saved switch value when saving fails and offers retry", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
    if (cmd === "hub_cmd" && (payload as {args:string[]}).args.slice(0,3).join(" ") === "remote delivery set" && fail) {
      fail = false;
      throw new Error("Settings are locked.");
    }
    return fallback(cmd, payload);
  });
  const user = userEvent.setup();
  renderWithProviders(<SettingsDialog />);
  const toggle = await screen.findByRole("checkbox", { name: "Publish headless loadouts on Sync" });
  await user.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings are locked.");
  expect(toggle).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Retry delivery action" }));
  await waitFor(() => expect(toggle).not.toBeChecked());
});
