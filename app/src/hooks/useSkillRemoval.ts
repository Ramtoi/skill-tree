import { useCallback, useEffect, useRef, useState } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { useToast } from "@/components/Toast";
import { trackProcess } from "@/lib/trackProcess";
import { runHubCmd } from "@/lib/hubCmd";
import { errText } from "@/lib/hubWrite";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import { REGISTRY_WRITE_KEYS } from "@/lib/invalidate";
import { plural } from "@/lib/plural";
import type { Registry } from "@/types";

/** Every holder that would lose this skill — the blast radius a Forget/Archive
 *  confirm lists, and the same shape `DroppedSkill.equipped` carries from the
 *  CLI. Computed from the registry with the same selectors the rest of the
 *  app already uses (`resolveActiveSkills`'s building blocks), not a fresh
 *  guess, so a confirm dialog and the navigator can never disagree about what
 *  is equipped. */
export interface SkillRemovalRefs {
	projects: string[];
	bundles: string[];
	remotes: string[];
	cloud: string[];
}

function emptyRefs(): SkillRemovalRefs {
	return { projects: [], bundles: [], remotes: [], cloud: [] };
}

/** Every reference site for one skill name: bundles that list it, projects
 *  that enable it directly (or override its invocation), remotes/cloud
 *  targets that equip it individually. Mirrors the CLI's
 *  `_skill_reference_sites` closely enough that a Forget confirm never shows a
 *  different picture than `hub source dropped`'s own `equipped` block. */
export function skillReferenceSites(
	name: string,
	registry: Registry | undefined,
): SkillRemovalRefs {
	if (!registry) return emptyRefs();
	const projects = new Set<string>();
	for (const [pname, p] of Object.entries(registry.projects ?? {})) {
		if ((p.enabled ?? []).includes(name)) projects.add(pname);
		if (Object.prototype.hasOwnProperty.call(p.invocation_overrides ?? {}, name)) {
			projects.add(pname);
		}
	}
	const bundles = Object.entries(registry.bundles ?? {})
		.filter(([, b]) => (b.skills ?? []).includes(name))
		.map(([id]) => id);
	const remotes = Object.entries(registry.remotes ?? {})
		.filter(([, r]) => (r.enabled ?? []).includes(name))
		.map(([id]) => id);
	const cloud = Object.entries(registry.cloud ?? {})
		.filter(([, c]) => (c.enabled ?? []).includes(name))
		.map(([id]) => id);
	return {
		projects: [...projects].sort(),
		bundles: bundles.sort(),
		remotes: remotes.sort(),
		cloud: cloud.sort(),
	};
}

function unionRefs(list: SkillRemovalRefs[]): SkillRemovalRefs {
	const out = emptyRefs();
	for (const refs of list) {
		for (const key of ["projects", "bundles", "remotes", "cloud"] as const) {
			for (const v of refs[key]) if (!out[key].includes(v)) out[key].push(v);
		}
	}
	return out;
}

export function hasRefs(refs: SkillRemovalRefs): boolean {
	return (
		refs.projects.length + refs.bundles.length + refs.remotes.length + refs.cloud.length > 0
	);
}

/** Grouped, non-empty lines for a confirm dialog's blast-radius block. Plain
 *  data (no JSX) so this stays a `.ts` module — every caller renders its own
 *  `<ul>`, keeping the copy in one place without importing React here. */
export function blastRadiusLines(
	refs: SkillRemovalRefs,
): Array<{ label: string; items: string[] }> {
	return [
		{ label: "Projects", items: refs.projects },
		{ label: "Bundles", items: refs.bundles },
		{ label: "Remotes", items: refs.remotes },
		{ label: "Cloud", items: refs.cloud },
	].filter((r) => r.items.length > 0);
}

export type RemovalVerb = "archive" | "forget";

export interface PendingRemoval {
	names: string[];
	verb: RemovalVerb;
	refs: SkillRemovalRefs;
}

