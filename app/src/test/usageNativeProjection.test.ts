import { applyDisplayTokenProjection, applyNativeProjection } from "@/features/usage/usageNative";
import { describe, expect, it } from "vitest";
import { expandInspectionIndexRows, joinInspectionIndex } from "@/features/usage/useLocalAgentUsage";
import { projectSessionItems } from "@/screens/usage/usageSessionPresentation";
import { recomputeScopedUsage } from "@/screens/usage/usageAggregate";
import type { InspectionIndexSession, InspectionNativeFacts } from "@/features/usage/usageInspectionTypes";
import type { LocalAgentUsageSnapshot, UsageSessionRow } from "@/features/usage/usageTypes";

const uuid = "019fd809-2012-7ef2-8cfb-91696cccd6f4";
const native = (patch: Partial<InspectionNativeFacts> = {}): InspectionNativeFacts => ({
  lines_added: 0, lines_removed: 2, duration_ms: 1200, branch: "feature/x", tool_calls: 0,
  tool_breakdown: [], status: "observed",
  field_status: { lines_added: "observed", lines_removed: "observed", duration_ms: "observed", branch: "observed", tool_calls: "observed", tool_breakdown: "observed" },
  ...patch,
});
const inspection = (facts: InspectionNativeFacts, agents: InspectionIndexSession["agents"] = [], patch: Partial<InspectionIndexSession> = {}): InspectionIndexSession => ({
  harness: "claude-code", session_id: uuid, root_session_id: uuid, run_id: "run-root", status: "available",
  scopes: {} as InspectionIndexSession["scopes"], latest_pr: null, additional_pr_count: 0, pinned: false,
  native: { own: facts, children: facts, subtree: facts }, agents,
  ...patch,
});
const session = (patch: Partial<UsageSessionRow> = {}): UsageSessionRow => ({
  id: uuid, period: uuid, harnessId: "claude-code", harnessName: "Claude Code", models: [],
  tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0, total: 2 },
  estimatedCost: { usd: 1, label: "Estimated API-equivalent cost" }, toolCalls: 9, linesAdded: 9, branch: "stale", ...patch,
});

