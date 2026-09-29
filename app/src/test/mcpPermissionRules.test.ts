import { describe, expect, it } from "vitest";
import { applyMcpPermissionChanges, mcpChoiceBlocker, mcpToolTarget, projectMcpDecision } from "@/lib/mcpPermissionRules";
import type { NormalizedPermissions, Rule } from "@/types/permissions";

const base = (): NormalizedPermissions => ({ allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null, approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [] });

describe("MCP permission rules", () => {
	it("constructs exact targets and preserves affinity", () => {
		const next = applyMcpPermissionChanges(base(), [{ server: "calendar", tool: "create", decision: "allow", harnesses: ["claude-code"] }]);
		expect(next.allow[0]).toMatchObject({ pattern: mcpToolTarget("calendar", "create"), harnesses: ["claude-code"] });
	});
	it("treats legacy broad aliases as the same target", () => {
		const p: NormalizedPermissions = { ...base(), deny: [{ pattern: "mcp__calendar__*", kind: "deny", harnesses: null } satisfies Rule] };
		expect(projectMcpDecision(p, "calendar").decision).toBe("deny");
		const next = applyMcpPermissionChanges(p, [{ server: "calendar", decision: "default" }]);
		expect(next.deny).toHaveLength(0);
	});
	it("does not collapse affinity-ambiguous exact rules", () => {
		const p: NormalizedPermissions = { ...base(), allow: [{ pattern: "mcp__calendar__create", kind: "allow", harnesses: ["claude-code"] }, { pattern: "mcp__calendar__create", kind: "allow", harnesses: ["codex"] }] };
		expect(projectMcpDecision(p, "calendar", "create").ambiguous).toBe(true);
	});
});

it("preserves unrelated settings, exact exceptions, and existing affinity on broad changes", () => {
 const p = { ...base(), extras: { custom: true }, sandbox_mode: "workspace-write", allow: [{ pattern: "mcp__calendar__read", kind: "allow" as const }], ask: [{ pattern: "mcp__calendar__*", kind: "ask" as const, harnesses: ["pi"] }] };
 const result = applyMcpPermissionChanges(p, [{ server: "calendar", decision: "deny", harnesses: ["claude-code"] }]);
 expect(result.allow).toEqual(p.allow);
 expect(result.extras).toEqual(p.extras);
 expect(result.sandbox_mode).toBe(p.sandbox_mode);
 expect(result.deny).toEqual([{ pattern: "mcp__calendar", kind: "deny", harnesses: ["pi"] }]);
 expect(p.ask).toHaveLength(1);
});
it("removes both broad aliases without removing exact tools or inherited rules", () => {
 const p = { ...base(), ask: [
  { pattern: "mcp__calendar", kind: "ask" as const, origin: "project" as const },
  { pattern: "mcp__calendar__*", kind: "ask" as const, origin: "project" as const },
  { pattern: "mcp__calendar__read", kind: "ask" as const, origin: "project" as const },
  { pattern: "mcp__calendar", kind: "ask" as const, origin: "global" as const },
 ] };
 const result = applyMcpPermissionChanges(p, [{ server: "calendar", decision: "default" }], "project");
 expect(result.ask).toEqual([p.ask[2], p.ask[3]]);
});
it("rejects a batch atomically if any exact target has conflicting decisions", () => {
 const p = { ...base(), allow: [{ pattern: "mcp__calendar__read", kind: "allow" as const }], deny: [{ pattern: "mcp__calendar__read", kind: "deny" as const }] };
 const original = structuredClone(p);
 expect(() => applyMcpPermissionChanges(p, [{ server: "other", decision: "ask" }, { server: "calendar", tool: "read", decision: "default" }])).toThrow("separate rules");
 expect(p).toEqual(original);
});
it.each(["", "foo__bar", "foo*", "foo/bar", "foo bar"])("rejects malformed exact names: %s", (name) => {
 expect(() => mcpToolTarget("calendar", name)).toThrow();
 expect(() => mcpToolTarget(name, "read")).toThrow();
});

it("blocks narrower Allow under a staged broad Ask, but permits changing the broad rule itself", () => {
 const p = applyMcpPermissionChanges(base(), [{ server: "calendar", decision: "ask" }]);
 expect(mcpChoiceBlocker(p, [], { server: "calendar", tool: "read", decision: "allow" }, {}, "global")).toContain("Ask rule mcp__calendar");
 expect(mcpChoiceBlocker(p, [], { server: "calendar", decision: "allow" }, {}, "global")).toBeNull();
});
it("checks inherited exact and broad rules across both project tiers", () => {
 const global = applyMcpPermissionChanges(base(), [{ server: "calendar", tool: "read", decision: "deny" }]);
 const shared = applyMcpPermissionChanges(base(), [{ server: "calendar", decision: "ask" }], "project");
 expect(mcpChoiceBlocker(base(), [global, shared], { server: "calendar", tool: "read", decision: "allow" }, {}, "project")).toContain("Deny rule");
 expect(mcpChoiceBlocker(base(), [global, shared], { server: "calendar", tool: "write", decision: "allow" }, {}, "project")).toContain("Ask rule");
 expect(mcpChoiceBlocker(base(), [global, shared], { server: "calendar", decision: "default" }, {}, "project")).toBeNull();
});
it("does not call disjoint coding-tool affinities a conflict", () => {
 const p = applyMcpPermissionChanges(base(), [{ server: "calendar", tool: "read", decision: "allow", harnesses: ["pi"] }]);
 const context = applyMcpPermissionChanges(base(), [{ server: "calendar", decision: "deny", harnesses: ["claude-code"] }]);
 expect(mcpChoiceBlocker(p, [context], { server: "calendar", tool: "read", decision: "allow" }, {}, "project")).toBeNull();
});
