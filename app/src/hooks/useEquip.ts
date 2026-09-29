import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/components/Toast";
import { runHubCmd } from "@/lib/hubCmd";
import { errText, parseCmdPayload } from "@/lib/hubWrite";
import { removalSentence, type DisablePayload } from "@/lib/companions";
import { useCompanionGate, equipErrorToast, CompanionProvisionError } from "@/hooks/useCompanionGate";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import { type RefsGuardrailDeps, type RefsGuardrailToastInput } from "@/lib/missingRefs";
import { syncReportQueryFn } from "@/hooks/useSyncReport";
import type { EquipTarget } from "@/components/EquipPicker";
import type { Registry, RemoteShow } from "@/types";
import { bundleAppliedProjects } from "@/hooks/useEquipTargets";
import { plural } from "@/lib/plural";
import { useProjectLoadoutFeedback } from "@/hooks/useProjectLoadoutFeedback";
import { UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";

/** "Now on a, b, c, +N more" — name up to 3 projects, then fold the rest into
 *  a count (R4's toast body). */
function namesList(names: string[]): string {
	const shown = names.slice(0, 3);
	const extra = names.length - shown.length;
	return extra > 0 ? `${shown.join(", ")}, +${extra} more` : shown.join(", ");
}

/** The shape `useToast().push` (and, adapted, the store's `pushToast` action)
 *  both satisfy — a raw toast pusher a call site hands to
 *  `buildRefsGuardrailDeps` without pulling in `useToast`'s hook-only return
 *  type. `action.onClick` accepts `void | Promise<void>` because the wrapped
 *  action below is async; the real `Toast.action.onClick` is typed `() =>
 *  void`, and TypeScript allows any return type at a void-expecting call
 *  site, so no cast is needed at either boundary. */
export type ToastPush = (t: {
	kind?: "info" | "success" | "error";
	title: string;
	body?: string;
	duration?: number;
	action?: { label: string; onClick: () => void | Promise<void> };
}) => void;

/**
 * `hub enable <skill> --project <p> --with-refs --skill-only` — the ONE place
 * a ref-equip runs `enable` directly, bypassing the companion consequence
 * gate (I1/A4, plan 2 §Approach "Six call sites, one gate"): a toast action
 * must never raise a modal, so a referenced skill that itself ships
 * companions equips skill-only regardless (a documented gap, not a bug —
 * bulk-equipping references is a convenience action, not a full equip).
 * `companionGateGuard.test.ts` allowlists this file for exactly this call. */
export async function equipSkillRefsOnly(skill: string, project: string): Promise<void> {
	await runHubCmd(["enable", skill, "--project", project, "--with-refs", "--skill-only"]);
}

/** Equip exactly one reviewed reference, without adding its own references
 * or provisioning companions. The review dialog discloses this scope. */
export async function equipReferencedSkillOnly(skill: string, project: string): Promise<void> {
	await runHubCmd(["enable", skill, "--project", project, "--skill-only"]);
}

/**
 * The `RefsGuardrailDeps` shared by every equip call site
 * (`useSkillProjectEquip`, `useBundleProjectEquip`, `paletteVerbs`' "Equip
 * skill…" — plans/3-project.md §2). `readEnv` is the fresh-report fetch grill
 * B1 requires (never a cache peek); `equipRefs` is one `hub enable <skill>
 * --project <p> --with-refs --skill-only` per flagged skill (grill B2;
 * `--skill-only`, above). `toast.push` wraps
 * the guardrail's `Equip N` action in `trackProcess` (so the StatusBar reads
 * "Equipping N on <project>…" for the duration) + one `invalidateRegistry()`
 * + one result toast, so N flagged skills still read as ONE busy state and
 * ONE outcome, whether the action's loop runs once or several times.
 */
export function buildRefsGuardrailDeps(
	push: ToastPush,
	project: string,
	client: QueryClient = queryClient,
): RefsGuardrailDeps {
	return {
		toast: {
			push: (t: RefsGuardrailToastInput) => {
				const action = t.action;
				if (!action) {
					push(t);
					return;
				}
				const count = action.label.match(/\d+/)?.[0] ?? "";
				push({
					...t,
					action: {
						label: action.label,
						onClick: async () => {
							try {
								await trackProcess(
									{ title: `Equipping ${count} on ${project}…`, kind: "local" },
									() => Promise.resolve(action.onClick()),
								);
								await invalidateRegistry();
							} catch (err) {
								await invalidateRegistry();
								push({ kind: "error", title: "Couldn't equip references", body: errText(err) });
							}
						},
					},
				});
			},
		},
		equipRefs: equipSkillRefsOnly,
		readEnv: () =>
			client.fetchQuery({ queryKey: qk.syncReport(), queryFn: syncReportQueryFn, staleTime: 0 }),
	};
}

/** Toggle a skill's direct equip on a project. Optimistic write of the
 *  project's `enabled` array into `["registry"]`, rollback + error toast on
 *  reject, invalidate `["registry"]` + `["syncReport"]` on settle (D5). On a
 *  successful equip, announces PR1's `missing_refs` finding for this skill
 *  (plans/3-project.md §2) — never on an unequip. */
export function useSkillProjectEquip(skillName: string) {
	const toast = useToast();
	const feedback = useProjectLoadoutFeedback();
	// Destructured to a plain identifier rather than closing over `gate` (the
	// object `useCompanionGate()` returns) — `gate.equip` as a dependency-array
	// member expression is what `react-hooks/exhaustive-deps` was flagging;
	// `equip` itself is `equipWithGate`, a stable module-level reference, so
	// this changes nothing at runtime.
	const { equip } = useCompanionGate();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const project = target.id;
			const prev = queryClient.getQueryData<Registry>(qk.registry());
			// Optimistic
			if (prev) {
				const proj = prev.projects[project];
				if (proj) {
					const enabled = new Set(proj.enabled ?? []);
					if (next === "on") enabled.add(skillName);
					else enabled.delete(skillName);
					queryClient.setQueryData<Registry>(qk.registry(), {
						...prev,
						projects: {
							...prev.projects,
							[project]: { ...proj, enabled: [...enabled] },
						},
					});
				}
			}
			try {
				// Only `enable` can gate on a consequence dialog (I1) — `disable`
				// removes whatever the ledger says this skill provisioned here with
				// no extra flag needed. S-3: `--json` so the toast can say WHAT went
				// (companion agent files/hooks/rules), the same as `ProjectWorkspace`'s
				// unequip — a connections-panel toggle silently deleting user-scope
				// agent files with no acknowledgement is a real gap, not a cosmetic one.
				if (next === "on") {
					await feedback({
						project,
						title: `Equipped ${skillName} on ${project}`,
						write: () => equip(skillName, project),
						undo: () => runHubCmd(["disable", skillName, "--project", project]).then(() => undefined),
						skillNames: [skillName],
						readRefs: buildRefsGuardrailDeps(toast.push, project).readEnv,
						equipRefs: equipSkillRefsOnly,
						duration: UNDO_TOAST_DURATION_MS,
					});
				} else {
					let payload: DisablePayload | undefined;
					await feedback({
						project,
						title: `Unequipped ${skillName} from ${project}`,
						write: async () => {
							const res = await runHubCmd(["disable", skillName, "--project", project, "--json"]);
							payload = parseCmdPayload<DisablePayload>(res.output) ?? undefined;
						},
						undo: () => equip(skillName, project).then(() => undefined),
						appendDetail: () => payload ? removalSentence(payload) : undefined,
						duration: UNDO_TOAST_DURATION_MS,
					});
				}
			} catch (e) {
				// A `CompanionProvisionError` means the equip LANDED (call 1 saved
				// the registry) and only the companions failed — restoring `prev`
				// would flick the row back to unequipped until the refetch lands.
				if (prev && !(e instanceof CompanionProvisionError)) {
					queryClient.setQueryData(qk.registry(), prev);
				}
				const failure = equipErrorToast(e);
				toast.error(failure.title, failure.body);
				throw e;
			} finally {
				void invalidateRegistry();
			}
		},
		[skillName, toast, equip, feedback],
	);
}