const snapshotFor = (rows: UsageSessionRow[]): LocalAgentUsageSnapshot => {
  const row = rows[0];
  return { overview: { totalTokens: 2, estimatedCost: row.estimatedCost, sessions: 1, harnessesDetected: 1, tokens: row.tokens, toolCalls: 99, cacheHitRate: 0, linesAdded: 99, linesRemoved: 0 }, sessions: rows, harnesses: [{ id: "claude", name: "Claude", status: "detected" as const, tokens: row.tokens, estimatedCost: row.estimatedCost, sessions: 1, days: 1, toolCalls: 99, models: [], modelBreakdown: [] }], projects: [{ key: "p1", label: "same", sessions: 1, tokens: row.tokens, estimatedCost: row.estimatedCost, toolCalls: 99 }], detectedSources: [], daily: [], models: [], scannedAt: "", runner: { command: "", args: [], resolved_from: "" }, privacy: { runsLocally: true as const, rawPromptsDisplayed: false as const, fullPathsHiddenByDefault: true as const, costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage." } };
};

describe("native usage projection", () => {

  it("joins identical UUIDs only within their harness", () => {
    const claude = session({ hubProject: "alpha" });
    const codex = session({ harnessId: "codex", harnessName: "Codex", hubProject: "alpha" });
    const claudeIndex = inspection(native({ tool_calls: 3, lines_added: 10 }));
    const codexIndex = { ...inspection(native({ tool_calls: 7, lines_added: 20 })), harness: "codex" };
    const joined = joinInspectionIndex(snapshotFor([claude, codex]), [codexIndex, claudeIndex])!;
    expect(joined.sessions.map((row) => [row.harnessId, row.toolCalls, row.linesAdded])).toEqual([["claude-code", 3, 10], ["codex", 7, 20]]);
    const ledger = { session_id: uuid, started_at: null, last_activity_at: null, tokens_total: 2, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true };
    const project = projectSessionItems("alpha", [{ ...ledger, harness: "claude-code" }, { ...ledger, harness: "codex" }], joined.sessions, [claudeIndex, codexIndex]);
    expect(project.map(({ session: row }) => [row.harnessId, row.toolCalls]).sort()).toEqual([["claude-code", 3], ["codex", 7]]);
  });

  it("overlays observed zero values and breakdowns onto a cached row", () => {
    const projected = applyNativeProjection(session(), inspection(native()));
    expect(projected.toolCalls).toBe(0);
    expect(projected.linesAdded).toBe(0);
    expect(projected.linesRemoved).toBe(2);
    expect(projected.branch).toBe("feature/x");
  });

  it("removes stale native fields when the canonical field is unavailable", () => {
    const facts = native({ status: "unavailable", lines_added: null, branch: null, tool_calls: null, tool_breakdown: [], field_status: {
      lines_added: "unavailable", lines_removed: "unavailable", duration_ms: "unavailable", branch: "unavailable", tool_calls: "unavailable", tool_breakdown: "unavailable",
    }});
    const projected = applyNativeProjection(session(), inspection(facts));
    expect(projected.linesAdded).toBeUndefined();
    expect(projected.toolCalls).toBeUndefined();
    expect(projected.branch).toBeUndefined();
  });

  it("expands an agent with its own native projection", () => {
    const child = "119fd809-2012-7ef2-8cfb-91696cccd6f4";
    const agentNative = native({ lines_added: 2, lines_removed: 0 });
    const root = inspection(native({ lines_added: 10 }), [{ session_id: child, run_id: "run-child", native: { own: agentNative, children: agentNative, subtree: agentNative } }]);
    const expanded = expandInspectionIndexRows([root]);
    expect(expanded).toHaveLength(2);
    expect(expanded[1].native?.own.lines_added).toBe(2);
  });

  it("does not retain stale aggregates when native coverage is partial", () => {
    const row = session({ id: uuid, toolCalls: 99, linesAdded: 99 });
    const snapshot = snapshotFor([row]);
    const unavailable = native({ status: "unavailable", lines_added: null, lines_removed: null, duration_ms: null, branch: null, tool_calls: null, tool_breakdown: [], field_status: { lines_added: "unavailable", lines_removed: "unavailable", duration_ms: "unavailable", branch: "unavailable", tool_calls: "unavailable", tool_breakdown: "unavailable" } });
    const result = joinInspectionIndex(snapshot, [inspection(unavailable)]);
    expect(result?.sessions[0].toolCalls).toBeUndefined();
    expect(result?.overview.toolCalls).toBe(0);
    expect(result?.overview.toolCallsKnown).toBe(false);
    expect(result?.overview.toolCallsUnknownSessions).toBe(1);
    expect(result?.overview.linesAdded).toBe(0);
    expect(result?.overview.linesAddedKnown).toBe(false);
  });

  it("keeps projects with equal labels separate by canonical key", () => {
    const ledger = { session_id: uuid, harness: "claude-code", started_at: null, last_activity_at: null, tokens_total: 2, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true };
    const rows = [session({ hubProject: "a", title: "A", project: { label: "same", anonymized: true } }), session({ hubProject: "b", title: "B", project: { label: "same", anonymized: true } })];
    expect(projectSessionItems("a", [ledger], rows)[0].session.title).toBe("A");
    expect(projectSessionItems("b", [ledger], rows)[0].session.title).toBe("B");
  });

  it("never gives a child its parent's descendant token scope", () => {
    const scope = (total: number) => ({ tokens: { input: total, output: 0, cache_creation: 0, cache_read: 0, total, status: "available" as const }, cost: { currency: "USD", value: null, status: "unpriced" as const }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const } });
    const childScopes = { own: scope(3), children: scope(4), subtree: scope(7) };
    const root = inspection(native(), [{ session_id: "119fd809-2012-7ef2-8cfb-91696cccd6f4", run_id: "child", status: "available", scopes: childScopes }]);
    root.scopes = { own: scope(10), children: scope(7), subtree: scope(17) };
    const child = expandInspectionIndexRows([root])[1];
    expect(child.scopes).toEqual(childScopes);
    expect(child.agents).toEqual([]);
  });

  it("projects native facts onto a ledger-only session", () => {
    const item = projectSessionItems("alpha", [{ session_id: uuid, harness: "claude-code", started_at: null, last_activity_at: null, tokens_total: 2, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true }], [], [inspection(native({ tool_calls: 0, lines_added: 0 }))])[0];
    expect(item.session.toolCalls).toBe(0);
    expect(item.session.linesAdded).toBe(0);
  });

  it("retains a partial captured count without declaring its aggregate complete", () => {
    const facts = native({ tool_calls: 1, tool_breakdown: [{ name: "Bash", count: 1 }], field_status: { ...native().field_status, tool_calls: "partial", tool_breakdown: "partial" } });
    const projected = applyNativeProjection(session(), inspection(facts));
    expect(projected.toolCalls).toBe(1);
    expect(projected.toolBreakdown).toEqual([{ name: "Bash", count: 1 }]);
    const aggregate = recomputeScopedUsage([projected]);
    expect(aggregate.toolCalls).toBe(1);
    expect(aggregate.toolCallsKnown).toBe(false);
    expect(aggregate.harnesses[0].toolCallsKnown).toBe(false);
    expect(aggregate.projects[0].toolCallsKnown).toBe(false);
  });

  it("projects canonical own tokens for display while preserving provider aggregates", () => {
    const scope = (input: number, output: number, total: number) => ({
      tokens: { input, output, cache_creation: 0, cache_read: 0, total, status: "available" as const },
      cost: { currency: "USD", value: null, status: "unpriced" as const },
      timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const },
    });
    const index = inspection(native(), [], {
      summary_provenance: "canonical", capture_coverage: "complete",
      scopes: { own: scope(100, 10, 110), children: scope(700, 10, 710), subtree: scope(800, 20, 820) },
    });
    const provider = session({ tokens: { input: 800, output: 20, cacheCreation: 0, cacheRead: 0, total: 820 } });
    const joined = joinInspectionIndex(snapshotFor([provider]), [index])!;
    expect(joined.sessions[0].tokens.total).toBe(820);
    expect(recomputeScopedUsage(joined.sessions).tokens.total).toBe(820);
    expect(applyDisplayTokenProjection(joined.sessions[0]).tokens.total).toBe(110);
    expect(projectSessionItems("p1", [{ session_id: uuid, harness: "claude-code", started_at: null, last_activity_at: null, tokens_total: 820, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true }], joined.sessions, [index])[0].session.tokens.total).toBe(110);
  });

  it.each([
    ["partial", "canonical"],
    ["unavailable", "legacy_import"],
  ] as const)("retains provider tokens for %s capture", (capture_coverage, summary_provenance) => {
    const index = inspection(native(), [], { summary_provenance, capture_coverage });
    const provider = session({ tokens: { input: 800, output: 20, cacheCreation: 0, cacheRead: 0, total: 820 } });
    const projected = applyDisplayTokenProjection({ ...provider, inspection: index });
    expect(projected.tokens.total).toBe(820);
  });
});
