import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppStore } from "@/store";
import { qk } from "@/lib/queryKeys";
import { TWEAK_DEFAULTS } from "@/lib/tweaks";
import { makeQueryClient, renderWithProviders } from "./helpers";

const strategyInfo = {
  global: "symlink" as const,
  project: null,
  override_value: null,
  effective: "symlink" as const,
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    settingsOpen: false,
    settingsCategory: "appearance",
    tweaks: { ...TWEAK_DEFAULTS },
    harnesses: [],
    harnessesError: null,
    toasts: [],
  });
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "agent_docs_strategy_get") return strategyInfo;
    if (cmd === "harness_list") return [];
    return undefined;
  });
});

describe("SettingsDialog", () => {
  it("opens in the remembered category and keeps appearance preferences live", async () => {
    const client = makeQueryClient();
    useAppStore.setState({ settingsOpen: true, settingsCategory: "appearance" });
    renderWithProviders(<SettingsDialog />, { client });

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show navigator" }));
    expect(useAppStore.getState().tweaks.showNav).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /^Agents$/ }));
    expect((await screen.findAllByText("Agent Docs linking")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /^Appearance$/ }));
    expect(screen.getByRole("checkbox", { name: "Show navigator" })).not.toBeChecked();
  });

  it("keeps a failed Agent Docs choice available for Retry", async () => {
    let writes = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "agent_docs_strategy_get") return strategyInfo;
      if (cmd === "agent_docs_strategy_set") {
        writes += 1;
        if (writes === 1) throw new Error("backend unavailable");
        return { ...strategyInfo, global: "import", effective: "import" };
      }
      if (cmd === "harness_list") return [];
      return undefined;
    });
    const client = makeQueryClient();
    useAppStore.setState({ settingsOpen: true, settingsCategory: "agents" });
    renderWithProviders(<SettingsDialog />, { client });
    await screen.findByRole("dialog", { name: "Settings" });

    const strategy = await screen.findByRole("combobox", { name: "Agent Docs linking" });
    await userEvent.click(strategy);
    await userEvent.click(await screen.findByRole("option", { name: /^Import/ }));
    expect(await screen.findByText(/Couldn't save linking policy/)).toBeInTheDocument();
    expect(screen.getByText("Regular file importing AGENTS.md.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save linking policy");
    expect(screen.getByRole("combobox", { name: "Agent Docs linking" })).toHaveTextContent("Import");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(writes).toBe(2));
    expect(screen.getAllByText(/Use Fix layout/).length).toBeGreaterThan(0);
  });

  it("does not let the tips tour open over Settings", () => {
    useAppStore.setState({ settingsOpen: true, tipsOpen: false });
    useAppStore.getState().openTips();
    expect(useAppStore.getState().tipsOpen).toBe(false);
    useAppStore.getState().closeSettings();
    useAppStore.getState().openTips();
    expect(useAppStore.getState().tipsOpen).toBe(true);
  });

  it("does not open while the tips tour owns the shell", () => {
    renderWithProviders(<SettingsDialog />, { client: makeQueryClient() });
    useAppStore.setState({ tipsOpen: true });
    useAppStore.getState().openSettings();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });
});

it("keeps dismissal blocked until overlapping agent writes both settle", async () => {
  let finishStrategy!: () => void;
  let finishHarness!: () => void;
  const harnesses = [{ id: "codex", label: "Codex", installed: true, on_globally: false, used_by_projects: [] }];
  useAppStore.setState({ settingsOpen: true, settingsCategory: "agents", harnesses });
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "agent_docs_strategy_get") return strategyInfo;
    if (cmd === "harness_list") return harnesses;
    if (cmd === "agent_docs_strategy_set") await new Promise<void>((resolve) => { finishStrategy = resolve; });
    if (cmd === "harness_set_global") await new Promise<void>((resolve) => { finishHarness = resolve; });
    return undefined;
  });
  renderWithProviders(<SettingsDialog />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Agent Docs linking" }));
  await user.click(screen.getByRole("option", { name: /^Import/ }));
  await user.click(screen.getByRole("checkbox", { name: "Enable Codex globally" }));
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await act(async () => finishStrategy());
  await waitFor(() => expect(document.querySelector('.settings-agent-docs [role="combobox"]')).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: "Show navigator" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(useAppStore.getState().settingsOpen).toBe(true);
  await act(async () => finishHarness());
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Show navigator" })).toBeEnabled());
  await user.keyboard("{Escape}");
  expect(useAppStore.getState().settingsOpen).toBe(false);
});

it("does not refetch a retained inactive category", async () => {
  const client = makeQueryClient();
  useAppStore.setState({ settingsOpen: true, settingsCategory: "agents" });
  renderWithProviders(<SettingsDialog />, { client });
  await screen.findByRole("combobox", { name: "Agent Docs linking" });
  await userEvent.click(screen.getByRole("button", { name: "Appearance" }));
  const readCount = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "agent_docs_strategy_get").length;
  const before = readCount();
  await act(async () => { await client.invalidateQueries({ queryKey: qk.agentDocs.strategyAll() }); });
  expect(readCount()).toBe(before);
});
