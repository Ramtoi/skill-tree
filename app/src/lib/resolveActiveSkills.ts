import type { Bundle, Project, Registry } from "@/types";

// `portable` is intent-only — mechanically it behaves exactly like
// `project-specific`, so it folds into that bucket here.
export function getBundleScope(bundle?: Bundle): "global" | "project-specific" {
	return bundle?.scope === "global" ? "global" : "project-specific";
}

export function resolveActiveSkills(
	project: Project,
	registry: Registry,
): string[] {
	const globalBundleSkills = Object.values(registry.bundles ?? {})
		.filter((bundle) => getBundleScope(bundle) === "global")
		.flatMap((bundle) => bundle.skills ?? []);

	const projectBundleSkills = (project.bundles ?? []).flatMap(
		(bundleName) => registry.bundles[bundleName]?.skills ?? [],
	);

	return Array.from(
		new Set([
			...globalBundleSkills,
			...projectBundleSkills,
			...(project.enabled ?? []),
		]),
	);
}

/** The equip block of a remote or cloud target (`remotes.<id>` / `cloud.<id>`,
 *  or the `hub remote list` row — same fields). */
export interface TargetEquip {
	bundles?: string[];
	enabled?: string[];
	apply_global_bundles?: boolean;
}

/** Names of skills equipped on a remote or cloud target, in the backend's
 *  order (`resolve_remote_skills`): opted-in global bundles, applied bundles,
 *  then `enabled`. Unlike a project, a target inherits `scope: global` bundles
 *  ONLY via `apply_global_bundles`. A name the registry no longer knows is
 *  dropped — `partition_equipped`'s "not in the registry any more" branch —
 *  since nothing can be pushed or zipped for it. `excludeMcp` is the cloud
 *  rule: a local stdio MCP server can never reach a hosted chat product, so
 *  `cloud_targets.py` refuses one. One resolver so the Remotes card and the
 *  navigator row can never show two different counts for the same target. */
export function resolveTargetSkills(
	equip: TargetEquip | undefined,
	registry: Registry | undefined,
	opts?: { excludeMcp?: boolean },
): string[] {
	if (!equip || !registry) return [];
	const bundles = registry.bundles ?? {};
	const candidates: string[] = [];
	if (equip.apply_global_bundles) {
		for (const bundle of Object.values(bundles)) {
			if (getBundleScope(bundle) === "global") {
				candidates.push(...(bundle.skills ?? []));
			}
		}
	}
	for (const name of equip.bundles ?? []) {
		candidates.push(...(bundles[name]?.skills ?? []));
	}
	candidates.push(...(equip.enabled ?? []));

	const out: string[] = [];
	for (const name of new Set(candidates)) {
		const cfg = registry.skills?.[name];
		if (!cfg) continue;
		if (opts?.excludeMcp && cfg.type === "mcp-server") continue;
		out.push(name);
	}
	return out;
}

/** Names of skills provided to `project` via any of its applied bundles
 *  (plus globally-scoped bundles). */
export function bundleProvidedSkills(
	project: Project,
	registry: Registry,
): Set<string> {
	const set = new Set<string>();
	for (const bundle of Object.values(registry.bundles ?? {})) {
		if (getBundleScope(bundle) === "global") {
			(bundle.skills ?? []).forEach((s) => set.add(s));
		}
	}
	for (const bundleName of project.bundles ?? []) {
		(registry.bundles[bundleName]?.skills ?? []).forEach((s) => set.add(s));
	}
	return set;
}

/** How many projects in the registry have `skillName` active. */
export function equippedCount(skillName: string, registry: Registry): number {
	let n = 0;
	for (const project of Object.values(registry.projects ?? {})) {
		if (resolveActiveSkills(project, registry).includes(skillName)) n += 1;
	}
	return n;
}

/** Names of skills equipped on `project` only via `project.enabled` (not via
 *  any applied bundle). */
export function directOnly(project: Project, registry: Registry): string[] {
	const viaBundle = bundleProvidedSkills(project, registry);
	return (project.enabled ?? []).filter((s) => !viaBundle.has(s));
}

/** Bundle names that provide `skillName` to `project` (i.e. the bundle is
 *  applied AND contains the skill). */
export function viaBundles(
	skillName: string,
	project: Project,
	registry: Registry,
): string[] {
	return (project.bundles ?? []).filter((bundleName) =>
		(registry.bundles[bundleName]?.skills ?? []).includes(skillName),
	);
}
