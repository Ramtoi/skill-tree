// D8/A21 — `lib/companionRoutes.ts`'s `companionRoute(row, items, ctx)`: agent
// a skill-owned agent points to its canonical source; hook paths are derived
// here; a rule's path is authoritative from I5 and
// is never recomputed. Every returned navigation carries
// `fromNav(skillBackTarget(skill))` so the destination's back arrow returns
// to the skill that shipped this companion (plan 2 §D8, wave A test task).
// Source rows link before native provisioning, so the source editor can report
// a recoverable missing source instead of sending the user to a native list.
// D12/F2 (ships-with wave 3): a hook row links iff `ctx.hookNames` (the
// hooks LIBRARY, `hook_list`) is present and contains the row's name —
// attachment/live state is irrelevant, and a `missing` item vetoes the link
// regardless of `hookNames`.

import { describe, expect, it } from "vitest";
import { companionRoute } from "@/lib/companionRoutes";
import type { CompanionItem, DeclRow } from "@/lib/companions";
import { fromNav, skillBackTarget } from "@/lib/backTarget";

const SKILL = "orchestrate-advanced";
const CTX = { skill: SKILL };

function agentItem(overrides: Partial<CompanionItem> = {}): CompanionItem {
	return {
		kind: "agent",
		name: "orch-implementer",
		harness: "claude-code",
		target: "~/.claude/agents/orch-implementer.md",
		verdict: "will_write",
		scope: "user",
		state: "provisioned",
		...overrides,
	};
}

function hookItem(overrides: Partial<CompanionItem> = {}): CompanionItem {
	return {
		kind: "hook",
		name: "orch-scope-guard",
		harness: "claude-code",
		target: "/repo/.claude/settings.local.json",
		verdict: "will_write",
		activation: "while-running",
		state: "provisioned",
		...overrides,
	};
}

function permissionItem(overrides: Partial<CompanionItem> = {}): CompanionItem {
	return {
		kind: "permission",
		name: "Bash(git push --force:*)",
		harness: "claude-code",
		target: "/repo/.claude/settings.json",
		verdict: "will_write",
		rule_kind: "deny",
		state: "provisioned",
		route: "/project/notes-vault?tab=permissions&focus=deny:Bash(git%20push%20--force:*)",
		...overrides,
	};
}

const EXPECTED_OPTIONS = fromNav(skillBackTarget(SKILL));

