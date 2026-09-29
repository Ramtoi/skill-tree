import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useLocation } from "react-router-dom";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppStore } from "@/store";
import { parseRemoteDefaults, parseRemotePollInterval } from "@/lib/remoteDefaults";
import { makeQueryClient, renderWithProviders } from "./helpers";

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ settingsOpen: true, settingsCategory: "remotes", degradedMode: false });
});

describe("remote defaults contract", () => {
  it("accepts the backend default and rejects invalid local values", () => {
    expect(parseRemoteDefaults(JSON.stringify({
      ok: true, configured: false, defaults: { poll_interval_seconds: 60 }, error: null,
    })).defaults?.poll_interval_seconds).toBe(60);
    expect(parseRemotePollInterval("29")).toBeUndefined();
    expect(parseRemotePollInterval("3601")).toBeUndefined();
    expect(parseRemotePollInterval("60.5")).toBeUndefined();
  });

  it("shows a backend validation failure instead of falling back to 60", async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "hub_cmd" && (args as { args: string[] }).args[1] === "defaults") {
        return { success: true, output: JSON.stringify({
          ok: false, configured: true, defaults: null,
          error: { code: "invalid_remote_defaults", field: "poll_interval_seconds", message: "Hand-edited defaults are invalid." },
        }) };
      }
      return fallback(cmd, args);
    });
    renderWithProviders(<SettingsDialog />, { client: makeQueryClient() });

    expect(await screen.findByRole("alert")).toHaveTextContent("Hand-edited defaults are invalid.");
    expect(screen.queryByRole("textbox", { name: "Default polling interval for new machines" })).not.toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Publish headless loadouts on Sync" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deliver now to all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage machines" })).toBeEnabled();
  });

  it("keeps an unsaved draft across categories and saves only the future default", async () => {
    const user = userEvent.setup();
    renderWithProviders(<><SettingsDialog /><LocationProbe /></>);
    const input = await screen.findByRole("textbox", { name: "Default polling interval for new machines" });
    await user.clear(input);
    await user.type(input, "120");
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    await user.click(screen.getByRole("button", { name: /^Remotes/ }));
    expect(screen.getByRole("textbox", { name: "Default polling interval for new machines" })).toHaveValue("120");

    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByText(/Remote defaults saved for future machines/)).toBeInTheDocument();
    const write = vi.mocked(invoke).mock.calls.find(([cmd, args]) => cmd === "hub_cmd" &&
      (args as { args: string[] }).args.slice(0, 4).join(" ") === "remote defaults set --poll-interval-seconds");
    expect((write?.[1] as { args: string[] }).args).toEqual([
      "remote", "defaults", "set", "--poll-interval-seconds", "120", "--json",
    ]);
  });

  it("retains a failed save for retry and routes Manage machines through the dialog", async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    let failed = true;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "hub_cmd" && (args as { args: string[] }).args[0] === "remote" &&
        (args as { args: string[] }).args[2] === "set" && failed) {
        failed = false;
        throw new Error("offline");
      }
      return fallback(cmd, args);
    });
    const user = userEvent.setup();
    renderWithProviders(<><SettingsDialog /><LocationProbe /></>);
    const input = await screen.findByRole("textbox", { name: "Default polling interval for new machines" });
    await user.clear(input);
    await user.type(input, "90");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("textbox", { name: "Default polling interval for new machines" })).toHaveValue("90");
    await user.click(screen.getByRole("button", { name: "Retry save defaults" }));
    await waitFor(() => expect(screen.getByText(/Remote defaults saved for future machines/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Manage machines" }));
    expect(useAppStore.getState().settingsOpen).toBe(false);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/remotes"));
  });
});
