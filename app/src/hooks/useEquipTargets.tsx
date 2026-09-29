import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Project, Registry } from "@/types";
import { getBundleScope, viaBundles } from "@/lib/resolveActiveSkills";
import { shortenPath } from "@/lib/shortenPath";
import { bundleBackTarget, fromNav } from "@/lib/backTarget";
import { clickSink } from "@/lib/pressable";
import { plural } from "@/lib/plural";
import { KindMark, ScopeBadge } from "@/components/Tag";
import type { EquipState, EquipTarget } from "@/components/EquipPicker";

/** Projects a bundle is applied to — explicit `bundles:` membership, or, for a
 *  global bundle, every project. `bundleAppliedCount` below is a thin wrapper
 *  over this so the two can never disagree (the picker row's `blastRadius`
 *  and, per R4, the equip toast body both read from here). */
export function bundleAppliedProjects(
	bundleName: string,
	registry: Registry,
): string[] {
	const bundle = registry.bundles[bundleName];
	if (!bundle) return [];
	if (getBundleScope(bundle) === "global") {
		return Object.keys(registry.projects ?? {});
	}
	return Object.entries(registry.projects ?? {})
		.filter(([, p]) => (p.bundles ?? []).includes(bundleName))
		.map(([name]) => name);
}

/** Count of projects a bundle is applied to. Drives the blast-radius hint. */
export function bundleAppliedCount(
	bundleName: string,
	registry: Registry,
): number {
	return bundleAppliedProjects(bundleName, registry).length;
}

function bundleLink(name: string): { name: string; href: string } {
	return { name, href: `/bundle/${encodeURIComponent(name)}` };
}

/** Count label for a bundle's skill membership — singular for exactly one so a
 *  one-skill bundle reads "1 skill", not "1 skills" (B4b). */
function pluralizeSkills(n: number): string {
	return `${n} skill${n === 1 ? "" : "s"}`;
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
			meta: (
				<span className="equip-meta">
					{pluralizeSkills((b.skills ?? []).length)} · {getBundleScope(b)}
				</span>
			),
			blastRadius:
				applied > 0
					? `${applied} project${applied === 1 ? "" : "s"} use this bundle`
					: "not applied to any project yet",
			// A bundle that FOLLOWS a source has its membership reconciled by
			// `hub source sync` — the CLI refuses `--skills`, so don't offer it.
			disabledReason: b.source
				? `${bn} follows ${b.source}; its skills are managed by that source.`
				: undefined,
		};
	});
}

/** Of `bundleSkills`, which would actually deactivate for `proj` if this
 *  bundle stopped providing them — i.e. neither directly enabled, nor
 *  provided by another applied bundle, nor globally provided. Same rule the
 *  delete confirm's blast radius already computes across every applied
 *  project (`BundleLens.tsx`'s `deactivations`); this is the per-project,
 *  per-row version APPLIED TO's `blastRadius` reuses (m4). */
function bundleSkillsLostBy(
	proj: Project,
	bundleName: string,
	bundleSkills: string[],
	registry: Registry,
): string[] {
	const globallyProvided = new Set<string>();
	for (const b of Object.values(registry.bundles ?? {})) {
		if (getBundleScope(b) === "global") {
			for (const s of b.skills ?? []) globallyProvided.add(s);
		}
	}
	return bundleSkills.filter((s) => {
		if (proj.enabled?.includes(s)) return false;
		if (globallyProvided.has(s)) return false;
		return !viaBundles(s, proj, registry).some((bn) => bn !== bundleName);
	});
}

/** bundle → projects targets (APPLIED TO). `hub bundle apply/remove` writes the
 *  registry AND runs `_auto_sync()` immediately (no staging, no undo) — the row's
 *  `blastRadius` says so; the section around this picker carries the matching
 *  "applies on click" summary. Only meaningful for a project-specific bundle: a
 *  global bundle is applied to every project by construction and the CLI
 *  refuses `bundle apply --project` on one, so the caller skips this list
 *  entirely for `scope: global` (B1/M6).
 *
 *  Toggling the row is the frequent job, but the picker deleted the bundle
 *  editor's only route TO a project — restore it as an "open" link in the
 *  `meta` slot, wrapped in `clickSink()` so the link click doesn't also fire
 *  the row's own toggle (the same pattern `EquipPicker` already uses for its
 *  checkbox column). The link carries the bundle as referrer, same as every
 *  other outgoing edge from this screen (M2).
 *
 *  `blastRadius` names the size of the change instead of repeating the same
 *  constant sentence on every row in both directions (m4): turning ON says
 *  how many skills land there now; turning OFF says how many would actually
 *  be LOST (a skill kept alive by another edge — direct, another bundle, or
 *  global — never counts against the reader). */
