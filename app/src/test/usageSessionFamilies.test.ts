import { describe, expect, it } from "vitest";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { groupCodexSessions } from "@/screens/usage/usageSessionFamilies";
function row(id: string, total: number, parentSessionId?: string): UsageSessionRow & { parentSessionId?: string } {
  return { id, period: id, harnessId: "codex", harnessName: "Codex", title: id,
    parentSessionId, models: [id], tokens: { input: total - 1, output: 1, cacheRead: 0, cacheCreation: 0, total },
    estimatedCost: { usd: total / 100, label: "Estimated API-equivalent cost" }, toolCalls: 1,
    lastActivity: id === "grandchild" ? "2026-09-16T12:00:00Z" : "2026-09-15T12:00:00Z" };
}
describe("Codex session families", () => {
  it("counts a root, child and grandchild once regardless of discovery order", () => {
    const root = row("root", 100), child = row("child", 40, "root"), grandchild = row("grandchild", 20, "child");
    const families = groupCodexSessions([grandchild, root, child, child]);
    expect(families).toHaveLength(1);
    expect(families[0].session).toMatchObject({ id: "root", tokens: { total: 160 }, toolCalls: 3, lastActivity: grandchild.lastActivity });
    expect(families[0].session.estimatedCost.usd).toBeCloseTo(1.6);
    expect(families[0].members.map((r) => r.id).sort()).toEqual(["child", "grandchild", "root"]);
    expect(root.tokens.total).toBe(100);
    expect(groupCodexSessions([root, child, grandchild])[0].session).toEqual(families[0].session);
  });
  it("uses a filtered-out parent for context without adding its usage", () => {
    const root = row("root", 100), child = row("child", 40, "root");
    const [family] = groupCodexSessions([child], [root, child]);
    expect(family.session.id).toBe("root");
    expect(family.session.tokens.total).toBe(40);
    expect(family.contextOnly).toBe(true);
    expect(family.members).toEqual([child]);
  });
  it("keeps missing-parent and cyclic rows accessible and leaves Claude alone", () => {
    const orphan = row("orphan", 40, "missing"), a = row("a", 20, "b"), b = row("b", 30, "a");
    const claude = { ...row("root", 100), harnessId: "claude", harnessName: "Claude Code" };
    const families = groupCodexSessions([orphan, a, b, claude]);
    expect(families).toHaveLength(4);
    expect(families.find((f) => f.session.id === "orphan")?.parentUnavailable).toBe(true);
    expect(families.reduce((n, f) => n + f.session.tokens.total, 0)).toBe(190);
    expect(families.find((f) => f.session.harnessId === "claude")?.session).toBe(claude);
  });
});

it("merges model and tool breakdowns without mutating the measured rows", () => {
  const root = row("root", 100), child = row("child", 40, "root");
  root.modelBreakdown = [{ modelName: "shared", tokens: { ...root.tokens }, estimatedCost: { ...root.estimatedCost } }];
  child.modelBreakdown = [{ modelName: "shared", tokens: { ...child.tokens }, estimatedCost: { ...child.estimatedCost } }];
  root.toolBreakdown = [{ name: "Read", count: 2 }];
  child.toolBreakdown = [{ name: "Read", count: 3 }, { name: "Write", count: 1 }];
  const [family] = groupCodexSessions([root, child]);
  expect(family.session.modelBreakdown).toMatchObject([{ modelName: "shared", tokens: { total: 140 }, estimatedCost: { usd: 1.4 } }]);
  expect(family.session.toolBreakdown).toEqual([{ name: "Read", count: 5 }, { name: "Write", count: 1 }]);
  expect(root.modelBreakdown[0].tokens.total).toBe(100);
});
