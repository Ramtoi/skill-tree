// Wave 4c unit 3 (plans/3.md §5 Unit 3, §7 T13) — pure-function coverage for
// the shared "Ship this with a skill…" host's eligibility/seed module. No
// mounting, no IPC: every case is a plain `Registry`/`ShipsWith` value.

import { describe, it, expect } from "vitest";
import {
	alreadyShips,
	applySeed,
	eligibleShipTargets,
	isShippableTarget,
	seedAddedFrom,
	type ShipWithTarget,
} from "@/lib/shipWith";
import type { CompanionsDraft, ShipsWith } from "@/lib/companions";
import type { Registry, Skill } from "@/types";
// The SAME fixture `hub_cli/companions.py._remote_quarantine_id` is tested
// against (plan 1 unit `remote-quarantine-fix`) — R1/R2: both sides read
// this one corpus so the TS mirror and the Python original cannot drift
// apart without a test noticing on either side.
import remoteQuarantineCorpus from "../../../tests/fixtures/remote_quarantine_corpus.json";

const CORPUS = (
	remoteQuarantineCorpus as {
		cases: {
			case: string;
			origin: unknown;
			remote_id: string | null;
		}[];
	}
).cases;

function baseSkill(overrides: Partial<Skill> = {}): Skill {
	return {
		version: "1.0.0",
		description: "A test skill.",
		source: "~/skill-hub/skills/x",
		type: "claude-skill",
		scope: "portable",
		upstream: null,
		managed: "local",
		...overrides,
	};
}

function registryOf(skills: Record<string, Skill>): Registry {
	return {
		version: "1",
		skills,
		projects: {},
		bundles: {},
	};
}

const HOOK_TARGET: ShipWithTarget = { kind: "hook", name: "scope-guard" };
const AGENT_TARGET: ShipWithTarget = {
	kind: "agent",
	name: "orch-implementer",
	sourceHarness: "claude-code",
	scope: "user",
};
const PERMISSION_TARGET: ShipWithTarget = {
	kind: "permission",
	pattern: "Bash(git push --force:*)",
	ruleKind: "deny",
};

describe("eligibleShipTargets", () => {
	it("lists a plain hub-owned skill as eligible", () => {
		const reg = registryOf({ orchestrate: baseSkill() });
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible).toEqual([{ name: "orchestrate", alreadyShips: false }]);
		expect(result.blocked.count).toBe(0);
	});

	it("drops an mcp-server skill and counts it as blocked", () => {
		const reg = registryOf({ "fs-mcp": baseSkill({ type: "mcp-server" }) });
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible).toEqual([]);
		expect(result.blocked.count).toBe(1);
		expect(result.blocked.reason).toMatch(/source-managed|remote-imported/);
	});

	it("drops managed:external and managed:starter skills alike", () => {
		const reg = registryOf({
			external: baseSkill({ managed: "external" }),
			starter: baseSkill({ managed: "starter" }),
			local: baseSkill(),
		});
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible.map((s) => s.name)).toEqual(["local"]);
		expect(result.blocked.count).toBe(2);
	});

	it("drops a remote-quarantined skill via BOTH origin shapes the registry can carry (R1)", () => {
		// The object shape (`SkillOrigin`, `types.ts`) is what a git-source
		// import writes — never quarantined by itself.
		const objectOriginSkill = baseSkill({
			origin: { source: "org-skills", source_type: "git" },
		});
		// The string shape (`"remote:<id>"`) is what `hub_cli/remote.py` writes
		// to the SAME top-level field — TS's declared `SkillOrigin` type says
		// this cannot happen; the corpus below proves the predicate handles it
		// anyway (R1: `Skill.origin` is typed as an object, but the remote
		// importer writes the plain string).
		const reg = registryOf({
			"from-source": objectOriginSkill,
			"from-remote": baseSkill({ origin: "remote:hermes-main" as unknown as Skill["origin"] }),
			plain: baseSkill(),
		});
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible.map((s) => s.name).sort()).toEqual(["from-source", "plain"]);
		expect(result.blocked.count).toBe(1);
	});

	it("matches the shared remote_quarantine_corpus.json case by case", () => {
		for (const row of CORPUS) {
			const reg = registryOf({
				subject: baseSkill({ origin: row.origin as unknown as Skill["origin"] }),
			});
			const result = eligibleShipTargets(reg, HOOK_TARGET);
			const shouldBeQuarantined = row.remote_id !== null;
			expect(result.eligible.length === 0).toBe(shouldBeQuarantined);
			expect(result.blocked.count).toBe(shouldBeQuarantined ? 1 : 0);
		}
	});

	it("marks alreadyShips true for a hook the skill's ships_with already declares by name", () => {
		const sw: ShipsWith = { hooks: [{ ref: "scope-guard", name: "scope-guard" }] };
		const reg = registryOf({ orchestrate: baseSkill({ ships_with: sw }) });
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible).toEqual([{ name: "orchestrate", alreadyShips: true }]);
	});

	it("marks alreadyShips true for an agent by name and a rule by (pattern, kind)", () => {
		const sw: ShipsWith = {
			agents: ["orch-implementer"],
			permissions: { deny: ["Bash(git push --force:*)"] },
		};
		const reg = registryOf({ orchestrate: baseSkill({ ships_with: sw }) });
		expect(eligibleShipTargets(reg, AGENT_TARGET).eligible[0].alreadyShips).toBe(true);
		expect(eligibleShipTargets(reg, PERMISSION_TARGET).eligible[0].alreadyShips).toBe(true);
		// A different kind at the same pattern does NOT match (allow vs deny).
		const allowTarget: ShipWithTarget = { ...PERMISSION_TARGET, ruleKind: "allow" };
		expect(eligibleShipTargets(reg, allowTarget).eligible[0].alreadyShips).toBe(false);
	});

	it("sorts eligible rows alphabetically regardless of registry key order", () => {
		const reg = registryOf({ zeta: baseSkill(), alpha: baseSkill(), mu: baseSkill() });
		const result = eligibleShipTargets(reg, HOOK_TARGET);
		expect(result.eligible.map((s) => s.name)).toEqual(["alpha", "mu", "zeta"]);
	});

	it("degrades to empty/blocked-0 for an undefined registry rather than throwing", () => {
		const result = eligibleShipTargets(undefined, HOOK_TARGET);
		expect(result).toEqual({ eligible: [], blocked: { count: 0, reason: expect.any(String) } });
	});

	it("R1(b) — a project-scope agent target is blocked for EVERY skill, not silently zero", () => {
		const reg = registryOf({ orchestrate: baseSkill(), other: baseSkill() });
		const projectAgent: ShipWithTarget = { ...AGENT_TARGET, scope: "project" };
		const result = eligibleShipTargets(reg, projectAgent);
		expect(result.eligible).toEqual([]);
		expect(result.blocked.count).toBe(2);
		expect(result.blocked.reason).toBe("Companions copy user-scope agents only.");
	});
});

