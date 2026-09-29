import { describe, expect, it } from "vitest";
import type { UsageProjectSessionRow } from "@/features/usage/usageAnalyticsTypes";
import type { InspectionIndexSession } from "@/features/usage/usageInspectionTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { projectSessionItems } from "@/screens/usage/usageSessionPresentation";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function ledger(session_id: string, patch: Partial<UsageProjectSessionRow> = {}): UsageProjectSessionRow {
  return { session_id, harness: "claude-code", started_at: "2026-09-01T00:00:00Z", tokens_total: 500,
    cache_hit_ratio: 0.75, steering_count: 3, loadout_assumed: true, analysed: true, ...patch };
}
function cached(patch: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return { id: "normalized-0", period: A, harnessId: "claude", harnessName: "Claude Code", models: ["claude-sonnet-4"],
    title: "Shared session", branch: "feature", hubProject: "alpha", tokens: { input: 100, output: 20, cacheRead: 380, cacheCreation: 0, total: 500 },
    estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" }, ...patch };
}

describe("projectSessionItems", () => {
  it("sorts all harnesses by activity with deterministic ties independent of input", () => {
    const rows = [ledger(A), ledger(B, { harness: "codex", last_activity_at: "2026-09-05T00:00:00Z" }),
      ledger("z", { started_at: "2026-09-04T00:00:00Z" }), ledger("a", { started_at: "2026-09-04T00:00:00Z" })];
    const expected = [B, "a", "z", A];
    expect(projectSessionItems("alpha", rows, []).map((x) => x.row.session_id)).toEqual(expected);
    expect(projectSessionItems("alpha", [...rows].reverse(), []).map((x) => x.row.session_id)).toEqual(expected);
    expect(rows.map((x) => x.session_id)).toEqual([A, B, "z", "a"]);
  });

  it("falls through invalid activity and start timestamps and sorts undated rows last", () => {
    const rows = [ledger("z", { started_at: null }), ledger("a", { started_at: undefined }),
      ledger(A, { last_activity_at: "invalid", started_at: "invalid" }),
      ledger(B, { harness: "codex", last_activity_at: null, started_at: "2026-09-03T00:00:00Z" })];
    const items = projectSessionItems("alpha", rows, [cached({ lastActivity: "bad", startedAt: "2026-09-02T00:00:00Z" })]);
    expect(items.map((x) => x.row.session_id)).toEqual([B, A, "a", "z"]);
    expect(items[1].session.lastActivity).toBeUndefined();
    expect(items[1].session.startedAt).toBe("2026-09-02T00:00:00Z");
  });

  it("uses cached activity before ledger start, and ledger activity before cached activity", () => {
    const rich = cached({ lastActivity: "2026-09-05T00:00:00Z" });
    expect(projectSessionItems("alpha", [ledger(A)], [rich])[0].session.lastActivity).toBe(rich.lastActivity);
    expect(projectSessionItems("alpha", [ledger(A, { last_activity_at: "2026-09-06T00:00:00Z" })], [rich])[0].session.lastActivity).toBe("2026-09-06T00:00:00Z");
  });

  it("joins by ledger identity and harness without adding cache-only sessions or paths", () => {
    const rich = cached({ project: { label: "private", anonymized: true, fullPath: "/secret/path" } });
    const rows = [ledger(A), ledger(A, { harness: "codex" })];
    const items = projectSessionItems("alpha", rows, [rich, cached({ id: B, period: B, title: "Outside window" })]);
    expect(items).toHaveLength(2);
    expect(items[0].session.title).toBe("Shared session");
    expect(items[0].session.project).toEqual({ label: "alpha", anonymized: true });
    expect(items[0].session.tokens).toEqual(rich.tokens);
    expect(items[0].session.projectContext).toMatchObject({ cache_hit_ratio: 0.75, steering_count: 3, loadout_assumed: true });
    expect(items[1].session.title).toBeUndefined();
    expect(items[1].session.tokens).toEqual({ total: 500 });
    expect(items[1].session.estimatedCost).toBeUndefined();
  });

  it("retains captured inspection metadata even without a matching ccusage row", () => {
    const inspection = { harness: "claude-code", session_id: A, root_session_id: A,
      latest_pr: { number: 42, url: "https://example.com/pull/42" }, pinned: true,
    } as InspectionIndexSession;
    const items = projectSessionItems("alpha", [ledger(A), ledger(A, { harness: "codex" })], [], [inspection]);
    expect(items[0].session.inspection).toBe(inspection);
    expect(items[0].session.tokens).toEqual({ total: 500 });
    expect(items[0].session.estimatedCost).toBeUndefined();
    expect(items[1].session.inspection).toBeUndefined();
  });

  it("uses canonical own tokens in project rows and signals incomplete provider totals", () => {
    const tokens = (total: number) => ({ input: total, output: 0, cache_creation: 0, cache_read: 0, total, status: "available" as const });
    const inspection = {
      harness: "claude-code", session_id: A, root_session_id: A, run_id: "run",
      status: "available", summary_provenance: "canonical", capture_coverage: "complete",
      scopes: {
        own: { tokens: tokens(110), cost: { currency: "USD", value: null, status: "unpriced" as const }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const } },
        children: { tokens: tokens(710), cost: { currency: "USD", value: null, status: "unpriced" as const }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const } },
        subtree: { tokens: tokens(820), cost: { currency: "USD", value: null, status: "unpriced" as const }, timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const } },
      }, latest_pr: null, additional_pr_count: 0, pinned: false,
    } as InspectionIndexSession;
    const item = projectSessionItems("alpha", [ledger(A)], [cached({ tokens: { input: 800, output: 20, cacheRead: 0, cacheCreation: 0, total: 820 }, inspection })], [inspection])[0].session;
    expect(item.tokens.total).toBe(110);
    expect(item.tokenCaptureCoverage).toBe("complete");
    const partial = { ...inspection, summary_provenance: "canonical" as const, capture_coverage: "partial" as const };
    const fallback = projectSessionItems("alpha", [ledger(A)], [cached({ tokens: { input: 800, output: 20, cacheRead: 0, cacheCreation: 0, total: 820 }, inspection: partial })], [partial])[0].session;
    expect(fallback.tokens.total).toBe(820);
    expect(fallback.tokenCaptureCoverage).toBe("partial");
  });

  it("rejects metadata for another known project or a non-UUID composite identity", () => {
    expect(projectSessionItems("alpha", [ledger(A)], [cached({ hubProject: "beta" })])[0].cachedSession).toBeUndefined();
    expect(projectSessionItems("alpha", [ledger(A)], [cached({ id: `prefix-${A}`, period: "unknown" })])[0].cachedSession).toBeUndefined();
  });
});

it("carries ledger-only Codex parent identity without an inspection index", () => {
  const [item] = projectSessionItems("alpha", [ledger(B, { harness: "codex", parent_session_id: A })], []);
  expect(item.session.parentSessionId).toBe(A);
  expect(item.session.tokens).toEqual({ total: 500 });
});
