// Wave 4c unit 3 (plans/3.md §2.3/§3.4/§6.5) — the shared "Ship this with a
// skill…" host's pure module. No React import, no IPC of its own: every
// input here is a value the caller already holds (an already-loaded
// `Registry`, a staged `CompanionsDraft`). This is the ONE place the target
// union and eligibility predicate live; `hooks/useShipWith.ts` and
// `components/companions/{SkillPickerModal,ShipWithFlow}.tsx` all import
// from here rather than re-deriving any of it.

import type { SubagentHarness, SubagentScope } from "@/lib/subagents";
import type { CompanionsDraft, ShipsWith } from "@/lib/companions";
import type { Registry, Skill } from "@/types";
import type { RuleKind } from "@/types/permissions";

/** The thing a "Ship with…" action names. `agent` carries `sourceHarness` —
 *  the harness the list the user was looking at was rendering — so the sheet
 *  can populate `CompanionsSetAgent.from` at open time without waiting on
 *  `useCompanionPickerData` (R6) — and `scope`, the scope THAT list was
 *  rendering (`SubagentList`'s own User/Project switcher). §2.3's picker
 *  (`useCompanionPickerData`) only ever resolves USER-scope agents, so a
 *  project-scope agent has no row there to stage into (R1) — `scope` is how
 *  `eligibleShipTargets`/`isShippableTarget` tell the two apart and refuse
 *  the project-scope case instead of silently mis-staging it. `permission`
 *  carries the pattern BY VALUE (captured at click time, R7) plus which rule
 *  list it lives in. */
export type ShipWithTarget =
	| { kind: "hook"; name: string }
	| { kind: "agent"; name: string; sourceHarness: SubagentHarness; scope: SubagentScope }
	| { kind: "permission"; pattern: string; ruleKind: RuleKind };

/** Same union as `ShipWithTarget` — the sheet's `seed` prop is a target that
 *  has decided it wants a home. Kept as a distinct name at the call site
 *  (`CompanionsEditSheetProps.seed`) even though the shape never diverges. */
export type CompanionSeed = ShipWithTarget;

export interface ShipTargetsResult {
	eligible: { name: string; alreadyShips: boolean }[];
	blocked: { count: number; reason: string };
}

/** The one line the picker's footer renders when some registered skill can't
 *  ship companions — matches plans/3.md §2.3's "3 skills can't ship
 *  companions — source-managed or remote-imported" wording verbatim. */
const BLOCKED_REASON = "source-managed or remote-imported";

/** R1(b) — the reason a project-scope agent target can never be staged: the
 *  picker (`useCompanionPickerData`) only ever resolves USER-scope agents,
 *  so a project-scope name has no row to become "already selected", and
 *  `_stage_agent_copy` (server side) is not widened to copy a project-scope
 *  agent in this wave. Shared by `eligibleShipTargets` (so the picker/count
 *  reads this reason too) and `isShippableTarget` (the belt-and-braces
 *  check `ShipWithFlow` and `SubagentList` both call). */
export const AGENT_PROJECT_SCOPE_REASON = "Companions copy user-scope agents only.";

/**
 * Whether a `ShipWithTarget` can ever be staged into SOME skill's
 * `ships_with`, independent of which skill would receive it. Only an agent
 * target can fail this today (R1(b)): a project-scope agent has no row in
 * the user-scope-only picker, so staging it would either leave the sheet
 * with no visible row for it or (worse) have Save copy a same-named but
 * different user-scope agent's file. Every other target kind is always
 * shippable at this level (a hook/permission's own eligibility is purely a
 * per-skill question, handled by `eligibleShipTargets`/`alreadyShips`).
 */
export function isShippableTarget(
	target: ShipWithTarget,
): { ok: true } | { ok: false; reason: string } {
	if (target.kind === "agent" && target.scope === "project") {
		return { ok: false, reason: AGENT_PROJECT_SCOPE_REASON };
	}
	return { ok: true };
}

/**
 * R1 — `Skill.origin` is typed as `SkillOrigin` (an object) in `types.ts`,
 * but a remote-imported skill writes the LITERAL STRING `"remote:<id>"` to
 * the top-level `origin` field (`hub_cli/remote.py:961,1201,1267`) — never
 * `source` (always a local path) and never `origin.source` (the dict the
 * git-source importer writes). The Python side of this exact predicate is
 * `hub_cli/companions.py._remote_quarantine_id` (plan 1 unit
 * `remote-quarantine-fix`); this mirrors it verbatim rather than widening
 * `Registry`/`Skill.origin` in this wave — `tests/fixtures/
 * remote_quarantine_corpus.json` is the ONE fixture both sides read, so the
 * two predicates cannot drift apart. `typeof origin === "string"` narrows
 * past the declared object type on purpose (the mismatch IS the point).
 */