/** Toggle a skill's membership in a bundle (`bundle update --skills`).
 *  Optimistic edit of the bundle's `skills` array. */
export function useSkillBundleEquip(skillName: string) {
	const toast = useToast();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const bundleName = target.id;
			const prev = queryClient.getQueryData<Registry>(qk.registry());
			const bundle = prev?.bundles[bundleName];
			if (!bundle) throw new Error(`unknown bundle ${bundleName}`);
			const skills = (bundle.skills ?? []).filter((s) => s !== skillName);
			if (next === "on") skills.push(skillName);
			if (prev) {
				queryClient.setQueryData<Registry>(qk.registry(), {
					...prev,
					bundles: {
						...prev.bundles,
						[bundleName]: { ...bundle, skills },
					},
				});
			}
			try {
				await runHubCmd(["bundle", "update", bundleName, "--skills", skills.join(",")]);
				// R4 — the toast body carries the CONSEQUENCE, not just the ack: which
				// projects this bundle is already live on (or, off, how many synced).
				// Computed from `prev` — a skill's membership doesn't change which
				// projects apply the bundle, so this can never disagree with the
				// picker row's own `blastRadius` (same source, `bundleAppliedCount`).
				// `prev` is guaranteed here: `bundle` above threw when it was undefined.
				const appliedProjects = bundleAppliedProjects(bundleName, prev!);
				const body =
					next === "on"
						? appliedProjects.length > 0
							? `Now on ${namesList(appliedProjects)}`
							: `No project applies ${bundleName} yet`
						: appliedProjects.length > 0
							? `Synced to ${appliedProjects.length} ${plural(appliedProjects.length, "project")}`
							: `No project applies ${bundleName}`;
				toast.success(
					next === "on"
						? `Added ${skillName} to ${bundleName}`
						: `Removed ${skillName} from ${bundleName}`,
					body,
				);
			} catch (e) {
				if (prev) queryClient.setQueryData(qk.registry(), prev);
				toast.error("Couldn't update bundle", errText(e));
				throw e;
			} finally {
				void invalidateRegistry();
			}
		},
		[skillName, toast],
	);
}

