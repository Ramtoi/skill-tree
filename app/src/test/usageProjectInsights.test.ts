import { describe, expect, it } from "vitest";
import { idleSkills, scanAgeDays, usageAsOfLine, usageSummary } from "@/lib/usageProjectInsights";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";

const payload = {
  ok: true,
  project: "alpha",
  window: 30,
  findings_window: 30,
  last_scan_at: "2026-09-01T00:00:00Z",
  harnesses: ["claude-code"],
  footprint: { "claude-code": { observed: 100, parts: [], unknown: [], bytes_total: 0, approx_tokens: 0 } },
  utilization: [],
  subagents: [],
  outcomes: {
    sessions: 6,
    cache_hit_ratio: 0.8,
    steering_per_session: 0,
    subagent_token_share: 0,
    activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 0, skill: 0, external: 0 },
    thinking_text_share: 0,
    files_read_median: 0,
    files_edited_median: 0,
    verified_edit_session_ratio: 0,
    editing_sessions: 0,
    unverified_editing_sessions: 0,
    tracked_files: null,
    median_all_projects: { activity: { read: 0, edit: 0, verify: 0, operate: 0, delegate: 0, skill: 0, external: 0 } },
  },
  findings: [{ id: "idle", kind: "idle", project: "alpha", observation: "", numbers: { skills: ["quiet"] }, moves: [], review: { area: "loadout", project: "alpha", highlight: [] } }],
  sessions: [],
  not_analysed: [],
} satisfies UsageProjectPayload;

describe("usageProjectInsights", () => {
  it("reads idle skills from the finding and preserves token fields", () => {
    expect(idleSkills(payload)).toEqual(["quiet"]);
    expect(idleSkills({ ...payload, findings: [] })).toEqual([]);
    expect(usageSummary(payload, null)).toMatchObject({ loadoutTokens: null, observedTokens: 100, sessions: 6 });
  });

  it("formats scan freshness and the seven-day stale boundary", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    expect(scanAgeDays("2026-09-01T00:00:00Z", now)).toBe(7);
    expect(usageAsOfLine(null, now)).toBe("usage never scanned");
    expect(usageAsOfLine("2026-09-01T00:00:00Z", now)).toBe("usage as of 7d ago");
    expect(usageAsOfLine("2026-08-31T00:00:00Z", now)).toContain("may be out of date");
  });
});
