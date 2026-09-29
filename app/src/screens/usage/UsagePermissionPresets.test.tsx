import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePermissionPresets } from "./UsagePermissionPresets";
import { makeDeferred, renderWithProviders, sampleRegistry } from "@/test/helpers";
import { invoke } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { NormalizedPermissions } from "@/types/permissions";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));
vi.mock("@/hooks/useMcpCatalog", () => ({ useMcpCatalog: () => ({ data: { ok: true, catalog: { tools: [{ name: "read_file", title: null, description: null, parameters: [], schema_unreadable: false, parameters_truncated: false }] } }, isLoading: false, isError: false, refetch: vi.fn() }) }));

let stored: NormalizedPermissions;
let registry: typeof sampleRegistry;
let readPermissions: () => unknown;
let readRegistry: () => unknown;
let validation: { ok: boolean; error?: string };
let writeError: boolean;
let syncRc: number;
let writeGate: ReturnType<typeof makeDeferred> | null;
let afterWrite: () => void;
let validationGate: ReturnType<typeof makeDeferred> | null;
const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "permissions_set");

beforeEach(() => {
  stored = { allow: [{ kind: "allow", pattern: "Bash(git status)", harnesses: ["claude-code"] }], deny: [], ask: [], hooks: [], sandbox_mode: "workspace-write", approval_policy: "on-request", project_trust: null, additional_dirs: ["/example/work"], extras: {}, _unmanaged: [] };
  registry = { ...sampleRegistry, skills: { calendar: { ...sampleRegistry.skills.brainstorm, type: "mcp-server" } } };
  readPermissions = () => structuredClone(stored);
  readRegistry = () => registry;
  validation = { ok: true };
  writeError = false;
  syncRc = 0;
  writeGate = null;
  validationGate = null;
  afterWrite = () => {};
  useAppStore.setState({ toasts: [] });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_registry") return readRegistry();
    if (command === "permissions_show") return readPermissions();
    if (command === "permissions_capabilities") return { "claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"] };
    if (command === "permissions_validate") return validationGate ? validationGate.promise : validation;
    if (command === "permissions_set") {
      if (writeGate) await writeGate.promise;
      if (writeError) throw new Error("Permission file is unavailable");
      stored = { ...(args?.payload as NormalizedPermissions), hooks: [] };
      afterWrite();
      return { changed: true, normalized: structuredClone(stored), sync_rc: syncRc };
    }
    throw new Error(`Unexpected command ${command}`);
  });
});

