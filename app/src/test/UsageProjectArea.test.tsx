import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { qk } from "@/lib/queryKeys";
import { localAgentUsageQueryKey } from "@/features/usage/useLocalAgentUsage";
import { UsageProjectArea } from "@/screens/usage/UsageProjectArea";
import { UsageProjectRoute } from "@/screens/usage/UsageProjectRoute";
import { ProjectUsageTab } from "@/screens/project/ProjectUsageTab";
import { backReturnOptions, useBackTarget, usageBackTarget } from "@/lib/backTarget";
import { ScanButton } from "@/screens/usage/UsageScanAction";
import type {
  UsageOutcomes,
  UsageProjectPayload,
  UsageScanResult,
  UsageLoadoutRow,
  UsageTimelinePayload,
} from "@/features/usage/usageAnalyticsTypes";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { Processes } from "@/store/processes";

function outcomes(overrides: Partial<UsageOutcomes> = {}): UsageOutcomes {
  return {
    sessions: 4,
    tokens_per_session: 12000,
    cache_hit_ratio: 0.5,
    steering_per_session: 2.5,
    subagent_token_share: 0.1,
    activity: { read: 3, edit: 2, verify: 1, operate: 0, delegate: 0, skill: 0, external: 0 },
    thinking_text_share: 0.2,
    files_read_median: 6,
    files_edited_median: 2,
    verified_edit_session_ratio: 0.75,
    editing_sessions: 3,
    unverified_editing_sessions: 1,
    tracked_files: 40,
    median_all_projects: { activity: { read: 1, edit: 1, verify: 0, operate: 0, delegate: 0, skill: 0, external: 0 } },
    ...overrides,
  };
}

function projectPayload(overrides: Partial<UsageProjectPayload> = {}): UsageProjectPayload {
  return {
    ok: true,
    project: "alpha",
    window: 30,
    findings_window: 30,
    last_scan_at: "2026-09-06T12:00:00Z",
    harnesses: ["claude-code"],
    footprint: {
      "claude-code": {
        observed: 5_120,
        parts: [{ part: "skills", label: "Skills", text: "…", bytes: 5_120 }],
        unknown: [],
        bytes_total: 5_120,
        approx_tokens: 1_280,
      },
    },
    utilization: [
      { key: "brainstorm", count: 4, you: 3, model: 1, script: 0, last_used_at: "2026-09-05T10:00:00Z", trail: [], footprint_bytes: 100, harnesses: ["claude-code"], sessions_with_skill: 4, idle: false },
      { key: "unused-skill", count: 0, you: 0, model: 0, script: 0, last_used_at: null, trail: [], footprint_bytes: 0, harnesses: [], sessions_with_skill: 0, idle: false },
    ],
    subagents: [],
    outcomes: outcomes(),
    findings: [
      {
        id: "f1",
        kind: "footprint",
        project: "alpha",
        observation: "Skill descriptions dominate the prompt.",
        numbers: { bytes: 5_120, share: 1 },
        moves: [{ label: "Trim the skill description", kind: "trim", targets: ["brainstorm"] }],
        review: { area: "footprint", project: "alpha", highlight: [] },
      },
    ],
    sessions: [
      { session_id: "s1", harness: "claude-code", started_at: "2026-09-06T09:00:00Z", tokens_total: 12_000, cache_hit_ratio: 0.4, steering_count: 3, loadout_assumed: false, analysed: true },
    ],
    not_analysed: [],
    ...overrides,
  };
}

