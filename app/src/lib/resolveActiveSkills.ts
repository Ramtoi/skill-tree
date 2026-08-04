import type { Bundle, Project, Registry } from "@/types";

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