/** `Archive "x"?` / `Forget 3 skills?` — the confirm dialog's title. */
export function removalConfirmTitle(pending: PendingRemoval): string {
	const verbLabel = pending.verb === "forget" ? "Forget" : "Archive";
	return pending.names.length === 1
		? `${verbLabel} "${pending.names[0]}"?`
		: `${verbLabel} ${pending.names.length} skills?`;
}

/** The confirm dialog's lead sentence(s) — what happens and that it undoes.
 *  A bare blast-radius list ("Projects: example-app") answers "what does this
 *  touch" but not "what is about to happen to it", which is the actual
 *  question a destructive-sounding button raises. Single-skill form states
 *  the reference counts up front; the batch form names every skill (the
 *  per-skill counts already ride the blast-radius list below). */
export function removalConfirmBody(pending: PendingRemoval): string {
	const single = pending.names.length === 1;
	if (single) {
		const name = pending.names[0];
		const gerund = pending.verb === "forget" ? "Forgetting" : "Archiving";
		const projectsN = pending.refs.projects.length;
		const bundlesN = pending.refs.bundles.length;
		const projects = `${projectsN} ${plural(projectsN, "project")}`;
		const bundles = `${bundlesN} ${plural(bundlesN, "bundle")}`;
		return (
			`${name} is equipped in ${projects} and ${bundles}. ${gerund} removes it from ` +
			`the registry and un-equips it everywhere below. You can undo from the toast for 7 seconds.`
		);
	}
	const verbed = pending.verb === "forget" ? "forgotten" : "archived";
	return `${pending.names.length} skills will be ${verbed}: ${pending.names.join(", ")}.`;
}

/** "Forgetting…" / "Archiving…" — the LoadingButton label for the control
 *  that actually started the in-flight action (the header primary or the
 *  danger-zone button), so the page-lock has a legible cue beyond the
 *  process card and the status bar. */
export function removalLoadingLabel(verb: RemovalVerb): string {
	return verb === "forget" ? "Forgetting…" : "Archiving…";
}

export interface SkillRemovalOptions {
	/** Force the confirm dialog even when nothing references the skill(s) —
	 *  the Sources card's "Forget all N" uses this so a batch action always
	 *  gets a beat of consent, not just an equipped one. */
	alwaysConfirm?: boolean;
	/** "archive" for a normal skill, "forget" for a dropped-upstream one —
	 *  only changes the wording (decision: same flow, different name). */
	verb?: RemovalVerb;
	/** Runs once `hub unarchive` for THIS action has landed. Callers that need
	 *  to navigate somewhere after an undo (but only if the user is still
	 *  where the archive left them) do that check here, not in the hook. */
	onUndone?: () => void;
}

const VERB_TEXT: Record<
	RemovalVerb,
	{
		presentSingle: (n: string) => string;
		presentMulti: (c: number) => string;
		pastSingle: (n: string) => string;
		pastMulti: (c: number) => string;
	}
> = {
	archive: {
		presentSingle: (n) => `Archiving ${n}`,
		presentMulti: (c) => `Archiving ${c} skills`,
		pastSingle: (n) => `Archived ${n}`,
		pastMulti: (c) => `Archived ${c} skills`,
	},
	forget: {
		presentSingle: (n) => `Forgetting ${n}`,
		presentMulti: (c) => `Forgetting ${c} skills`,
		pastSingle: (n) => `Forgot ${n}`,
		pastMulti: (c) => `Forgot ${c} skills`,
	},
};

export interface UseSkillRemoval {
	/** Runs the flow end to end: confirm (when warranted) → process card →
	 *  undo-able toast. Resolves `true` once the archive landed, `false` on
	 *  cancel or failure — callers use this to decide whether to navigate
	 *  away. */
	archive: (names: string[], opts?: SkillRemovalOptions) => Promise<boolean>;
	/** True from confirm-accept (or immediately, when nothing needed
	 *  confirming) until the CLI settles. Callers lock their page on it. */
	busy: boolean;
	/** Set while a confirm is pending; `null` otherwise. Render a
	 *  `<ConfirmDialog>` off this — `confirm`/`cancel` resolve it. */
	pending: PendingRemoval | null;
	confirm: () => void;
	cancel: () => void;
}

