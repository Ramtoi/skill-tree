import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { HeadlessMachineWizard } from "@/components/remotes/HeadlessMachineWizard";
import { HeadlessMachineDetail } from "@/components/remotes/HeadlessMachineDetail";
import { AddRemoteWizard } from "@/components/remotes/AddRemoteWizard";
import { machineCommand } from "@/lib/headlessMachines";
import { useAppStore } from "@/store";
import { makeQueryClient, primeRegistry, renderWithProviders, sampleRegistry } from "./helpers";

beforeEach(() => { localStorage.clear(); useAppStore.setState({ degradedMode: false }); });
const machineCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd, data]) => cmd === "hub_cmd" &&
  (data as { args: string[] }).args[1] === "machine").map(([, data]) => (data as { args: string[] }).args[2]);

it("selects a separate flow using catalog metadata", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => cmd === "remote_connectors" ? [{
    key: "headless-loadouts", label: "Headless machine", description: "Project receiver", transport_kind: "ssh",
    deployment_kind: "project-loadouts", available: true, publishable: true, source: "builtin",
  }] : fallback(cmd, args));
  const user = userEvent.setup();
  renderWithProviders(<AddRemoteWizard onClose={vi.fn()} onCreated={vi.fn()} />);
  await user.click(await screen.findByText("Headless machine"));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  expect(await screen.findByRole("dialog", { name: "Add a headless machine" })).toBeInTheDocument();
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "remote_add")).toBe(false);
});

it("saves a resumable draft without installation or connection side effects", async () => {
  const user = userEvent.setup();
  const created = vi.fn();
  renderWithProviders(<HeadlessMachineWizard onClose={vi.fn()} onBack={vi.fn()} onCreated={created} />);
  await user.type(screen.getByRole("textbox", { name: "Machine id" }), "build-box");
  await user.type(screen.getByRole("textbox", { name: "SSH host or alias" }), "build-box");
  await user.click(screen.getByRole("button", { name: "Save machine draft" }));
  await waitFor(() => expect(created).toHaveBeenCalledWith("build-box"));
  expect(machineCalls()).toEqual(["draft"]);
  const saved = await machineCommand("show", ["build-box"]);
  expect(saved.phase).toBe("draft");
  expect(saved.sync_enabled).toBe(false);
});

it("reopens saved setup without live probes or Hermes calls and requires preview before start", async () => {
  await machineCommand("draft", ["build-box", "--settings-json", JSON.stringify({ ssh_host: "build-box" })]);
  await machineCommand("connect", ["build-box"]);
  await machineCommand("install", ["build-box"]);
  await machineCommand("configure", ["build-box"]);
  await machineCommand("bind", ["build-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  vi.mocked(invoke).mockClear();
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="build-box" onBack={vi.fn()} />, { client });
  expect(await screen.findByText("Confirmed project checkouts")).toBeInTheDocument();
  expect(machineCalls()).toEqual(["show"]);
  expect(screen.queryByRole("button", { name: "Apply and start periodic delivery" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Preview latest loadouts" }));
  expect(await screen.findByText("Saved delivery preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply and start periodic delivery" })).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => ["remote_diff", "remote_list_docs", "remote_import_scan", "remote_sync"].includes(cmd))).toBe(false);
  expect(screen.queryByText("Skills on this remote")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply and start periodic delivery" }));
  expect(await screen.findByRole("button", { name: "Deliver now" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pause delivery" }));
  expect(await screen.findByRole("button", { name: "Resume delivery" })).toBeInTheDocument();
});

it("keeps failed connection setup open with retry and back navigation", async () => {
  await machineCommand("draft", ["box-a", "--settings-json", JSON.stringify({ ssh_host: "box-a", host_key_sha256: "SHA256:test" })]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "connect") return { success: true, output: JSON.stringify({ ok: false, result: null, error: { message: "SSH authentication failed." } }) };
    return fallback(cmd, args);
  });
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="box-a" onBack={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Test connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("SSH authentication failed.");
  expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Back to Remotes" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Install receiver" })).toBeDisabled();
});


it("requires approval after showing the native configuration values", async () => {
  await machineCommand("draft", ["native-box", "--settings-json", JSON.stringify({ ssh_host: "native-box" })]);
  await machineCommand("connect", ["native-box"]);
  await machineCommand("install", ["native-box"]);
  await machineCommand("configure", ["native-box"]);
  await machineCommand("bind", ["native-box", "--binding", "app", "--project", "app", "--harness", "claude-code", "--global-native", "permissions", "--manual"]);
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="native-box" onBack={vi.fn()} />, { client });
  await user.click(await screen.findByRole("button", { name: "Preview latest loadouts" }));
  expect(await screen.findByRole("button", { name: "Apply and start periodic delivery" })).toBeDisabled();
  await user.click(screen.getByText("Review native configuration and scripts"));
  expect(screen.getAllByText(/Bash\(rm:\*\)/)[0]).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh receiver status" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve these native and shared changes" })).toBeDisabled());
  await user.click(screen.getByRole("button", { name: "Preview latest loadouts" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve these native and shared changes" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Approve these native and shared changes" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply and start periodic delivery" })).toBeEnabled());
});


it("preserves unfinished feed and checkout input after testing the connection", async () => {
  await machineCommand("draft", ["draft-box", "--settings-json", JSON.stringify({ ssh_host: "draft-box", host_key_sha256: "SHA256:test" })]);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="draft-box" onBack={vi.fn()} />);
  await user.type(await screen.findByLabelText("Private Git feed URL"), "https://github.com/team/backup.git");
  await user.type(screen.getByLabelText("Remote checkout path"), "/home/me/project");
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Install receiver" })).toBeEnabled());
  expect(screen.getByLabelText("Private Git feed URL")).toHaveValue("https://github.com/team/backup.git");
  expect(screen.getByLabelText("Remote checkout path")).toHaveValue("/home/me/project");
});