export function buildBundleProjectTargets(
	bundleName: string,
	registry: Registry,
): EquipTarget[] {
	const referrerState = fromNav(bundleBackTarget(bundleName)).state;
	const bundleSkills = registry.bundles[bundleName]?.skills ?? [];
	return Object.entries(registry.projects ?? {}).map(([projName, proj]) => {
		const on = (proj.bundles ?? []).includes(bundleName);
		let blastRadius: string;
		if (on) {
			const lost = bundleSkillsLostBy(proj, bundleName, bundleSkills, registry);
			blastRadius =
				lost.length > 0
					? `Removes ${lost.length} ${plural(lost.length, "skill")} from ${projName} unless another edge keeps them`
					: `${projName} keeps every skill here via another edge`;
		} else {
			blastRadius = `${bundleSkills.length} ${plural(bundleSkills.length, "skill")} → ${projName}, synced now`;
		}
		return {
			id: projName,
			name: projName,
			state: on ? "on" : "off",
			meta: (
				<span className="equip-meta" {...clickSink()}>
					<Link
						to={`/project/${encodeURIComponent(projName)}`}
						state={referrerState}
						className="equip-provider-link"
					>
						open
					</Link>
				</span>
			),
			blastRadius,
		};
	});
}

/** bundle → skills targets (the SKILLS section). ONE ungrouped list over the
 *  whole registry — `EquipPicker` has no group concept (B1), so three
 *  scope-grouped pickers would fragment the filter and split the roving
 *  index. Scope rides per row as a `ScopeBadge` glyph instead. `picked` is the
 *  DRAFT membership (staged until ⌘S), not the saved `bundle.skills` — the
 *  caller passes its local state so a toggle here is instant, no round trip.
 *  A bundle that follows a source locks every row via `EquipPicker`'s
 *  list-level `lockedReason` (the caller's job, not this builder's — the fact
 *  is stated once, not once per target). */
export function buildBundleSkillTargets(
	picked: string[],
	registry: Registry,
): EquipTarget[] {
	const scopeOrder: Record<string, number> = {
		global: 0,
		portable: 1,
		"project-specific": 2,
	};
	return Object.entries(registry.skills ?? {})
		.sort(([an, a], [bn, b]) => {
			const sa = scopeOrder[a.scope] ?? 3;
			const sb = scopeOrder[b.scope] ?? 3;
			return sa - sb || an.localeCompare(bn);
		})
		.map(([name, s]) => ({
			id: name,
			name,
			glyph: <ScopeBadge scope={s.scope} />,
			state: picked.includes(name) ? "on" : "off",
			// R2/R3: the mark, never a word — an amber MCP tag would also read as
			// direct-equip provenance, which R5 reserves for the checkbox alone.
			meta: <KindMark kind={s.type} />,
		}));
}

/**
 * What an off-project surface has equipped. Remotes and cloud targets share the
 * project equip model (`bundles` ∪ `enabled`) all the way down to
 * `resolve_project_skills`, so the builders below take this structural shape
 * rather than one surface's payload type — that is the whole generalization the
 * cloud screens needed.
 */
export interface EquipSelection {
	bundles?: string[];
	enabled?: string[];
}

/** Skills provided to a surface via one of its equipped bundles (for via-bundle
 *  rendering of the skill picker). */
function remoteBundleProvided(
	remote: Pick<EquipSelection, "bundles">,
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

/** remote → bundles targets. `meta` is a real `.equip-meta` span, not a bare
 *  string (m3/M3): `ResourceRow` renders `{meta}` with no wrapper, so a bare
 *  string became an anonymous flex item matching neither `.equip-meta` nor
 *  `.equip-path` — no `flex: 1 1 0`, no ellipsis — the moment the inline
 *  row's un-capped name rule (M3) made room for a long name to actually need
 *  it. Wrapping it is what makes that CSS rule safe here too. */
export function buildRemoteBundleTargets(
	remote: Pick<EquipSelection, "bundles">,
	registry: Registry,
): EquipTarget[] {
	return Object.entries(registry.bundles ?? {}).map(([bn, b]) => {
		const on = (remote.bundles ?? []).includes(bn);
		return {
			id: bn,
			name: bn,
			glyph: <span className="equip-emoji">{b.icon ?? "📦"}</span>,
			state: on ? "on" : "off",
			meta: <span className="equip-meta">{pluralizeSkills((b.skills ?? []).length)}</span>,
		};
	});
}

/** remote → skills targets. A skill provided by an equipped bundle shows
 *  via-bundle (read-only) and links to that bundle. `meta` wrapped in
 *  `.equip-meta` for the same reason as `buildRemoteBundleTargets` above —
 *  the `via-bundle` case is unaffected since `EquipPicker` replaces `meta`
 *  entirely with its own "via …" line for that state. */
export function buildRemoteSkillTargets(
	remote: EquipSelection,
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
				meta: <span className="equip-meta">{s.scope}</span>,
				providedBy: state === "via-bundle" ? providers.map(bundleLink) : undefined,
			};
		});
}

/** cloud target → bundles / skills targets. A cloud target equips exactly like a
 *  remote (`resolve_cloud_skills` delegates to `resolve_remote_skills`), so the
 *  builders above apply verbatim; these aliases exist so call sites read in the
 *  domain they are in. */
export const buildCloudBundleTargets = buildRemoteBundleTargets;
export const buildCloudSkillTargets = buildRemoteSkillTargets;