/**
 * The ONE archive/forget flow (spec: "Dropped-upstream skills + honest
 * archive"). Every caller — the skill editor's danger zone, its dropped-
 * upstream header/banner, the Sources card's per-row and "Forget all" — goes
 * through this so the confirm gating, the busy lock, the process card and the
 * undo toast never diverge between call sites.
 */
export function useSkillRemoval(): UseSkillRemoval {
	const { data: registry } = useRegistry();
	const runUndoable = useUndoableAction();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState<PendingRemoval | null>(null);
	const resolverRef = useRef<((v: boolean) => void) | null>(null);

	// A screen can unmount while its confirm is still pending (a chord/route
	// change out from under it) — without this, `archive()`'s awaited promise
	// never settles and the caller hangs forever mid-navigation.
	useEffect(() => {
		return () => {
			resolverRef.current?.(false);
			resolverRef.current = null;
		};
	}, []);

	const cancel = useCallback(() => {
		resolverRef.current?.(false);
		resolverRef.current = null;
		setPending(null);
	}, []);

	const confirm = useCallback(() => {
		resolverRef.current?.(true);
		resolverRef.current = null;
		setPending(null);
	}, []);

	const archive = useCallback(
		async (names: string[], opts: SkillRemovalOptions = {}): Promise<boolean> => {
			if (names.length === 0) return false;
			const verb = opts.verb ?? "archive";
			const refs = unionRefs(names.map((n) => skillReferenceSites(n, registry)));

			// A batch ALWAYS confirms (per-name blast radius is easy to lose track
			// of once more than one name is on the line), even if the caller forgot
			// `alwaysConfirm` and none of the names happen to be referenced anywhere.
			if (hasRefs(refs) || opts.alwaysConfirm || names.length > 1) {
				const ok = await new Promise<boolean>((resolve) => {
					resolverRef.current = resolve;
					setPending({ names, verb, refs });
				});
				if (!ok) return false;
			}

			setBusy(true);
			const texts = VERB_TEXT[verb];
			const single = names.length === 1;
			try {
				await runUndoable({
					do: () =>
						trackProcess(
							{
								title: single ? texts.presentSingle(names[0]) : texts.presentMulti(names.length),
								kind: "fs",
							},
							() => runHubCmd(["archive", ...names, "--json"]),
						),
					undo: async () => {
						const res = await runHubCmd(["unarchive", ...names, "--json"]);
						// A sidecar can go missing, a name can already be back in the
						// registry — `unarchive` reports those as SKIPS, not a failure
						// (it only fails when NOTHING restored, which `runHubCmd` would
						// already have thrown on). A partial restore is news the plain
						// "undone" silence would otherwise hide.
						try {
							const payload = parseCliJson<{
								restored?: string[];
								skipped?: Array<{ name: string; reason: string }>;
							}>(res.output);
							const skipped = payload.skipped ?? [];
							if (skipped.length > 0) {
								const restoredCount = payload.restored?.length ?? 0;
								const detail = skipped.map((s) => `${s.name} (${s.reason})`).join(", ");
								toast.info(`Restored ${restoredCount} of ${names.length}`, detail);
							}
						} catch {
							/* the undo itself landed (no throw above) even if this
							   payload doesn't parse — never block on it */
						}
						opts.onUndone?.();
					},
					label: single ? texts.pastSingle(names[0]) : texts.pastMulti(names.length),
					invalidate: [...REGISTRY_WRITE_KEYS, qk.sources()],
				});
				return true;
			} catch (err) {
				toast.error(
					verb === "forget" ? "Couldn't forget" : "Couldn't archive",
					errText(err),
				);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[registry, runUndoable, toast],
	);

	return { archive, busy, pending, confirm, cancel };
}
