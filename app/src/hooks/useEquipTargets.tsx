import type { ReactNode } from "react";
import type { Registry, RemoteShow } from "@/types";
import { getBundleScope, viaBundles } from "@/lib/resolveActiveSkills";
import { shortenPath } from "@/lib/shortenPath";
import type { EquipState, EquipTarget } from "@/components/EquipPicker";

/** Projects a bundle is applied to (explicit `bundles:` membership OR, for a
 *  global bundle, every project). Drives the blast-radius hint. */
export function bundleAppliedCount(
	bundleName: string,
	registry: Registry,
): number {
	const bundle = registry.bundles[bundleName];
	if (!bundle) return 0;
	if (getBundleScope(bundle) === "global") {
		return Object.keys(registry.projects ?? {}).length;
	}
	return Object.values(registry.projects ?? {}).filter((p) =>
		(p.bundles ?? []).includes(bundleName),
	).length;
}

function bundleLink(name: string): { name: string; href: string } {
	return { name, href: `/bundle/${encodeURIComponent(name)}` };
}

/** skill → projects targets. Direct `enabled` toggles; via-bundle is read-only
 *  and links to the providing bundle(s) (D3). */
export function buildSkillProjectTargets(
	skillName: string,
	registry: Registry,
): EquipTarget[] {
	return Object.entries(registry.projects ?? {}).map(([projName, proj]) => {
		const directOn = (proj.enabled ?? []).includes(skillName);
		const providers = viaBundles(skillName, proj, registry);
		const globalProviders = Object.entries(registry.bundles ?? {})
			.filter(
				([, b]) =>
					getBundleScope(b) === "global" && (b.skills ?? []).includes(skillName),
			)
			.map(([bn]) => bn);
		const allProviders = Array.from(
			new Set([...providers, ...globalProviders]),
		);
		let state: EquipState;
		if (directOn) state = "on";
		else if (allProviders.length > 0) state = "via-bundle";
		else state = "off";
		const meta: ReactNode = (
			<span className="equip-path text-dim">{shortenPath(proj.path)}</span>
		);
		return {
			id: projName,
			name: projName,
			state,
			meta,
			providedBy:
				state === "via-bundle" ? allProviders.map(bundleLink) : undefined,
			blastRadius:
				directOn && allProviders.length > 0
					? `Also provided by ${allProviders.join(", ")} — turning the direct edge off leaves it equipped via bundle`
					: undefined,
		};
	});
}

/** skill → bundles targets. Membership toggles; blast-radius names how many
 *  projects the bundle is applied to. */
export function buildSkillBundleTargets(
	skillName: string,
	registry: Registry,
): EquipTarget[] {
	return Object.entries(registry.bundles ?? {}).map(([bn, b]) => {
		const on = (b.skills ?? []).includes(skillName);
		const applied = bundleAppliedCount(bn, registry);
		return {
			id: bn,
			name: bn,
			glyph: <span className="equip-emoji">{b.icon ?? "📦"}</span>,
			state: on ? "on" : "off",
			meta: `${(b.skills ?? []).length} skills · ${getBundleScope(b)}`,
			blastRadius:
				applied > 0
					? `${applied} project${applied === 1 ? "" : "s"} use this bundle`
					: "not applied to any project yet",
		};
	});
}

/** Skills provided to a remote via one of its equipped bundles (for via-bundle
 *  rendering of the remote skill picker). */
function remoteBundleProvided(
	remote: Pick<RemoteShow, "bundles">,
	registry: Registry,
): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const bn of remote.bundles ?? []) {
		for (const sn of registry.bundles[bn]?.skills ?? []) {
			map.set(sn, [...(map.get(sn) ?? []), bn]);
		}
	}
	return map;
}

/** remote → bundles targets. */
export function buildRemoteBundleTargets(
	remote: Pick<RemoteShow, "bundles">,
	registry: Registry,
): EquipTarget[] {
	return Object.entries(registry.bundles ?? {}).map(([bn, b]) => {
		const on = (remote.bundles ?? []).includes(bn);
		return {
			id: bn,
			name: bn,
			glyph: <span className="equip-emoji">{b.icon ?? "📦"}</span>,
			state: on ? "on" : "off",
			meta: `${(b.skills ?? []).length} skills`,
		};
	});
}

/** remote → skills targets. A skill provided by an equipped bundle shows
 *  via-bundle (read-only) and links to that bundle. */
export function buildRemoteSkillTargets(
	remote: Pick<RemoteShow, "bundles" | "enabled">,
	registry: Registry,
): EquipTarget[] {
	const provided = remoteBundleProvided(remote, registry);
	return Object.entries(registry.skills ?? {})
		.filter(([, s]) => s.type !== "mcp-server")
		.map(([sn, s]) => {
			const directOn = (remote.enabled ?? []).includes(sn);
			const providers = provided.get(sn) ?? [];
			let state: EquipState;
			if (directOn) state = "on";
			else if (providers.length > 0) state = "via-bundle";
			else state = "off";
			return {
				id: sn,
				name: sn,
				state,
				meta: s.scope,
				providedBy: state === "via-bundle" ? providers.map(bundleLink) : undefined,
			};
		});
}
