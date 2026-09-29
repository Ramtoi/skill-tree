import { describe, expect, it } from "vitest";
import { normalizeCcusageScan } from "@/features/usage/normalizeUsage";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { groupCodexSessions } from "@/screens/usage/usageSessionFamilies";

const tokens = (total: number) => ({ input: total, output: 0, cacheCreation: 0, cacheRead: 0, total });
const cost = (usd: number) => ({ usd, label: "Estimated API-equivalent cost" as const });
function row(id: string, total: number, extra: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return { id, period: id, harnessId: "codex", harnessName: "Codex", models: ["gpt-5.5"], tokens: tokens(total), estimatedCost: cost(total / 1000), ...extra };
}

describe("Codex session families", () => {
  it("groups root, child, and grandchild once and keeps measured members filtered", () => {
    const root = row("root", 100, { title: "Build Usage identity" });
    const child = row("child", 20, { parentSessionId: "root", agentRole: "planner", agentNickname: "Scout" });
    const grandchild = row("grandchild", 5, { parentSessionId: "child", agentRole: "tester" });
    const family = groupCodexSessions([child, grandchild], [root, child, grandchild])[0];
    expect(family.session.id).toBe("root");
    expect(family.members.map((member) => member.id)).toEqual(["child", "grandchild"]);
    expect(family.session.tokens.total).toBe(25);
    expect(family.contextOnly).toBe(true);
  });

  it("marks an orphan available while retaining its own identity", () => {
    const orphan = row("orphan", 9, { parentSessionId: "missing", title: "Orphan agent" });
    const family = groupCodexSessions([orphan])[0];
    expect(family.session.id).toBe("orphan");
    expect(family.parentUnavailable).toBe(true);
    expect(family.members).toHaveLength(1);
  });

  it("normalizes native titles and lineage without leaking source paths", () => {
    const scan = {
      scanned_at: 1,
      source: { command: "ccusage", args: [], resolved_from: "test" },
      parsed: {
        daily: [], weekly: [], monthly: [],
        totals: { totalTokens: 12, totalCost: 1 },
        session: [{
          agent: "codex", period: "rollout-019fd809-2012-7ef2-8cfb-91696cccd6f4",
          inputTokens: 10, outputTokens: 2, totalTokens: 12, totalCost: 1,
          metadata: { title: "Fix /Users/alice/private/repo", titleSource: "native", parentSessionId: "root-id", agentRole: "planner" },
        }],
      },
    };
    const normalized = normalizeCcusageScan(scan);
    expect(normalized.sessions[0]).toMatchObject({
      id: "019fd809-2012-7ef2-8cfb-91696cccd6f4",
      title: "Fix <redacted-path>", titleSource: "native", parentSessionId: "root-id", agentRole: "planner",
    });
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { UsageSessionsCard } from "@/screens/usage/UsageSessionsCard";
import { expandInspectionIndexRows } from "@/features/usage/useLocalAgentUsage";
import { deferredInvoke, renderWithProviders } from "./helpers";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import type { InspectionIndexSession } from "@/features/usage/usageInspectionTypes";
import { resolveInspectionTarget, UsageSessionRoute } from "@/screens/usage/UsageSessionRoute";

it("searches by agent, opens and pins that run, then keeps the family expanded on close", async () => {
  const rootId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const rootInspection = { ...inspectionFixture.index.sessions[0], harness: "codex", session_id: rootId, root_session_id: rootId, agents: [{ session_id: childId, run_id: "run:child" }] } as InspectionIndexSession;
  const expanded = expandInspectionIndexRows([rootInspection]);
  const childInspection = expanded.find((item) => item.session_id === childId)!;
  const root = row(rootId, 100, { title: "Build Usage identity", inspection: rootInspection });
  const child = row(childId, 20, { parentSessionId: rootId, agentNickname: "Scout", agentRole: "planner", inspection: childInspection });
  renderWithProviders(<UsageSessionsCard sessions={[root, child]} effectiveShowFullPaths={false} onShowFullPathsChange={vi.fn()} hasFullFidelityData busy={false} onRunFreshScan={vi.fn()} currency="USD" eurRate={1} />);
  expect(screen.getAllByTestId("usage-session-row")).toHaveLength(1);
  expect(screen.getByTestId("usage-session-row")).toHaveAttribute("aria-label", "Build Usage identity, 120 tokens, $0.12");
  const search = screen.getByPlaceholderText("Search sessions…");
  fireEvent.change(search, { target: { value: "Scout" } });
  expect(screen.getByTestId("usage-session-row")).toHaveAttribute("aria-label", "Build Usage identity, 20 tokens, $0.02");
  fireEvent.click(screen.getByRole("button", { name: "Show session details" }));
  // The expanded row carries no second agent list; members are reached
  // through the session sheet's timeline lanes.
  expect(screen.queryByRole("region", { name: "Session agents" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Inspect Scout/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect session" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "hub_cmd" && JSON.stringify(args).includes(`"inspect","${rootId}"`))).toBe(true));
  // Two controls now pin this session: the sheet header's, and the timeline's
  // own when the root lane is selected. Click the header's.
  const toolbar = dialog.querySelector(".usage-sheet-toolbar") as HTMLElement;
  fireEvent.click(within(toolbar).getByRole("button", { name: "Pin session" }));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => {
    const command = (args as { args?: string[] })?.args ?? [];
    return cmd === "hub_cmd" && command.includes("pin") && command.includes("add") && command.includes(rootId);
  })).toBe(true));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(search).toHaveValue("Scout");
  expect(screen.getByRole("button", { name: "Hide session details" })).toBeVisible();
});

it("resolves a direct child route through a root-only inspection index", () => {
  const rootId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const root = { ...inspectionFixture.index.sessions[0], harness: "codex", session_id: rootId, root_session_id: rootId, agents: [{ session_id: childId, run_id: "run:child" }] } as InspectionIndexSession;
  const otherHarness = { ...root, harness: "claude-code", root_session_id: "claude-root" };
  expect(resolveInspectionTarget(childId, null, [otherHarness, root], "codex")).toEqual({ sessionId: rootId, runId: "run:child" });
  expect(resolveInspectionTarget(childId, null, [root])).toEqual({ sessionId: rootId, runId: "run:child" });
  expect(resolveInspectionTarget(childId, "run:explicit", [root])).toEqual({ sessionId: rootId, runId: "run:explicit" });
  expect(resolveInspectionTarget(rootId, null, [root])).toEqual({ sessionId: rootId, runId: null });
  expect(resolveInspectionTarget(childId, null, [{ ...root, harness: "claude-code" }], "claude-code")).toEqual({ sessionId: childId, runId: null });
});

it("waits for a root-only index before requesting a direct child", async () => {
  const rootId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const root = { ...inspectionFixture.index.sessions[0], harness: "codex", session_id: rootId, root_session_id: rootId, agents: [{ session_id: childId, run_id: "run:child" }] } as InspectionIndexSession;
  const gate = deferredInvoke((cmd, args) => cmd === "hub_cmd" && JSON.stringify(args).includes("inspect-index"));
  renderWithProviders(<Routes><Route path="/usage/session/:id" element={<UsageSessionRoute />} /></Routes>, { initialRoute: `/usage/session/${childId}?harness=codex` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "hub_cmd" && JSON.stringify(args).includes('"inspect"'))).toBe(false);
  gate.resolve({ success: true, output: JSON.stringify({ ok: true, sessions: [root] }) });
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "hub_cmd" && JSON.stringify(args).includes(`"${rootId}"`) && JSON.stringify(args).includes('"--run","run:child"'))).toBe(true));
});
