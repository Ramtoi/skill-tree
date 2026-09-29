import { describe, expect, it } from "vitest";
import type { UsageLoadoutRow, UsageTimelinePayload, UsageProjectSessionRow } from "@/features/usage/usageAnalyticsTypes";
import { qk } from "@/lib/queryKeys";
import { buildProjectSessionColumns, projectActivitySeries } from "@/screens/usage/usageProjectTimeline";

const now = new Date("2026-09-09T22:30:00Z");

function session(id: string, started_at: string, harness = "claude-code"): UsageProjectSessionRow {
  return { session_id: id, harness, started_at, tokens_total: 1, cache_hit_ratio: 0, steering_count: 0, loadout_assumed: false, analysed: true };
}

function loadout(at: string, harness = "claude-code", kind: UsageLoadoutRow["kind"] = "changed"): UsageLoadoutRow {
  return { at, harness, hash: at, skill_count: 1, mcp_count: 0, kind };
}

describe("usage timeline query keys", () => {
  it("separates projects while keeping the overview key project-free", () => {
    expect(qk.usageProjectTimeline("alpha", "2026-09-03", "2026-09-09", null))
      .not.toEqual(qk.usageProjectTimeline("beta", "2026-09-03", "2026-09-09", null));
    expect(qk.usageTimeline("2026-09-03", "2026-09-09", null))
      .toEqual(["usage", "timeline", "2026-09-03", "2026-09-09", null]);
  });
});

describe("buildProjectSessionColumns", () => {
  it("builds 30 continuous day buckets including zero buckets", () => {
    const columns = buildProjectSessionColumns([session("on", "2026-09-03T00:00:00Z")], [], 30, null, now);
    expect(columns).toHaveLength(30);
    expect(columns.map((column) => column.key)).toEqual([...columns].sort((a, b) => a.key.localeCompare(b.key)).map((column) => column.key));
    expect(columns.find((column) => column.key === "2026-09-04")?.values).toEqual({ "claude-code": 0 });
  });

  it("uses week buckets for 90 days", () => {
    const columns = buildProjectSessionColumns([], [], 90, null, now);
    expect(columns.length).toBeLessThanOrEqual(14);
    expect(columns.length).toBeGreaterThan(0);
  });

  it("filters sessions and changed loadout markers by harness and date", () => {
    const columns = buildProjectSessionColumns(
      [
        session("since", "2026-09-03T00:01:00Z"),
        session("before", "2026-09-02T23:59:00Z"),
        session("other", "2026-09-04T00:00:00Z", "codex"),
      ],
      [
        loadout("2026-09-03T12:00:00Z"),
        { ...loadout("2026-09-04T12:00:00Z"), kind: "applied" } as unknown as UsageLoadoutRow,
        loadout("2026-09-04T12:00:00Z", "codex"),
      ],
      7,
      "claude-code",
      now,
    );
    expect(columns.find((column) => column.key === "2026-09-03")?.values).toEqual({ "claude-code": 1 });
    expect(columns.find((column) => column.key === "2026-09-03")?.markers).toHaveLength(1);
    expect(columns.find((column) => column.key === "2026-09-04")?.markers).toBeUndefined();
    expect(columns.flatMap((column) => Object.keys(column.values))).not.toContain("codex");
  });

  it("keeps values keyed by hub harness id and derives activity bucket from the argument", () => {
    const payload: UsageTimelinePayload = {
      schema_version: 1, since: null, until: null, days: [
        { date: "2026-09-07", skills: { lint: 2 }, tools: {} },
        { date: "2026-09-08", skills: { lint: 1 }, tools: {} },
      ], peaks: { unit: "tokens", grid: [] }, harnesses: [],
    };
    expect(buildProjectSessionColumns([session("x", "2026-09-09T00:00:00Z", "claude-code")], [], 7, null, now)[6]?.values)
      .toEqual({ "claude-code": 1 });
    expect(projectActivitySeries(payload, 30, "skills")[0]?.points).toHaveLength(2);
    expect(projectActivitySeries(payload, 90, "skills")[0]?.points).toHaveLength(1);
  });
});