function scanResult(overrides: Partial<UsageScanResult> = {}): UsageScanResult {
  return {
    ok: true,
    rows_written: 5,
    rows_frozen: 0,
    frozen_appended: 0,
    files_scanned: 5,
    files_skipped: 0,
    bytes_read: 1_000,
    sessions_unregistered: 0,
    stopped_on: null,
    errors: [],
    malformed_rows_dropped: 0,
    last_scan_at: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

function timelinePayload(overrides: Partial<UsageTimelinePayload> = {}): UsageTimelinePayload {
  return {
    schema_version: 1, since: null, until: null,
    harnesses: [{ id: "claude-code", name: "Claude Code" }],
    days: [{ date: "2026-09-06", skills: { brainstorm: 2 }, tools: { Bash: 1 } }],
    peaks: { unit: "tokens", grid: Array.from({ length: 7 }, () => Array(24).fill(0)) },
    ...overrides,
  };
}

/** Mocks `hub_cmd` so `usage project` returns `payload` and `usage
 *  scan-sessions` returns `scan` — every other verb (unused here) falls
 *  through to a minimal ok:true default. */
function mockHubCmd(payload: UsageProjectPayload, scan: UsageScanResult = scanResult(), rows: UsageLoadoutRow[] = [], timeline: UsageTimelinePayload | Error = timelinePayload()) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_registry") return sampleRegistry;
    if (cmd === "hub_cmd") {
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "project") {
        return { success: true, output: JSON.stringify(payload) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "scan-sessions") {
        return { success: true, output: JSON.stringify(scan) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "loadouts") {
        return { success: true, output: JSON.stringify({ ok: true, project: "alpha", rows }) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "timeline") {
        if (timeline instanceof Error) throw timeline;
        return { success: true, output: JSON.stringify(timeline) };
      }
      return { success: true, output: "" };
    }
    return undefined;
  });
}

function baseProps(overrides: Partial<{ onWindowChange: () => void; onOpenSession: () => void }> = {}) {
  return {
    name: "alpha",
    window: 30 as const,
    onWindowChange: overrides.onWindowChange ?? vi.fn(),
    onOpenSession: overrides.onOpenSession ?? vi.fn(),
  };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function EditorReturnProbe() {
  const back = useBackTarget(usageBackTarget());
  const navigate = useNavigate();
  return <>
    <LocationProbe />
    <button onClick={() => navigate(back.path, backReturnOptions(back))}>Return to usage</button>
    <button onClick={() => navigate(-1)}>History back</button>
  </>;
}

describe("UsageProjectArea", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    for (const process of Processes.list()) Processes.dismiss(process.id);
  });

  it("links only exact current registry names, including idle skills", async () => {
    const row = projectPayload().utilization[0];
    mockHubCmd(projectPayload({ utilization: [
      { ...row, key: "brainstorm", count: 0 },
      { ...row, key: "Brainstorm" },
      { ...row, key: "constructor" },
      { ...row, key: "removed-skill" },
    ] }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    const band = await screen.findByRole("region", { name: "Utilization" });
    expect(await within(band).findByRole("link", { name: "brainstorm" })).toHaveAttribute("href", "/skill/brainstorm");
    expect(within(band).getAllByRole("link")).toHaveLength(1);
    for (const name of ["Brainstorm", "constructor", "removed-skill"]) {
      expect(within(band).getByText(name)).toBeVisible();
    }
  });

  it.each([
    ["/project/alpha?tab=usage", "mouse", "Return to usage"],
    ["/usage/project/alpha", "keyboard", "Return to usage"],
    ["/project/alpha?tab=usage", "keyboard", "History back"],
    ["/usage/project/alpha", "mouse", "History back"],
  ])("returns to %s with its controls after %s navigation via %s", async (route, input, returnAction) => {
    localStorage.removeItem("st:usage:window");
    const row = projectPayload().utilization[0];
    mockHubCmd(projectPayload({
      harnesses: ["claude-code", "codex"],
      utilization: [row, ...Array.from({ length: 8 }, (_, i) => ({ ...row, key: `old-${i}`, count: 10 + i }))],
    }));
    renderWithProviders(<Routes>
      <Route path="/project/:name" element={<ProjectUsageTab projectName="alpha" navigator={<nav />} />} />
      <Route path="/usage/project/:name" element={<UsageProjectRoute />} />
      <Route path="/skill/:name" element={<EditorReturnProbe />} />
    </Routes>, { initialRoute: route });
    await screen.findByRole("region", { name: "Utilization" });
    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Show all 9 skills" }));
    const band = screen.getByRole("region", { name: "Utilization" });
    const before = within(band).getAllByRole("listitem").map((item) => item.textContent);
    const link = within(band).getByRole("link", { name: "brainstorm" });
    if (input === "keyboard") {
      link.focus();
      await userEvent.keyboard("{Enter}");
    } else {
      await userEvent.click(link);
    }
    expect(await screen.findByTestId("location")).toHaveTextContent("/skill/brainstorm");
    if (returnAction === "Return to usage") localStorage.setItem("st:usage:window", "90");
    await userEvent.click(screen.getByRole("button", { name: returnAction }));
    expect(await screen.findByRole("radio", { name: "7 days" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Codex" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("region", { name: "Utilization" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(before);
    expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "usage_scan_ccusage" ||
      (args as { args?: string[] })?.args?.includes("scan-sessions"))).toBe(false);
  });

  it("orders mixed harness sessions by recency before rendering", async () => {
    const base = projectPayload().sessions[0];
    mockHubCmd(projectPayload({
      harnesses: ["claude-code", "codex"],
      sessions: [
        { ...base, session_id: "older-claude", tokens_total: 111, started_at: "2026-09-01T09:00:00Z" },
        { ...base, session_id: "newer-codex", tokens_total: 222, harness: "codex", started_at: "2026-09-06T09:00:00Z" },
      ],
    }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    const band = await screen.findByRole("region", { name: "Sessions" });
    const rows = within(band).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("222");
    expect(rows[1]).toHaveTextContent("111");
  });

  it("expands missing metadata honestly and preserves ledger context and navigation", async () => {
    const row = { ...projectPayload().sessions[0], loadout_assumed: true };
    mockHubCmd(projectPayload({ sessions: [row] }));
    const onOpenSession = vi.fn();
    renderWithProviders(<UsageProjectArea {...baseProps({ onOpenSession })} />);
    const item = await screen.findByTestId("usage-session-row");
    expect(item).toHaveTextContent("Token breakdown unavailable");
    expect(item).not.toHaveTextContent("$0.00");
    await userEvent.click(item);
    expect(within(item).getByText("Steering turns")).toBeVisible();
    expect(within(item).getByText("40%")).toBeVisible();
    expect(within(item).getByText("current loadout assumed")).toBeVisible();
    await userEvent.click(within(item).getByRole("button", { name: "Inspect session" }));
    expect(onOpenSession).toHaveBeenCalledWith("s1", "claude-code");
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "usage_scan_ccusage")).toBe(false);
    expect(vi.mocked(invoke).mock.calls.some(([, args]) => ["scan-sessions", "inspect", "session"].includes((args as { args?: string[] })?.args?.[1] ?? ""))).toBe(false);
  });

  it("uses cached details, keeps paths hidden, filters harnesses, and opens the supported timeline", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const row = projectPayload().sessions[0];
    mockHubCmd(projectPayload({ harnesses: ["claude-code", "codex"], sessions: [
      { ...row, session_id: id }, { ...row, session_id: "codex", harness: "codex" },
    ] }));
    const client = makeQueryClient();
    client.setQueryDefaults(localAgentUsageQueryKey, { staleTime: Infinity, gcTime: Infinity });
    client.setQueryData(localAgentUsageQueryKey, { source: "cache", scan: null, snapshot: { sessions: [{
      id: "claude:composite:0", period: id, harnessId: "claude", harnessName: "Claude Code", title: "Cached title", models: ["claude-sonnet-4"],
      tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, total: 100 }, estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" },
      project: { label: "private", fullPath: "/secret/path", anonymized: true }, branch: "feature", toolCalls: 5,
    }] } });
    const onOpenSession = vi.fn();
    renderWithProviders(<UsageProjectArea {...baseProps({ onOpenSession })} />, { client });
    const title = await screen.findByText("Cached title");
    await userEvent.click(title);
    const item = title.closest('[data-testid="usage-session-row"]')! as HTMLElement;
    expect(within(item).getByLabelText("Token composition for this session")).toBeInTheDocument();
    expect(item).not.toHaveTextContent("/secret/path");
    await userEvent.click(within(item).getByRole("button", { name: "Inspect session" }));
    await screen.findByRole("dialog", { name: "Cached title" });
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([, args]) => {
      const values = (args as { args?: string[] })?.args ?? [];
      return values[1] === "inspect" && values[2] === id && values.includes("claude-code");
    })).toBe(true));
    await userEvent.keyboard("{Escape}");
    expect(within(item).queryByRole("button", { name: "Timeline" })).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.queryByText("Cached title")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("usage-session-row")).toHaveLength(1);
    await userEvent.click(screen.getByRole("radio", { name: /^All$/ }));
    expect(screen.getByText("Cached title")).toBeInTheDocument();
  });

  it("offers captured PRs and inspection for a ledger session without cached usage", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mockHubCmd(projectPayload({ sessions: [{ ...projectPayload().sessions[0], session_id: id }] }));
    const client = makeQueryClient();
    client.setQueryDefaults(qk.usageInspectionIndex(), { staleTime: Infinity, gcTime: Infinity });
    client.setQueryData(qk.usageInspectionIndex(), { ok: true, sessions: [{
      harness: "claude-code", session_id: id, root_session_id: id,
      latest_pr: { number: 42, url: "https://example.com/pull/42" }, additional_pr_count: 0,
    }] });
    renderWithProviders(<UsageProjectArea {...baseProps()} />, { client });
    const row = await screen.findByTestId("usage-session-row");
    await waitFor(() => expect(row).toHaveTextContent("PR #42"));
    expect(row).toHaveTextContent("Token breakdown unavailable");
    await userEvent.click(row);
    expect(within(row).queryByRole("button", { name: "Timeline" })).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([, args]) => (args as { args?: string[] })?.args?.[1] === "inspect")).toBe(false);
    await userEvent.click(within(row).getByRole("button", { name: "Inspect session" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([, args]) => {
      const values = (args as { args?: string[] })?.args ?? [];
      return values[1] === "inspect" && values[2] === id;
    })).toBe(true));
  });

  it("renders the six bands in the fixed order: Outcomes, Sessions, Over time, Footprint, Utilization, Findings", async () => {
    mockHubCmd(projectPayload());
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Footprint");
    // `.usage-kicker` is the one element per band that names it — StatCard's
    // own "Sessions" label (inside the Outcomes band) shares the WORD but
    // not this class, so scoping to it is what keeps the order assertion
    // from also catching that.
    const kickers = Array.from(container.querySelectorAll(".usage-project-area .usage-project-band .usage-section-head > div > .usage-kicker, .usage-project-area > .usage-project-activity > .usage-project-activity-head > div > .usage-kicker")).map(
      (el) => el.textContent,
    );
    expect(kickers).toEqual(["Outcomes", "Sessions", "Over time", "Footprint", "Utilization", "Findings"]);
  });

  it("reads a null `observed` as 'not analysed yet'", async () => {
    mockHubCmd(
      projectPayload({
        footprint: {
          codex: {
            observed: null,
            parts: [],
            unknown: [],
            bytes_total: 0,
            approx_tokens: 0,
          },
        },
      }),
    );
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByText("Observed bytes: not analysed yet")).toBeInTheDocument();
  });

  it("names `hub mcp check <name>` for an unknown footprint entry", async () => {
    mockHubCmd(
      projectPayload({
        footprint: {
          "claude-code": {
            observed: 100,
            parts: [],
            unknown: [{ part: "mcp_schemas", label: "some-mcp-server", reason: "never_probed", hint: "hub mcp check some-mcp-server" }],
            bytes_total: 100,
            approx_tokens: 20,
          },
        },
      }),
    );
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Footprint");
    await userEvent.click(screen.getByText("Unknown contributions (1)"));
    const command = container.querySelector(".usage-footprint-unknown code");
    expect(command).toHaveTextContent("hub mcp check some-mcp-server");
  });

  it("renders a zero-count utilization row, undimmed (no separate class/attribute)", async () => {
    mockHubCmd(projectPayload());
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    const row = await screen.findByText("unused-skill");
    expect(row).toBeInTheDocument();
    // "undimmed" means the row carries no special dim/idle marker — the row
    // renders through the same primitive as every other row.
    expect(row.closest(".hbar-row")).not.toHaveAttribute("data-dim");
  });

  it("sorts utilization without mutating input and reveals the remaining skills", async () => {
    const utilization = Array.from({ length: 9 }, (_, index) => ({
      key: `skill-${String.fromCharCode(97 + index)}`,
      count: index === 0 ? 0 : index === 1 ? 8 : index === 2 ? 8 : index,
      you: 0, model: 0, script: 0, last_used_at: null, trail: [], footprint_bytes: 0,
      harnesses: [], sessions_with_skill: 0, idle: false,
    }));
    const original = utilization.map((row) => row.key);
    mockHubCmd(projectPayload({ utilization }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("skill-b");
    expect(Array.from(document.querySelectorAll(".hbar-label")).map((node) => node.textContent)).toEqual(
      ["skill-b", "skill-c", "skill-i", "skill-h", "skill-g", "skill-f", "skill-e", "skill-d"],
    );
    expect(utilization.map((row) => row.key)).toEqual(original);
    await userEvent.click(screen.getByRole("button", { name: "Show all 9 skills" }));
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders an exact domain failure payload without dereferencing success fields", async () => {
    mockHubCmd({ ok: false, reason: "not_found", project: "missing" } as UsageProjectPayload);
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByText("This project's usage is unavailable")).toBeInTheDocument();
    expect(screen.getByText("No usage data exists for this project.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan now" })).not.toBeInTheDocument();
  });

  it("renders the shared project activity chart", async () => {
    const sessions = Array.from({ length: 10 }, (_, index) => ({
      session_id: `busy-${index}`, harness: "claude-code", started_at: "2026-09-06T09:00:00Z",
      tokens_total: 100, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true,
    }));
    mockHubCmd(projectPayload({ sessions }));
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByRole("region", { name: "Project activity" });
    expect(container.querySelector(".chart-col")).toBeInTheDocument();
  });

  it("renders a finding's moves as plain text and fires no hub_cmd mutation", async () => {
    mockHubCmd(projectPayload());
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByText("Trim the skill description")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trim the skill description" })).toBeNull();

    const scanCalls = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "hub_cmd" &&
          ((args as { args?: string[] })?.args ?? [])[1] === "scan-sessions",
      );
    expect(scanCalls).toHaveLength(0);
  });

  it("keeps Why local and renders only changed loadout markers", async () => {
    mockHubCmd(projectPayload(), scanResult(), [
      { at: "2026-09-05T09:00:00Z", harness: "claude-code", hash: "a", skill_count: 1, mcp_count: 0, kind: "initial" },
      { at: "2026-09-06T09:00:00Z", harness: "claude-code", hash: "b", skill_count: 2, mcp_count: 0, kind: "changed" },
    ]);
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/project/alpha?tab=footprint&review=f1",
    );
    expect(container.querySelectorAll(".chart-col-marker")).toHaveLength(1);
  });

  it("renders exactly one window selector in the shelf", async () => {
    mockHubCmd(projectPayload());
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Footprint");
    expect(screen.getAllByRole("radiogroup", { name: "Window" })).toHaveLength(1);
  });

  it("lists every payload harness in the shelf filter", async () => {
    mockHubCmd(projectPayload({ harnesses: ["claude-code", "codex"] }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Footprint");
    expect(screen.getByRole("radiogroup", { name: "Harness filter (sessions and activity)" })).toBeInTheDocument();
    expect(screen.queryByText("all harnesses")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Codex" })).toBeInTheDocument();
  });

  it("renders the `Scan now` empty state when there is no scan and no session", async () => {
    mockHubCmd(projectPayload({ last_scan_at: null, sessions: [] }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByText("No scanned sessions yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan now" })).toBeInTheDocument();
    expect(screen.queryByText("Footprint")).not.toBeInTheDocument();
  });

  it("renders six KPI tiles, including tokens per session and its unavailable dash", async () => {
    mockHubCmd(
      projectPayload({
        last_scan_at: "2026-09-06T12:00:00Z",
        sessions: [],
        outcomes: outcomes({
          cache_hit_ratio: null,
          tokens_per_session: null,
          steering_per_session: null,
          subagent_token_share: null,
          activity: { read: null, edit: null, verify: null, operate: null, delegate: null, skill: null, external: null },
          thinking_text_share: null,
          files_read_median: null,
          files_edited_median: null,
          verified_edit_session_ratio: null,
          median_all_projects: {
            activity: { read: null, edit: null, verify: null, operate: null, delegate: null, skill: null, external: null },
          },
        }),
      }),
    );

    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    expect(await screen.findByText("Outcomes")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.getByText("— / —")).toBeInTheDocument();
    expect(screen.getByText(/Thinking share —/)).toBeInTheDocument();
    expect(screen.getByText("No analysed sessions in this window.")).toBeInTheDocument();
    expect(document.querySelectorAll(".usage-kpis--six > .stat-card")).toHaveLength(6);
  });

  it("keeps the quiet Usage link navigable", async () => {
    mockHubCmd(projectPayload());
    renderWithProviders(<><UsageProjectArea {...baseProps()} /><LocationProbe /></>);
    await screen.findByText("Footprint");
    await userEvent.click(screen.getByRole("link", { name: /^Usage$/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/usage");
  });

  it("renders one no-events note while preserving the Sessions chart", async () => {
    mockHubCmd(projectPayload(), scanResult(), [], timelinePayload({ days: [] }));
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("No skill or tool events in this window");
    expect(container.querySelector('[aria-label="Project sessions"]')).toBeInTheDocument();
    expect(screen.getByText("No token activity in this window")).toBeInTheDocument();
  });

  it("keeps aggregate KPIs and notes truthful when a harness is selected", async () => {
    mockHubCmd(projectPayload({ harnesses: ["claude-code", "codex"] }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Footprint");
    const sessionsValue = screen.getByText("4", { selector: ".usage-kpis .value" });
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByText("4", { selector: ".usage-kpis .value" })).toBe(sessionsValue);
    expect(screen.getAllByText("all harnesses")).toHaveLength(4);
    // The Sessions and Activity heads name the selected harness instead.
    expect(screen.getAllByText("Codex", { selector: ".usage-scope-note" }).length).toBeGreaterThanOrEqual(1);
  });

  it("shows token peaks independently when named activity is empty", async () => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    grid[2][4] = 10;
    mockHubCmd(projectPayload(), scanResult(), [], timelinePayload({ days: [], peaks: { unit: "tokens", grid } }));
    const { container } = renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("No skill or tool events in this window");
    expect(screen.getByText("No skill or tool events in this window")).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Project sessions"]')).toBeInTheDocument();
    expect(container.querySelector(".usage-peaks-grid")).toBeInTheDocument();
  });

  it("names an unsupported harness without rendering transcript cards", async () => {
    mockHubCmd(projectPayload({ harnesses: ["pi"] }));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Pi" }));
    await screen.findByText("No transcript timeline for Pi");
    expect(screen.queryByText("Skills used")).not.toBeInTheDocument();
  });

  it("retries a failed timeline query", async () => {
    mockHubCmd(projectPayload(), scanResult(), [], new Error("timeline failed"));
    renderWithProviders(<UsageProjectArea {...baseProps()} />);
    await screen.findByText("Timeline unavailable");
    const before = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "hub_cmd").length;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "hub_cmd").length).toBeGreaterThan(before));
  });

  it("renders the failed-scan banner naming stopped_on when the scan was started from a DIFFERENT subtree", async () => {
    mockHubCmd(
      projectPayload(),
      scanResult({ ok: false, stopped_on: "2026-09-05.jsonl", errors: [{ file: "2026-09-05.jsonl", kind: "parse_error" }] }),
    );
    const client = makeQueryClient();
    renderWithProviders(
      <>
        <div data-testid="header-subtree">
          <ScanButton variant="ghost" />
        </div>
        <div data-testid="body-subtree">
          <UsageProjectArea {...baseProps()} />
        </div>
      </>,
      { client },
    );
    await screen.findByText("Footprint");

    const scanButton = within(screen.getByTestId("header-subtree")).getByRole("button", { name: "Scan" });
    await userEvent.click(scanButton);

    await waitFor(() => {
      expect(
        within(screen.getByTestId("body-subtree")).getByText(/Scan stopped on 2026-09-05\.jsonl/),
      ).toBeInTheDocument();
    });
    // Every already-written row stays on screen.
    expect(within(screen.getByTestId("body-subtree")).getByText("Footprint")).toBeInTheDocument();
  });

  it("keeps retained rows visible and offers fresh recovery for replan results", async () => {
    mockHubCmd(
      projectPayload(),
      scanResult({
        ok: false,
        state: "replan_required",
        partial: true,
        scan_id: "scan-1",
        errors: [{ kind: "reader_unavailable", file: "/private/transcript.jsonl" }],
      }),
    );
    renderWithProviders(
      <>
        <ScanButton />
        <UsageProjectArea {...baseProps()} />
      </>,
    );
    await screen.findByText("Footprint");

    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This saved scan cannot continue");
    expect(notice).not.toHaveTextContent("scan-1");
    expect(notice).not.toHaveTextContent("/private/");
    expect(screen.getByRole("region", { name: "Sessions" })).toBeVisible();
    expect(screen.queryByText(/Scan stopped on/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Start new scan" }));
    await waitFor(() => {
      const scanCalls = vi.mocked(invoke).mock.calls.filter(([cmd, args]) => {
        const command = (args as { args?: string[] } | undefined)?.args ?? [];
        return cmd === "hub_cmd" && command[0] === "usage" && command[1] === "scan-sessions";
      });
      expect(scanCalls).toHaveLength(2);
    });
    const freshCommand = vi.mocked(invoke).mock.calls
      .map(([, args]) => (args as { args?: string[] } | undefined)?.args ?? [])
      .filter((command) => command[1] === "scan-sessions")[1];
    expect(freshCommand).toEqual(["usage", "scan-sessions", "--json"]);
  });
});