describe("companionRoute", () => {
	it("routes an agent row to its canonical source editor", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		const nav = companionRoute(row, agentItem(), CTX);
		expect(nav?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
		expect(nav?.options).toEqual(EXPECTED_OPTIONS);
	});

	it("routes a declared agent before native provisioning", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		expect(companionRoute(row, null, CTX)?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
	});

	it("ignores native harness state when linking the source", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		const items = [
			agentItem({ harness: "codex", state: "unsupported", verdict: "unsupported" }),
			agentItem({ harness: "claude-code", state: "provisioned" }),
		];
		const nav = companionRoute(row, items, CTX);
		expect(nav?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
	});

	it("links even when every native copy is absent", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		const items = [
			agentItem({ harness: "codex", state: "unsupported", verdict: "unsupported" }),
			agentItem({ harness: "claude-code", state: "pending" }),
		];
		expect(companionRoute(row, items, CTX)?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
	});

	it("accepts a single or absent live item", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		expect(companionRoute(row, agentItem({ state: "pending" }), CTX)?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
		expect(companionRoute(row, null, CTX)?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
	});

	it("F9: an agent lit only on a NON-FIRST harness is now routable — items[0] used to hide it", () => {
		const row: DeclRow = { kind: "agent", name: "orch-implementer" };
		const items = [
			agentItem({ harness: "claude-code", state: "absent" }),
			agentItem({ harness: "codex", state: "provisioned" }),
		];
		const nav = companionRoute(row, items, CTX);
		expect(nav?.path).toBe("/skill/orchestrate-advanced/agent/orch-implementer");
	});

	it("percent-encodes an agent name in the query param", () => {
		const row: DeclRow = { kind: "agent", name: "weird name/x" };
		const nav = companionRoute(row, agentItem({ name: "weird name/x" }), CTX);
		expect(nav?.path).toBe(
			`/skill/${encodeURIComponent(SKILL)}/agent/${encodeURIComponent("weird name/x")}`,
		);
	});

	it("routes an inline hook row to the hook editor when the LIBRARY has it (F2)", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: new Set(["orch-scope-guard"]) };
		const nav = companionRoute(row, hookItem(), ctx);
		expect(nav?.path).toBe("/hook/orch-scope-guard");
		expect(nav?.options).toEqual(EXPECTED_OPTIONS);
	});

	it("routes a ref hook row the SAME way as an inline one (A18/C5 — keyed on name) when the library has it", () => {
		const row: DeclRow = { kind: "hook", name: "orch-unit-brief", isRef: true };
		const ctx = { skill: SKILL, hookNames: new Set(["orch-unit-brief"]) };
		const nav = companionRoute(row, hookItem({ name: "orch-unit-brief" }), ctx);
		expect(nav?.path).toBe("/hook/orch-unit-brief");
		expect(nav?.options).toEqual(EXPECTED_OPTIONS);
	});

	it("F2: a library hook is routable pre-attach — every item absent, name IS in hookNames", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: new Set(["orch-scope-guard"]) };
		const nav = companionRoute(row, hookItem({ state: "absent" }), ctx);
		expect(nav?.path).toBe("/hook/orch-scope-guard");
	});

	it("F2: a hook row NOT named in hookNames is unroutable, even with every item absent (the reported bug)", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: new Set(["some-other-hook"]) };
		expect(companionRoute(row, hookItem({ state: "absent" }), ctx)).toBeNull();
	});

	it("F2: hookNames undefined (an unresolved hook_list read) — no link we can't vouch for", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		expect(companionRoute(row, hookItem({ state: "absent" }), CTX)).toBeNull();
	});

	it("F2: a hook row with a missing item is never routable regardless of hookNames", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: new Set(["orch-scope-guard"]) };
		expect(companionRoute(row, hookItem({ state: "missing" }), ctx)).toBeNull();
	});

	it("S4: hookNames === null (the library read FAILED, not merely pending) falls back to the item's own CLI route", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: null };
		const nav = companionRoute(row, hookItem({ route: "/hook/orch-scope-guard" }), ctx);
		expect(nav?.path).toBe("/hook/orch-scope-guard");
		expect(nav?.options).toEqual(EXPECTED_OPTIONS);
	});

	it("S4: hookNames === null with no route on the item at all — still no link to invent", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: null };
		expect(companionRoute(row, hookItem({ route: null }), ctx)).toBeNull();
	});

	it("S4: hookNames === null still defers to a missing item (never routable regardless)", () => {
		const row: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ctx = { skill: SKILL, hookNames: null };
		expect(
			companionRoute(row, hookItem({ state: "missing", route: "/hook/orch-scope-guard" }), ctx),
		).toBeNull();
	});

	it("uses a permission row's item.route VERBATIM (A21) — never recomputed", () => {
		const row: DeclRow = {
			kind: "permission",
			name: "Bash(git push --force:*)",
			rule_kind: "deny",
		};
		const item = permissionItem();
		const nav = companionRoute(row, item, CTX);
		expect(nav?.path).toBe(item.route);
		expect(nav?.options).toEqual(EXPECTED_OPTIONS);
	});

	it("returns null for a permission row with no route (defensive fallback)", () => {
		const row: DeclRow = {
			kind: "permission",
			name: "Bash(gh pr merge:*)",
			rule_kind: "ask",
		};
		const nav = companionRoute(row, permissionItem({ route: null }), CTX);
		expect(nav).toBeNull();
	});

	it("returns null for a permission row with no item at all", () => {
		const row: DeclRow = {
			kind: "permission",
			name: "Bash(gh pr merge:*)",
			rule_kind: "ask",
		};
		expect(companionRoute(row, null, CTX)).toBeNull();
	});

	it("every returned nav carries fromNav(skillBackTarget(skill)) — agent, hook, rule alike", () => {
		const agentRow: DeclRow = { kind: "agent", name: "orch-implementer" };
		const hookRow: DeclRow = { kind: "hook", name: "orch-scope-guard" };
		const ruleRow: DeclRow = {
			kind: "permission",
			name: "Bash(git push --force:*)",
			rule_kind: "deny",
		};
		for (const [row, item] of [
			[agentRow, agentItem()],
			[hookRow, hookItem()],
			[ruleRow, permissionItem()],
		] as const) {
			const nav = companionRoute(row, item, {
				skill: "some-other-skill",
				hookNames: new Set(["orch-scope-guard"]),
			});
			expect(nav?.options).toEqual(fromNav(skillBackTarget("some-other-skill")));
		}
	});
});
