import { describe, expect, it } from "vitest";
import {
  changedLoadoutTicks,
  dailySessionCounts,
  formatProspectiveSkillLine,
  isFreshUsage,
} from "@/lib/usageGuidance";

describe("usage guidance helpers", () => {
  it("formats the harness-relative prospective skill line", () => {
    expect(formatProspectiveSkillLine({ name: "brainstorm", description: "brainstorm ideas", projectSkillsDir: ".claude/skills" })).toBe(
      "brainstorm: brainstorm ideas (.claude/skills/brainstorm)",
    );
  });

  it("uses an injected clock for seven-day freshness", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(isFreshUsage("2026-09-01T12:00:00Z", now)).toBe(true);
    expect(isFreshUsage("2026-08-31T11:59:59Z", now)).toBe(false);
    expect(isFreshUsage("2026-09-08T12:00:00Z", now)).toBe(false);
  });

  it("groups sessions by day and keeps changed ticks only", () => {
    expect(dailySessionCounts([{ started_at: "2026-09-07T01:00:00Z" }, { started_at: "2026-09-07T02:00:00Z" }])).toEqual({ "2026-09-07": 2 });
    const rows = [
      { at: "a", harness: "claude-code", hash: "a", skill_count: 1, mcp_count: 0, kind: "initial" as const },
      { at: "b", harness: "claude-code", hash: "b", skill_count: 2, mcp_count: 0, kind: "changed" as const },
    ];
    expect(changedLoadoutTicks(rows)).toEqual([rows[1]]);
  });
});
