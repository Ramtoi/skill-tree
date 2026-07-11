import { useCallback } from "react";
import { invoke } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/components/Toast";
import type { EquipTarget } from "@/components/EquipPicker";
import type { Registry, RemoteShow } from "@/types";

interface HubResult {
	success: boolean;
	output: string;
}

async function hubCmd(args: string[]): Promise<void> {
	const res = await invoke<HubResult>("hub_cmd", { args });
	if (!res.success) throw new Error(res.output || "command failed");
}

/** Toggle a skill's direct equip on a project. Optimistic write of the
 *  project's `enabled` array into `["registry"]`, rollback + error toast on
 *  reject, invalidate `["registry"]` + `["syncReport"]` on settle (D5). */
export function useSkillProjectEquip(skillName: string) {
	const toast = useToast();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const project = target.id;
			const prev = queryClient.getQueryData<Registry>(["registry"]);
			// Optimistic
			if (prev) {
				const proj = prev.projects[project];
				if (proj) {
					const enabled = new Set(proj.enabled ?? []);
					if (next === "on") enabled.add(skillName);
					else enabled.delete(skillName);
					queryClient.setQueryData<Registry>(["registry"], {
						...prev,
						projects: {
							...prev.projects,
							[project]: { ...proj, enabled: [...enabled] },
						},
					});
				}
			}
			try {
				await hubCmd(
					next === "on"
						? ["enable", skillName, "--project", project]
						: ["disable", skillName, "--project", project],
				);
				toast.success(
					next === "on"
						? `Equipped ${skillName} on ${project}`
						: `Unequipped ${skillName} from ${project}`,
				);
			} catch (e) {
				if (prev) queryClient.setQueryData(["registry"], prev);
				toast.error("Couldn't equip skill", String(e));
				throw e;
			} finally {
				void queryClient.invalidateQueries({ queryKey: ["registry"] });
				void queryClient.invalidateQueries({ queryKey: ["syncReport"] });
			}
		},
		[skillName, toast],
	);
}

/** Toggle a skill's membership in a bundle (`bundle update --skills`).
 *  Optimistic edit of the bundle's `skills` array. */
export function useSkillBundleEquip(skillName: string) {
	const toast = useToast();
	return useCallback(
		async (target: EquipTarget, next: "on" | "off") => {
			const bundleName = target.id;
			const prev = queryClient.getQueryData<Registry>(["registry"]);
			const bundle = prev?.bundles[bundleName];
			if (!bundle) throw new Error(`unknown bundle ${bundleName}`);
			const skills = (bundle.skills ?? []).filter((s) => s !== skillName);
			if (next === "on") skills.push(skillName);
			if (prev) {
				queryClient.setQueryData<Registry>(["registry"], {
					...prev,
					bundles: {
						...prev.bundles,
						[bundleName]: { ...bundle, skills },
					},
				});
			}
			try {
				await hubCmd(["bundle", "update", bundleName, "--skills", skills.join(",")]);
				toast.success(
					next === "on"
						? `Added ${skillName} to ${bundleName}`
						: `Removed ${skillName} from ${bundleName}`,
				);
			} catch (e) {
				if (prev) queryClient.setQueryData(["registry"], prev);
				toast.error("Couldn't update bundle", String(e));
				throw e;
			} finally {
				void queryClient.invalidateQueries({ queryKey: ["registry"] });
				void queryClient.invalidateQueries({ queryKey: ["syncReport"] });
			}
		},
		[skillName, toast],
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
			const showKey = ["remote", id, "show"];
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
				void queryClient.invalidateQueries({ queryKey: ["remotes"] });
				void queryClient.invalidateQueries({ queryKey: ["remote", id] });
			}
		},
		[id, kind, toast],
	);
}