function isRemoteQuarantined(skill: Skill): boolean {
	const origin: unknown = skill.origin;
	return typeof origin === "string" && origin.startsWith("remote:");
}

/** Stricter than the CLI's own external-only refusal (`_refuse_if_unmanageable`
 *  only checks `managed === "external"`): the picker also drops
 *  `managed: "starter"` so it can never offer a skill `set` would bounce for
 *  a different-but-adjacent reason (plans/3.md §2.3 "Eligible skills"). */
function isExternallyManaged(skill: Skill): boolean {
	return skill.managed === "external" || skill.managed === "starter";
}

/** Whether a declared `ships_with` block already carries this exact target —
 *  a hook/agent by name, a rule by `(pattern, kind)`. Used both to mark a
 *  picker row `disabled` (§2.3) and, indirectly, by `applySeed` (a seed
 *  already declared is a no-op add, never a duplicate). */
export function alreadyShips(sw: ShipsWith | undefined, target: ShipWithTarget): boolean {
	if (!sw) return false;
	if (target.kind === "hook") return (sw.hooks ?? []).some((h) => h.name === target.name);
	if (target.kind === "agent") return (sw.agents ?? []).includes(target.name);
	return (sw.permissions?.[target.ruleKind] ?? []).includes(target.pattern);
}

/**
 * Every registered skill eligible to ship the given target, plus a count of
 * how many were dropped and why (§2.3's "Eligible skills"): hub-owned
 * (`type !== "mcp-server"`), editable (`!isExternallyManaged`), and not
 * remote-quarantined. An ineligible skill is never listed — its absence is
 * explained by `blocked`, not silently unexplained.
 */
export function eligibleShipTargets(
	reg: Registry | undefined,
	target: ShipWithTarget,
): ShipTargetsResult {
	const skills = reg?.skills ?? {};
	// R1(b) — a target that can never be staged at all (a project-scope
	// agent) is blocked for EVERY skill, not just some — every skill counts
	// toward `blocked`, and the reason names why, rather than the picker
	// silently showing zero rows with no explanation.
	const shippable = isShippableTarget(target);
	if (!shippable.ok) {
		return { eligible: [], blocked: { count: Object.keys(skills).length, reason: shippable.reason } };
	}
	const eligible: { name: string; alreadyShips: boolean }[] = [];
	let blockedCount = 0;

	for (const [name, skill] of Object.entries(skills)) {
		if (
			skill.type === "mcp-server" ||
			isExternallyManaged(skill) ||
			isRemoteQuarantined(skill)
		) {
			blockedCount += 1;
			continue;
		}
		eligible.push({ name, alreadyShips: alreadyShips(skill.ships_with, target) });
	}

	eligible.sort((a, b) => a.name.localeCompare(b.name));
	return { eligible, blocked: { count: blockedCount, reason: BLOCKED_REASON } };
}

/**
 * Stages a target into a draft (§3.3) — additive only, never a duplicate: a
 * target the draft already carries (or the declared block already had, since
 * `draftFromDeclared` seeds `draft` from it) is a no-op. A hook seed ALWAYS
 * stages a `{ref}` — every row on the Hooks screen is a resolvable library
 * definition, built-ins included (`hooks_model.all_definitions`), which is
 * exactly what a `{ref}` requires.
 */
export function applySeed(draft: CompanionsDraft, seed: CompanionSeed): CompanionsDraft {
	if (seed.kind === "hook") {
		if (draft.hooks.some((h) => h.name === seed.name)) return draft;
		return { ...draft, hooks: [...draft.hooks, { ref: seed.name, name: seed.name }] };
	}
	if (seed.kind === "agent") {
		if (draft.agents.includes(seed.name)) return draft;
		return { ...draft, agents: [...draft.agents, seed.name] };
	}
	if (draft.permissions[seed.ruleKind].includes(seed.pattern)) return draft;
	return {
		...draft,
		permissions: {
			...draft.permissions,
			[seed.ruleKind]: [...draft.permissions[seed.ruleKind], seed.pattern],
		},
	};
}

/** The sheet's `addedFrom` side-map (D9's `from`), pre-filled from a seed so
 *  an agent seed's `CompanionsSetAgent.from` is populated at OPEN time —
 *  never waiting on `useCompanionPickerData` to resolve (R6). Empty for a
 *  hook/permission seed: a hook seed is always a `{ref}` (no copy to stage)
 *  and a permission seed has no analogous "from". */
export function seedAddedFrom(seed: CompanionSeed): Record<string, string> {
	return seed.kind === "agent" ? { [seed.name]: seed.sourceHarness } : {};
}