describe("isShippableTarget (R1(b))", () => {
	it("is ok for a user-scope agent", () => {
		expect(isShippableTarget(AGENT_TARGET)).toEqual({ ok: true });
	});

	it("refuses a project-scope agent, naming why", () => {
		const projectAgent: ShipWithTarget = { ...AGENT_TARGET, scope: "project" };
		expect(isShippableTarget(projectAgent)).toEqual({
			ok: false,
			reason: "Companions copy user-scope agents only.",
		});
	});

	it("is always ok for a hook or permission target", () => {
		expect(isShippableTarget(HOOK_TARGET)).toEqual({ ok: true });
		expect(isShippableTarget(PERMISSION_TARGET)).toEqual({ ok: true });
	});
});

describe("alreadyShips", () => {
	it("is false for an undefined declared block", () => {
		expect(alreadyShips(undefined, HOOK_TARGET)).toBe(false);
	});
});

function emptyDraft(): CompanionsDraft {
	return { agents: [], hooks: [], permissions: { allow: [], deny: [], ask: [] } };
}

describe("applySeed", () => {
	it("stages a hook seed as a {ref} entry", () => {
		const next = applySeed(emptyDraft(), HOOK_TARGET);
		expect(next.hooks).toEqual([{ ref: "scope-guard", name: "scope-guard" }]);
	});

	it("is a no-op when the draft already carries the hook (never a duplicate)", () => {
		const draft: CompanionsDraft = {
			...emptyDraft(),
			hooks: [{ ref: "scope-guard", name: "scope-guard" }],
		};
		const next = applySeed(draft, HOOK_TARGET);
		expect(next.hooks).toHaveLength(1);
		expect(next).toBe(draft); // identity-stable no-op, not just value-equal
	});

	it("stages an agent seed by name and leaves permissions/hooks untouched", () => {
		const next = applySeed(emptyDraft(), AGENT_TARGET);
		expect(next.agents).toEqual(["orch-implementer"]);
		expect(next.hooks).toEqual([]);
	});

	it("stages a permission seed into the right rule-kind bucket", () => {
		const next = applySeed(emptyDraft(), PERMISSION_TARGET);
		expect(next.permissions.deny).toEqual(["Bash(git push --force:*)"]);
		expect(next.permissions.allow).toEqual([]);
	});

	it("does not duplicate an already-declared permission", () => {
		const draft: CompanionsDraft = {
			...emptyDraft(),
			permissions: { allow: [], deny: ["Bash(git push --force:*)"], ask: [] },
		};
		const next = applySeed(draft, PERMISSION_TARGET);
		expect(next.permissions.deny).toEqual(["Bash(git push --force:*)"]);
	});
});

describe("seedAddedFrom", () => {
	it("carries the agent seed's sourceHarness", () => {
		expect(seedAddedFrom(AGENT_TARGET)).toEqual({ "orch-implementer": "claude-code" });
	});

	it("is empty for a hook or permission seed — neither has a 'from' to copy", () => {
		expect(seedAddedFrom(HOOK_TARGET)).toEqual({});
		expect(seedAddedFrom(PERMISSION_TARGET)).toEqual({});
	});
});
