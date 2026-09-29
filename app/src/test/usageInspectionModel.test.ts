import { describe, expect, it } from "vitest";
import { buildTimeTransform, buildTimelineLanes, globalGapIntervals, groupToolCalls, sortToolCallsChronologically } from "@/screens/usage/usageInspectionModel";
import { joinInspectionIndex } from "@/features/usage/useLocalAgentUsage";
import { normalizeCcusageScan } from "@/features/usage/normalizeUsage";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import type { InspectionIndexSession, InspectionRun, InspectionToolCall } from "@/features/usage/usageInspectionTypes";

const scope = { tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0, status: "available" as const }, cost: { currency: "USD", value: null, status: "unpriced" as const }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const } };
function run(id: string, parent_id: string | null, start: string): InspectionRun { return { id, parent_id, depth: parent_id ? 1 : 0, label: id, role: { value: null, status: "unavailable" }, models: [], start: { at: start, status: "observed" }, activity_intervals: [], lifespan: { start, end: start, status: "observed" }, worktree: { label: null, status: "unknown" }, scopes: { own: scope, children: scope, subtree: scope }, tool_calls: 0, edits: 0, evidence: [] }; }

describe("usage inspection model", () => {
  it("keeps main lane first and attaches children", () => {
    const lanes = buildTimelineLanes([run("child", "main", "2026-09-01T10:01:00Z"), run("main", null, "2026-09-01T10:00:00Z")]);
    expect(lanes[0].id).toBe("main");
    expect(lanes[0].children[0].id).toBe("child");
  });

  it("groups only adjacent matching operations", () => {
    const call = (id: string, name: string, signature: string): InspectionToolCall => ({ id, run_id: "main", ordinal: Number(id), at: null, tool: { name, kind: "local" }, operation: { summary: signature, signature, status: "available" }, execution: "completed", input_parts: [], result_parts: [], source_epoch: "epoch", evidence: [] });
    expect(groupToolCalls([call("1", "Bash", "git status"), call("2", "Bash", "git status"), call("3", "Read", "README")]).map((item) => item.calls.length)).toEqual([2, 1]);
    expect(groupToolCalls([call("1", "Bash", "git status"), call("2", "Read", "README"), call("3", "Bash", "git status")]).map((item) => item.calls.length)).toEqual([1, 1, 1]);
  });

  it("groups by operation signature and displays the summary as the label", () => {
    const call = (id: string, signature: string, summary: string): InspectionToolCall => ({ id, run_id: "main", ordinal: Number(id), at: null, tool: { name: "Bash", kind: "local" }, operation: { summary, signature, status: "available" }, execution: "completed", input_parts: [], result_parts: [], source_epoch: "epoch", evidence: [] });
    // Distinct hashes sharing a redacted summary must not collapse.
    const distinct = groupToolCalls([call("1", "op:aaa", "Runs a shell command"), call("2", "op:bbb", "Runs a shell command")]);
    expect(distinct).toHaveLength(2);
    expect(distinct.every((group) => group.label === "Runs a shell command")).toBe(true);
    // Repeated identical hashes still group, and the label is the summary, not the hash.
    const repeated = groupToolCalls([call("1", "op:aaa", "Runs a shell command"), call("2", "op:aaa", "Runs a shell command")]);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].calls).toHaveLength(2);
    expect(repeated[0].label).toBe("Runs a shell command");
    expect(repeated[0].operation).toBe("op:aaa");
  });

  it("does not expose a hash when a captured operation has no summary", () => {
    const [group] = groupToolCalls([{
      id: "missing-summary",
      run_id: "main",
      ordinal: 0,
      at: null,
      tool: { name: "Bash", kind: "local" },
      operation: { summary: null, signature: "op:hidden", status: "available" },
      execution: "completed",
      input_parts: [],
      result_parts: [],
      source_epoch: "epoch",
      evidence: [],
    }]);
    expect(group.operation).toBe("op:hidden");
    expect(group.label).toBeNull();
  });

  it("keeps missing-signature calls separate even when their summaries match", () => {
    const call = (id: string, ordinal: number): InspectionToolCall => ({
      id,
      run_id: "main",
      ordinal,
      at: null,
      tool: { name: "Bash", kind: "local" },
      operation: { summary: "Runs a shell command", signature: null, status: "available" },
      execution: "completed",
      input_parts: [],
      result_parts: [],
      source_epoch: "epoch",
      evidence: [],
    });
    const groups = groupToolCalls([call("missing-a", 0), call("missing-b", 1)]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.calls)).toEqual([[expect.objectContaining({ id: "missing-a" })], [expect.objectContaining({ id: "missing-b" })]]);
  });

  it("orders generated captured calls by recorded time before grouping", () => {
    const calls = inspectionFixture.captured_contract["claude-code"].tools.items as unknown as InspectionToolCall[];
    expect(sortToolCallsChronologically(calls).map((item) => item.tool.name)).toEqual(["Bash", "Bash", "Edit"]);
    expect(groupToolCalls(calls).flatMap((group) => group.calls).map((item) => item.tool.name)).toEqual(["Bash", "Bash", "Edit"]);
  });

  it("uses one global gap transform and keeps a spanning interval visible", () => {
    const start = "2026-09-01T10:00:00Z";
    const end = "2026-09-01T11:00:00Z";
    const runs = [{ ...run("main", null, start), activity_intervals: [{ start, end, status: "observed" as const }] }];
    const transform = buildTimeTransform({ origin: start, events: [], gaps: [{ start: "2026-09-01T10:20:00Z", end: "2026-09-01T10:40:00Z" }], relationship_edges: [] }, runs);
    expect(transform.gaps).toHaveLength(0);
    expect(transform.span(start, end).width).toBeGreaterThan(99);
  });

  it("builds complement gaps from observed work, wait ends, and point cutpoints", () => {
    const runs = [{
      ...run("main", null, "2026-09-01T09:00:00Z"),
      lifespan: { start: "2026-09-01T09:00:00Z", end: "2026-09-01T12:00:00Z", status: "observed" as const },
      activity_intervals: [{ start: "2026-09-01T09:00:00Z", end: "2026-09-01T09:10:00Z", status: "observed" as const }],
    }];
    const timeline = {
      origin: "2026-09-01T09:00:00Z",
      events: [
        { run_id: "main", at: "2026-09-01T10:00:00Z", kind: "message" },
        { run_id: "main", at: "2026-09-01T10:10:00Z", kind: "wait_started" },
        { run_id: "main", at: "2026-09-01T10:40:00Z", kind: "wait_result", status: "observed" },
      ],
      gaps: [],
      relationship_edges: [],
    };
    expect(globalGapIntervals(timeline, runs).map((gap) => gap.end - gap.start)).toEqual([50 * 60 * 1000, 80 * 60 * 1000]);
  });

  it("does not paint inferred activity as observed work", () => {
    const start = "2026-09-01T09:00:00Z";
    const end = "2026-09-01T10:00:00Z";
    const runs = [{ ...run("main", null, start), lifespan: { start, end, status: "observed" as const }, activity_intervals: [{ start, end: "2026-09-01T09:30:00Z", status: "inferred" as const }] }];
    expect(globalGapIntervals({ origin: start, events: [], gaps: [], relationship_edges: [] }, runs)).toHaveLength(1);
  });

  it("keeps zoomed endpoints reachable and scopes wait intervals to their run", () => {
    const start = "2026-09-01T09:00:00Z";
    const end = "2026-09-01T10:00:00Z";
    const runs = [
      { ...run("main", null, start), lifespan: { start, end, status: "observed" as const } },
      { ...run("child", "main", "2026-09-01T09:10:00Z"), lifespan: { start: "2026-09-01T09:10:00Z", end: "2026-09-01T09:20:00Z", status: "observed" as const } },
    ];
    const timeline = { origin: start, events: [], gaps: [], wait_intervals: [{ start: "2026-09-01T09:10:00Z", end: "2026-09-01T09:15:00Z", run_id: "child" as string }], relationship_edges: [] };
    const transform = buildTimeTransform(timeline, runs, 2);
    expect(transform.position(end)).toBe(100);
    expect(globalGapIntervals(timeline, runs).every((gap) => gap.start !== Date.parse("2026-09-01T09:10:00Z") || gap.end !== Date.parse("2026-09-01T09:15:00Z"))).toBe(true);
  });

  it.each(["/Users/test/transcripts/", "C:\\Users\\test\\transcripts\\"])("joins a ccusage transcript path under %s to the canonical harness index", (prefix) => {
    const sessionId = inspectionFixture.index.sessions[0].session_id;
    const snapshot = normalizeCcusageScan({
      scanned_at: 1,
      source: { command: "ccusage", args: ["--json"], resolved_from: "fixture" },
      parsed: { daily: [], session: [{ agent: "claude", id: `${prefix}${sessionId}`, period: "session", totalTokens: 34, totalCost: 0.001 }] },
    });
    const joined = joinInspectionIndex(snapshot, inspectionFixture.index.sessions as InspectionIndexSession[]);
    expect(joined?.sessions[0].inspection?.session_id).toBe(sessionId);
    expect(joined?.sessions[0].inspection?.harness).toBe("claude-code");
    expect(joined?.sessions[0].id).toBe(`${prefix}${sessionId}`);
    expect(joined?.sessions[0].tokens).toEqual(snapshot.sessions[0].tokens);
  });

  it.each(["claude", "unknown"])("does not infer %s identity from a UUID in a parent directory", (agent) => {
    const sessionId = inspectionFixture.index.sessions[0].session_id;
    const snapshot = normalizeCcusageScan({
      scanned_at: 1,
      source: { command: "ccusage", args: ["--json"], resolved_from: "fixture" },
      parsed: { daily: [], session: [{ agent, id: `/transcripts/${sessionId}/unrelated`, period: "session", totalTokens: 34, totalCost: 0.001 }] },
    });
    const joined = joinInspectionIndex(snapshot, inspectionFixture.index.sessions as InspectionIndexSession[]);
    expect(joined?.sessions[0].inspection).toBeUndefined();
  });
});