async function openPreset(ready = true) {
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP permissions" }));
  const dialog = await screen.findByRole("dialog", { name: "Add MCP permissions" });
  if (ready) await within(dialog).findByRole("combobox", { name: "All tools permission" });
  return dialog;
}
function choose(target: string, decision: string) {
  fireEvent.click(screen.getByRole("combobox", { name: `${target} permission` }));
  fireEvent.click(screen.getByRole("option", { name: decision }));
}
function save() { fireEvent.click(screen.getByRole("button", { name: "Save permissions" })); }
async function closed() { await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add MCP permissions" })).not.toBeInTheDocument()); }

describe("Usage permission presets", () => {
  it("returns focus to Add when Escape closes the presets dropdown", async () => {
    renderWithProviders(<UsagePermissionPresets />);
    const add = screen.getByRole("button", { name: "Add" });
    fireEvent.click(add);
    const action = await screen.findByRole("button", { name: "MCP permissions" });
    fireEvent.keyDown(action, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add permission presets" })).not.toBeInTheDocument());
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("reads lazily and saves Global rules while preserving settings and unrelated affinity", async () => {
    renderWithProviders(<UsagePermissionPresets />);
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "permissions_show")).toBe(false);
    await openPreset();
    expect(screen.getByText("Global", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Permissions draft/)).not.toBeInTheDocument();
    choose("All tools", "Ask");
    choose("read_file", "Deny");
    save();
    await closed();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toMatchObject({ scope: { kind: "global" }, personal: false, payload: { allow: [{ kind: "allow", pattern: "Bash(git status)", harnesses: ["claude-code"] }], ask: [{ kind: "ask", pattern: "mcp__calendar" }], deny: [{ kind: "deny", pattern: "mcp__calendar__read_file" }], sandbox_mode: "workspace-write", additional_dirs: ["/example/work"] } });
    await openPreset();
    expect(screen.getByRole("combobox", { name: "All tools permission" })).toHaveTextContent("Ask");
  });

  it("keeps a validation rejection staged and retries without writing invalid rules", async () => {
    validation = { ok: false, error: "Rule rejected by validator" };
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(); choose("All tools", "Ask"); save();
    await screen.findByText("Rule rejected by validator");
    expect(writes()).toHaveLength(0);
    expect(screen.getByTestId("mcp-permission-staged")).toHaveTextContent("Ask");
    validation = { ok: true }; save(); await closed();
    expect(stored.ask[0].pattern).toBe("mcp__calendar");
  });

  it("discards a failed save on Cancel before saving a different decision", async () => {
    writeError = true;
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(); choose("All tools", "Ask"); save();
    await screen.findByText(/Permission file is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await closed();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toHaveFocus());
    writeError = false;
    await openPreset();
    expect(screen.getByRole("combobox", { name: "All tools permission" })).toHaveTextContent("Default");
    expect(screen.queryByText(/Permission file is unavailable/)).not.toBeInTheDocument();
    choose("read_file", "Deny"); save(); await closed();
    expect(stored.ask).toEqual([]);
    expect(stored.deny.map(r => r.pattern)).toEqual(["mcp__calendar__read_file"]);
  });

  it("closes after a committed save even when its refresh does not finish", async () => {
    afterWrite = () => { readPermissions = () => new Promise(() => {}); };
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(); choose("All tools", "Ask"); save(); await closed();
    expect(stored.ask[0].pattern).toBe("mcp__calendar");
  });

  it("retains failed selections for a successful write retry", async () => {
    writeError = true;
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(); choose("All tools", "Ask"); save();
    await screen.findByText(/Permission file is unavailable/);
    expect(screen.getByTestId("mcp-permission-staged")).toHaveTextContent("Ask");
    writeError = false; save(); await closed();
    expect(writes()).toHaveLength(2);
    expect(stored.ask[0].pattern).toBe("mcp__calendar");
  });

  it("awaits a fresh read on reopen even while cached data is fresh", async () => {
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const currentRead = makeDeferred();
    stored.deny.push({ kind: "deny", pattern: "Bash(rm *)" });
    readPermissions = () => currentRead.promise;
    await openPreset(false);
    expect(screen.queryByRole("combobox", { name: "All tools permission" })).not.toBeInTheDocument();
    await act(async () => { currentRead.resolve(structuredClone(stored)); });
    await screen.findByRole("combobox", { name: "All tools permission" });
    choose("All tools", "Ask"); save(); await closed();
    expect(stored.deny.map(r => r.pattern)).toContain("Bash(rm *)");
  });

  it("recovers a failed Global read through Retry", async () => {
    readPermissions = () => Promise.reject(new Error("Cannot read Global rules"));
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(false);
    await screen.findByText(/Cannot read Global rules/);
    expect(screen.queryByRole("combobox", { name: "All tools permission" })).not.toBeInTheDocument();
    readPermissions = () => structuredClone(stored);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("combobox", { name: "All tools permission" });
  });

  it("blocks adoption with a route to Global Permissions", async () => {
    readPermissions = () => ({ ...stored, adoption_required: { "claude-code": [{ kind: "ask", pattern: "mcp__calendar" }] } });
    renderWithProviders(<UsagePermissionPresets />);
    await openPreset(false);
    expect(await screen.findByRole("link", { name: "Open Global Permissions" })).toHaveAttribute("href", "#/permissions");
    expect(screen.queryByRole("combobox", { name: "All tools permission" })).not.toBeInTheDocument();
  });

  it("distinguishes registry loading, errors, and an empty registry", async () => {
    const gate = makeDeferred(); readRegistry = () => gate.promise;
    renderWithProviders(<UsagePermissionPresets />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/Reading registered MCP/)).toBeInTheDocument();
    expect(screen.queryByText(/No registered/)).not.toBeInTheDocument();
    await act(async () => { gate.reject(new Error("Registry unavailable")); });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MCP permissions" })).not.toBeInTheDocument();
    registry = { ...registry, skills: {} }; readRegistry = () => registry;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Open Library" })).toHaveAttribute("href", "#/");
  });

  for (const phase of ["validation", "write"] as const) {
    it(`blocks dismissal during ${phase}`, async () => {
      const gate = makeDeferred();
      if (phase === "validation") validationGate = gate; else writeGate = gate;
      renderWithProviders(<UsagePermissionPresets />);
      const dialog = await openPreset(); choose("All tools", "Ask"); save();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(dialog).toBeInTheDocument();
      await act(async () => { gate.resolve({ ok: true }); });
      await closed();
    });
  }

  for (const rc of [1, 2]) {
    it(`reports Sync ${rc} as saved with attention after the sheet closes`, async () => {
      syncRc = rc;
      renderWithProviders(<UsagePermissionPresets />);
      await openPreset(); choose("All tools", "Ask"); save(); await closed();
      await waitFor(() => expect(useAppStore.getState().toasts.some(t => /saved.*sync/i.test(`${t.title} ${t.body ?? ""}`))).toBe(true));
      expect(stored.ask[0].pattern).toBe("mcp__calendar");
    });
  }
});