it("requires a deliberate provider selection before confirming a checkout", async () => {
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => cmd === "read_registry" ? sampleRegistry : fallback(cmd, args));
  await machineCommand("draft", ["provider-box", "--settings-json", JSON.stringify({ ssh_host: "provider-box" })]);
  await machineCommand("connect", ["provider-box"]);
  await machineCommand("install", ["provider-box"]);
  await machineCommand("configure", ["provider-box"]);
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="provider-box" onBack={vi.fn()} />, { client });
  await screen.findByRole("option", { name: "example-app" });
  await user.selectOptions(screen.getByLabelText("Source project"), "example-app");
  await user.type(screen.getByLabelText("Remote checkout path"), "/home/me/project");
  await user.click(screen.getByRole("checkbox", { name: "Confirm this path manually without repository matching." }));
  expect(screen.getByRole("checkbox", { name: "codex" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm checkout mapping" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "codex" }));
  expect(screen.getByRole("button", { name: "Confirm checkout mapping" })).toBeEnabled();
});

it("shows invocation limitations without blocking a ready delivery", async () => {
  await machineCommand("draft", ["parity-box", "--settings-json", JSON.stringify({ ssh_host: "parity-box" })]);
  await machineCommand("connect", ["parity-box"]);
  await machineCommand("install", ["parity-box"]);
  await machineCommand("configure", ["parity-box"]);
  await machineCommand("bind", ["parity-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  await machineCommand("preview", ["parity-box"]);
  const machine = await machineCommand("show", ["parity-box"]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "show") return { success: true, output: JSON.stringify({ ok: true, result: {
      ...machine, delivery: { state: "published_waiting_for_receiver",
        native_limitations: [{ area: "permissions", harness: "codex", name: "project", message: "Rule omitted.", risk: "dropped_deny_or_ask" }],
        invocation_total: 1, invocation: [{
        binding: "app", skill: "example", harness: "codex", support: "unsupported",
        limitations: ["Explicit invocation remains available."],
      }] },
    } }) };
    return fallback(cmd, args);
  });
  const client = makeQueryClient(); primeRegistry(client);
  renderWithProviders(<HeadlessMachineDetail id="parity-box" onBack={() => {}} />, { client });
  await userEvent.click(await screen.findByText(/Provider limitations ·/));
  expect(screen.getByLabelText("Provider limitations")).toHaveTextContent("Explicit invocation remains available.");
  expect(screen.getByLabelText("Native configuration limitations")).toHaveTextContent("Rule omitted.");
  expect(screen.getByLabelText("Native configuration limitations")).toHaveTextContent("dropped_deny_or_ask");
  expect(screen.getByRole("button", { name: "Apply and start periodic delivery" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});


it("preserves failed batch mappings after another mapping succeeds", async () => {
  await machineCommand("draft", ["discovery-box", "--settings-json", JSON.stringify({ ssh_host: "discovery-box" })]);
  for (const action of ["connect", "install", "configure"]) await machineCommand(action, ["discovery-box"]);
  const machine = await machineCommand("show", ["discovery-box"]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let rejectSecond = true;
  const binds: string[][] = [];
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "discover") {
      expect(argv).not.toContain("--root");
      return { success: true, output: JSON.stringify({ ok: true, result: { ...machine, result: {
        candidates: ["first", "second"].map(name => ({ path: `/srv/repos/${name}`, matches: [{
          source_project: name, source_remote: "upstream", destination_remote: "origin", checkout_path: `/srv/repos/${name}`,
        }] })), partial: true,
      } } }) };
    }
    if (cmd === "hub_cmd" && argv?.[2] === "bind") {
      binds.push(argv);
      const failed = rejectSecond && argv.includes("second");
      if (!failed) return fallback(cmd, args);
      return { success: false, output: JSON.stringify({ ok: false, result: null,
        error: { message: "Second checkout moved." } }) };
    }
    return fallback(cmd, args);
  });
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="discovery-box" onBack={vi.fn()} />, { client });
  await user.click(await screen.findByRole("button", { name: "Find project checkouts" }));
  await user.click(await screen.findByRole("checkbox", { name: /srv\/repos\/first/ }));
  await user.click(screen.getByRole("checkbox", { name: /srv\/repos\/second/ }));
  await user.click(screen.getByRole("checkbox", { name: "codex" }));
  await user.click(screen.getByRole("button", { name: "Confirm selected mappings (2)" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm selected mappings (1)" })).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: /srv\/repos\/first/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /srv\/repos\/second/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /srv\/repos\/second/ })).toBeVisible();
  expect(screen.getByText(/Second checkout moved/)).toBeInTheDocument();
  expect(binds[0]).toEqual(expect.arrayContaining(["--source-remote", "upstream", "--harness", "codex"]));
  rejectSecond = false;
  await user.click(screen.getByRole("button", { name: "Confirm selected mappings (1)" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm selected mappings (0)" })).toBeDisabled());
  expect(binds).toHaveLength(3);
  expect(binds[2]).toContain("second");
});

it("refreshes saved delivery status after a failed preview", async () => {
  await machineCommand("draft", ["retry-box", "--settings-json", JSON.stringify({ ssh_host: "retry-box" })]);
  await machineCommand("connect", ["retry-box"]);
  await machineCommand("install", ["retry-box"]);
  await machineCommand("configure", ["retry-box"]);
  await machineCommand("bind", ["retry-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let failed = false;
  const message = "Hook 'resume-example' uses a machine-local path. Convert it to a managed script in Hooks, then preview again.";
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "preview") {
      failed = true;
      return { success: true, output: JSON.stringify({ ok: false, result: null, error: { message } }) };
    }
    const response = await fallback(cmd, args);
    if (failed && cmd === "hub_cmd" && argv?.[2] === "show") {
      const wrapper = response as { output: string };
      const data = JSON.parse(wrapper.output);
      data.result.delivery = { state: "native_unportable_path", error: { message } };
      return { ...wrapper, output: JSON.stringify(data) };
    }
    return response;
  });
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="retry-box" onBack={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Preview latest loadouts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getAllByText(`Error: ${message}`)).toHaveLength(1);
  expect(screen.getByText("native unportable path")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Preview latest loadouts" })).toBeEnabled();
});

it("edits active polling without writing until Save interval and preserves delivery", async () => {
  await machineCommand("draft", ["poll-box", "--settings-json", JSON.stringify({ ssh_host: "poll-box" })]);
  for (const verb of ["connect", "install", "configure", "preview", "start"]) await machineCommand(verb, ["poll-box"]);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="poll-box" onBack={vi.fn()} />);
  const input = await screen.findByLabelText("Polling interval in seconds");
  expect(input).toBeEnabled();
  vi.mocked(invoke).mockClear();
  await user.clear(input);
  await user.type(input, "120");
  expect(machineCalls()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Save interval" }));
  await waitFor(() => expect(machineCalls()).toContain("interval"));
  const saved = await machineCommand("show", ["poll-box"]);
  expect(saved.draft?.input.poll_interval_seconds).toBe(120);
  expect(saved.sync_enabled).toBe(true);
  expect(saved.draft?.observations.preview?.plan_digest).toBe("mock-reviewed-plan");
  expect(screen.getByRole("button", { name: "Save interval" })).toBeDisabled();
});

it("puts a saved receiver block ahead of ready and enabled labels", async () => {
  await machineCommand("draft", ["blocked-box", "--settings-json", JSON.stringify({ ssh_host: "blocked-box" })]);
  for (const verb of ["connect", "install", "configure", "bind", "preview", "start"]) {
    const args = verb === "bind" ? ["blocked-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"] : ["blocked-box"];
    await machineCommand(verb, args);
  }
  const machines = JSON.parse(localStorage.getItem("st:mock:machines")!);
  machines["blocked-box"].phase = "ready";
  machines["blocked-box"].sync_enabled = true;
  machines["blocked-box"].delivery = {
    state: "ownership_conflict",
    published: { revision: "a".repeat(40), generation: 1 },
    applied: null,
    observed_at: "2026-09-28T14:01:01Z",
    error: { code: "ownership_conflict", message: "The receiver blocked delivery. Preview the loadout to review its blockers." },
  };
  localStorage.setItem("st:mock:machines", JSON.stringify(machines));

  renderWithProviders(<HeadlessMachineDetail id="blocked-box" onBack={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "Delivery blocked" })).toBeVisible();
  expect(screen.getByText("The receiver blocked delivery. Preview the loadout to review its blockers.")).toBeVisible();
  expect(screen.queryByText("Delivery active")).not.toBeInTheDocument();
  expect(screen.queryByText("ready", { exact: true })).not.toBeInTheDocument();
});

it("shows fresh inspection blockers above a saved ready preview and recovers through Preview", async () => {
  await machineCommand("draft", ["inspection-box", "--settings-json", JSON.stringify({ ssh_host: "inspection-box" })]);
  for (const verb of ["connect", "install", "configure"]) await machineCommand(verb, ["inspection-box"]);
  await machineCommand("bind", ["inspection-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  await machineCommand("preview", ["inspection-box"]);
  const machines = JSON.parse(localStorage.getItem("st:mock:machines")!);
  machines["inspection-box"].phase = "ready";
  machines["inspection-box"].sync_enabled = true;
  machines["inspection-box"].delivery = {
    state: "applied", published: { revision: "a".repeat(40), generation: 1 }, applied: { revision: "a".repeat(40), generation: 1 },
    observed_at: "2026-09-28T14:00:00Z", error: { code: "ownership_conflict", message: "The last delivery attempt was blocked." },
  };
  localStorage.setItem("st:mock:machines", JSON.stringify(machines));
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="inspection-box" onBack={vi.fn()} />);

  await user.click(await screen.findByRole("button", { name: "Refresh receiver status" }));
  expect(await screen.findByRole("heading", { name: "Delivery blocked" })).toBeVisible();
  expect((await screen.findAllByText(/Remote edits are preserved at/))[0]).toBeVisible();
  expect(await screen.findByText(/Current receiver inspection/)).toBeVisible();
  expect(screen.getByText(/Receiver responded at/)).toBeVisible();
  expect(screen.getByText(/Candidate: aaaaaaaaaaaa · generation 1/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Deliver now" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Preview latest loadouts" }));
  expect(await screen.findByRole("heading", { name: "Delivery confirmed" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Delivery blocked" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deliver now" })).toBeEnabled();
});

it("validates polling drafts and retains a failed save for retry", async () => {
  await machineCommand("draft", ["retry-box", "--settings-json", JSON.stringify({ ssh_host: "retry-box" })]);
  for (const verb of ["connect", "install", "configure", "preview", "start"]) await machineCommand(verb, ["retry-box"]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "hub_cmd" && (args as { args: string[] }).args[2] === "interval" && fail)
      return { success: true, output: JSON.stringify({ ok: false, error: { message: "Receiver unavailable. Retry." } }) };
    return fallback(cmd, args);
  });
  const user = userEvent.setup();
  const client = makeQueryClient(); primeRegistry(client);
  renderWithProviders(<HeadlessMachineDetail id="retry-box" onBack={vi.fn()} />, { client });
  const input = await screen.findByLabelText("Polling interval in seconds");
  for (const value of ["", "29", "3601", "60.5"]) {
    await user.clear(input);
    if (value) await user.type(input, value);
    expect(screen.getByRole("button", { name: "Save interval" })).toBeDisabled();
  }
  await user.clear(input); await user.type(input, "120");
  await user.click(screen.getByRole("button", { name: "Save interval" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Receiver unavailable");
  expect(input).toHaveValue("120");
  expect(screen.getByRole("button", { name: "Save interval" })).toBeEnabled();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Save interval" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save interval" })).toBeDisabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reopens an incomplete timer update with a retry draft and no active claim", async () => {
  await machineCommand("draft", ["partial-box", "--settings-json", JSON.stringify({ ssh_host: "partial-box" })]);
  for (const verb of ["connect", "install", "configure", "preview", "start"]) await machineCommand(verb, ["partial-box"]);
  const machines = JSON.parse(localStorage.getItem("st:mock:machines")!);
  machines["partial-box"].draft.observations.interval_update = {
    requested_interval: 120, state: "timer_pending", message: "Timer update incomplete. Retry Save interval.",
  };
  localStorage.setItem("st:mock:machines", JSON.stringify(machines));
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="partial-box" onBack={vi.fn()} />, { client });
  expect(await screen.findByLabelText("Polling interval in seconds")).toHaveValue("120");
  expect(screen.queryByText("Active", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Delivery needs attention" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save interval" }));
  expect(await screen.findByRole("heading", { name: "Delivery confirmed" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Save interval" })).toBeDisabled();
});

it("shows a channel conflict panel and reconnects with this Mac's identity", async () => {
  await machineCommand("draft", ["conflict-box", "--settings-json", JSON.stringify({ ssh_host: "conflict-box" })]);
  await machineCommand("connect", ["conflict-box"]);
  await machineCommand("install", ["conflict-box"]);
  const machines = JSON.parse(localStorage.getItem("st:mock:machines")!);
  machines["conflict-box"].draft.observations.channel_conflict = {
    feed_id: "a".repeat(32), publisher_key_id: "SHA256:0123abcd0123abcd", controller_key_id: "SHA256:deadbeefdeadbeef",
    applied: { generation: 4, applied_at: "2026-09-20T12:00:00Z" },
  };
  localStorage.setItem("st:mock:machines", JSON.stringify(machines));
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="conflict-box" onBack={vi.fn()} />, { client });
  expect(await screen.findByText("This receiver already delivers loadouts for another Skill Tree installation.")).toBeInTheDocument();
  expect(screen.getByText("SHA256:0123abcd0123abcd")).toBeInTheDocument();
  expect(screen.getByText("SHA256:deadbeefdeadbeef")).toBeInTheDocument();
  expect(screen.getByText(/generation 4/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Private Git feed URL"), "git@example.org:team/loadouts.git");
  await user.click(screen.getByRole("checkbox", { name: "I configured private repository access for this Mac and receiver." }));
  vi.mocked(invoke).mockClear();
  await user.click(screen.getByRole("button", { name: "Reconnect receiver" }));
  await waitFor(() => expect(machineCalls()).toContain("configure"));
  const configureCall = vi.mocked(invoke).mock.calls.find(([cmd, data]) => cmd === "hub_cmd" &&
    (data as { args: string[] }).args[2] === "configure")?.[1] as { args: string[] };
  expect(configureCall.args).toEqual(expect.arrayContaining(["conflict-box", "--replace-channel"]));
  const draftCall = vi.mocked(invoke).mock.calls.find(([cmd, data]) => cmd === "hub_cmd" &&
    (data as { args: string[] }).args[2] === "draft")?.[1] as { args: string[] };
  expect(draftCall.args.join(" ")).toContain("git@example.org:team/loadouts.git");
  await waitFor(() => expect(screen.queryByText("This receiver already delivers loadouts for another Skill Tree installation.")).not.toBeInTheDocument());
});

it("persists a channel conflict observed from a failed configure and reconnects", async () => {
  await machineCommand("draft", ["locked-box", "--settings-json", JSON.stringify({ ssh_host: "locked-box" })]);
  await machineCommand("connect", ["locked-box"]);
  await machineCommand("install", ["locked-box"]);
  const message = "The receiver already delivers loadouts for another Skill Tree installation. Reconnect it to replace that channel with this Mac's identity.";
  const conflict = { feed_id: "a".repeat(32), publisher_key_id: "SHA256:0123abcd0123abcd", controller_key_id: "SHA256:deadbeefdeadbeef",
    applied: { generation: 4, applied_at: "2026-09-20T12:00:00Z" } };
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "configure" && !argv.includes("--replace-channel")) {
      // Simulate the controller persisting the conflict it observed so the next `show` reflects it.
      const machines = JSON.parse(localStorage.getItem("st:mock:machines")!);
      machines["locked-box"].draft.observations.channel_conflict = conflict;
      localStorage.setItem("st:mock:machines", JSON.stringify(machines));
      return { success: true, output: JSON.stringify({ ok: false, result: null, error: { code: "channel_rotation_required", message } }) };
    }
    return fallback(cmd, args);
  });
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="locked-box" onBack={vi.fn()} />, { client });
  await user.type(await screen.findByLabelText("Private Git feed URL"), "git@example.org:team/loadouts.git");
  await user.click(screen.getByRole("checkbox", { name: "I configured private repository access for this Mac and receiver." }));
  await user.click(screen.getByRole("button", { name: "Configure receiver" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getByText("This receiver already delivers loadouts for another Skill Tree installation.")).toBeInTheDocument();
  expect(screen.getByText("SHA256:0123abcd0123abcd")).toBeInTheDocument();
  expect(screen.getByText("SHA256:deadbeefdeadbeef")).toBeInTheDocument();
  vi.mocked(invoke).mockClear();
  await user.click(screen.getByRole("button", { name: "Reconnect receiver" }));
  await waitFor(() => expect(machineCalls()).toContain("configure"));
  const configureCall = vi.mocked(invoke).mock.calls.find(([cmd, data]) => cmd === "hub_cmd" &&
    (data as { args: string[] }).args[2] === "configure")?.[1] as { args: string[] };
  expect(configureCall.args).toEqual(expect.arrayContaining(["locked-box", "--replace-channel"]));
});

it("shows the feed-branch reconnect panel when preview reports feed_reconnect_required on a configured machine", async () => {
  await machineCommand("draft", ["reconnect-box", "--settings-json", JSON.stringify({ ssh_host: "reconnect-box",
    feed_url: "git@example.org:team/loadouts.git", private_feed_confirmed: true })]);
  for (const verb of ["connect", "install", "configure"]) await machineCommand(verb, ["reconnect-box"]);
  await machineCommand("bind", ["reconnect-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  const message = "The feed branch head was published by another Skill Tree installation. Reconnect the receiver to publish from this Mac.";
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd" && argv?.[2] === "preview") return { success: true, output: JSON.stringify({ ok: false, result: null,
      error: { code: "feed_reconnect_required", message } }) };
    return fallback(cmd, args);
  });
  const client = makeQueryClient(); primeRegistry(client);
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="reconnect-box" onBack={vi.fn()} />, { client });
  await user.click(await screen.findByRole("button", { name: "Preview latest loadouts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getByText("The feed branch was published by another Skill Tree installation.")).toBeInTheDocument();
  vi.mocked(invoke).mockClear();
  await user.click(screen.getByRole("button", { name: "Reconnect receiver" }));
  await waitFor(() => expect(machineCalls()).toContain("configure"));
  const configureCall = vi.mocked(invoke).mock.calls.find(([cmd, data]) => cmd === "hub_cmd" &&
    (data as { args: string[] }).args[2] === "configure")?.[1] as { args: string[] };
  expect(configureCall.args).toEqual(expect.arrayContaining(["reconnect-box", "--replace-channel"]));
});

it("keeps Resume delivery available when a mapping change needs a new preview", async () => {
  await machineCommand("draft", ["resume-box", "--settings-json", JSON.stringify({ ssh_host: "resume-box" })]);
  for (const verb of ["connect", "install", "configure"]) await machineCommand(verb, ["resume-box"]);
  await machineCommand("bind", ["resume-box", "--binding", "app", "--project", "app", "--harness", "codex", "--manual"]);
  for (const verb of ["preview", "start", "pause"]) await machineCommand(verb, ["resume-box"]);
  const fallback = vi.mocked(invoke).getMockImplementation()!;
  const calls: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const argv = (args as { args?: string[] })?.args;
    if (cmd === "hub_cmd") calls.push(argv?.[2] || "");
    const response = await fallback(cmd, args);
    if (cmd === "hub_cmd" && argv?.[2] === "show") {
      const wrapper = response as { output: string };
      const data = JSON.parse(wrapper.output);
      data.result.phase = "bound";
      data.result.draft.phase = "bound";
      data.result.draft.observations.start = { applied: {} };
      if (!calls.includes("preview")) delete data.result.draft.observations.preview;
      return { ...wrapper, output: JSON.stringify(data) };
    }
    return response;
  });
  const user = userEvent.setup();
  renderWithProviders(<HeadlessMachineDetail id="resume-box" onBack={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Resume delivery" }));
  expect(calls).toContain("preview");
  expect(calls).not.toContain("start");
});
