// Affinity-mismatch surfacing (M8 / D6). A skill's optional `harnesses:` affinity
// narrows which agents it syncs to. When that affinity has an EMPTY intersection
// with a project's effective harnesses, the skill is equipped but "won't sync
// here" — a real, actionable mismatch (badged `warn`), not a transitional state.
//
// Pure registry math, client-computable — no backend. The per-project sync-report
// `affinity_skips` banner is the evidence-based truth (what sync actually skipped);
// this predicate is its predictive twin (what will skip), and they agree post-sync.

import type { Project, Registry, Skill } from "@/types";

/** A project's effective harnesses:
 *    (harnesses_global ∪ project.harnesses) ∩ installed.
 *  `installed` is the set of installed harness ids (from the harness list the app
 *  already loads). When `installed` is omitted the raw union is returned. */
export function effectiveHarnesses(
	project: Project,
	registry: Registry,
	installed?: string[],
): string[] {
	const union = new Set<string>([
		...(registry.harnesses_global ?? []),
		...(project.harnesses ?? []),
	]);
	if (!installed) return [...union];
	const installedSet = new Set(installed);
	return [...union].filter((id) => installedSet.has(id));
}

/**
 * "Won't sync here" predicate (frozen contract):
 *   mismatch ⇔ the skill declares a non-empty `harnesses:` affinity
 *              AND that affinity has an empty intersection with the project's
 *              effective harnesses.
 * A skill with no affinity (undefined / empty) is never a mismatch — it targets
 * every effective harness.
 */
export function affinityMismatch(
	skill: Skill,
	project: Project,
	registry: Registry,
	installed?: string[],
): boolean {
	const declared = skill.harnesses;
	if (!declared || declared.length === 0) return false;
	const eff = effectiveHarnesses(project, registry, installed);
	return declared.every((h) => !eff.includes(h));
}