/** Toggle a bundle's application to a project (`hub bundle apply/remove`).
 *  Same optimistic + rollback + toast contract as `useSkillProjectEquip` — the
 *  APPLIED TO picker on the bundle editor writes immediately (no undo, unlike
 *  the SKILLS picker's staged membership), so a mis-click needs the same
 *  rollback-on-reject safety net every other equip control has (M6). On a
 *  successful apply, announces `missing_refs` once for every flagged skill in
 *  the bundle (one aggregate toast, `subject: bundleName`), never on removal.
 *
 *  Context-resolved (NOT the module-level `@/lib/queryClient` singleton the
 *  other hooks in this file use): its one caller, the bundle lens's Applied-to
 *  picker, sits beside `useBundleMembership`/`BundleLens`'s own writes, which
 *  are already context-resolved so a test's isolated `QueryClient` sees them
 *  — this hook needs to read and write the SAME cache. */
export function useBundleProjectEquip(bundleName: string) {
	const toast = useToast();
	const feedback = useProjectLoadoutFeedback();
	const queryClient = useQueryClient();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const project = target.id;
			const prev = queryClient.getQueryData<Registry>(qk.registry());
			if (prev) {
				const proj = prev.projects[project];
				if (proj) {
					const bundles = new Set(proj.bundles ?? []);
					if (next === "on") bundles.add(bundleName);
					else bundles.delete(bundleName);
					queryClient.setQueryData<Registry>(qk.registry(), {
						...prev,
						projects: {
							...prev.projects,
							[project]: { ...proj, bundles: [...bundles] },
						},
					});
				}
			}
			try {
				const bundleSkills = prev?.bundles[bundleName]?.skills ?? [];
				await feedback({
					project,
					title: next === "on" ? `Applied ${bundleName} to ${project}` : `Removed ${bundleName} from ${project}`,
					subject: bundleName,
					write: () => runHubCmd(next === "on" ? ["bundle", "apply", bundleName, "--project", project] : ["bundle", "remove", bundleName, "--project", project]).then(() => undefined),
					skillNames: next === "on" ? bundleSkills : undefined,
					readRefs: buildRefsGuardrailDeps(toast.push, project, queryClient).readEnv,
					equipRefs: equipSkillRefsOnly,
				});
			} catch (e) {
				if (prev) queryClient.setQueryData(qk.registry(), prev);
				toast.error("Couldn't update bundle", errText(e));
				throw e;
			} finally {
				void invalidateRegistry(queryClient);
			}
		},
		[bundleName, toast, queryClient, feedback],
	);
}

interface RemoteEquipResult {
	ok: boolean;
	bundles: string[];
	enabled: string[];
}

/** Toggle a bundle/skill on a remote (`remote_equip`). Registry-only — no box
 *  push. Optimistic edit of the remote's show payload; invalidate
 *  `["remotes"]` + `["remote", id]` on settle (D5/D8). */
export function useRemoteEquip(id: string, kind: "bundle" | "skill") {
	const toast = useToast();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const name = target.id;
			const showKey = qk.remotes.show(id);
			const prev = queryClient.getQueryData<RemoteShow>(showKey);
			if (prev) {
				const field = kind === "bundle" ? "bundles" : "enabled";
				const set = new Set(prev[field] ?? []);
				if (next === "on") set.add(name);
				else set.delete(name);
				queryClient.setQueryData<RemoteShow>(showKey, {
					...prev,
					[field]: [...set],
				});
			}
			try {
				const res = await invoke<RemoteEquipResult>("remote_equip", {
					id,
					kind,
					name,
					on: next === "on",
				});
				if (!res.ok) throw new Error("remote equip failed");
				toast.success(
					next === "on"
						? `Equipped ${name} on ${id}`
						: `Unequipped ${name} from ${id}`,
					"Reconciled on next sync",
				);
			} catch (e) {
				if (prev) queryClient.setQueryData(showKey, prev);
				toast.error("Couldn't equip on remote", String(e));
				throw e;
			} finally {
				void queryClient.invalidateQueries({ queryKey: qk.remotes.list() });
				void queryClient.invalidateQueries({ queryKey: qk.remotes.all(id) });
			}
		},
		[id, kind, toast],
	);
}
