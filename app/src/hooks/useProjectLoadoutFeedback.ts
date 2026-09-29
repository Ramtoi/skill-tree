import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/Toast";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry, invalidateUsageComposition } from "@/lib/invalidate";
import { footprintTokens } from "@/lib/footprintTokens";
import { fetchUsageFootprint } from "@/hooks/useUsageAnalytics";
import { collectMissingRefs, type RefsGuardrailDeps } from "@/lib/missingRefs";
import { refsSentence } from "@/lib/missingRefs";
import { plural } from "@/lib/plural";
import { publishUsageLoadoutDelta } from "@/store/usageLoadoutDelta";
import type { UsageFootprintPayload } from "@/features/usage/usageAnalyticsTypes";

export interface ProjectLoadoutMutation {
	project?: string;
	write: () => Promise<void>;
	undo?: () => Promise<void>;
	title: string;
	subject?: string;
	skillNames?: string[];
	readRefs?: RefsGuardrailDeps["readEnv"];
	equipRefs?: (skill: string, project: string) => Promise<void>;
	/** Optional already-composed detail rows. */
	details?: string[];
	/** Optional consequence row appended when the three-row cap allows it. */
	appendDetail?: string | (() => string | undefined);
	duration?: number;
}

function footprintTotal(payload: UsageFootprintPayload | undefined): number | null {
	if (!payload) return null;
	return Object.keys(payload.harnesses).reduce((sum, harness) =>
		sum + (footprintTokens(payload, harness)?.total ?? 0), 0);
}

function harnessTotals(payload: UsageFootprintPayload | undefined): Map<string, number> {
	return new Map(Object.keys(payload?.harnesses ?? {}).map((key) => [
		key,
		footprintTokens(payload, key)?.total ?? 0,
	]));
}

function costDetails(
	before: UsageFootprintPayload | undefined,
	after: UsageFootprintPayload | undefined,
	): string[] {
	const beforeTotals = harnessTotals(before);
	const afterTotals = harnessTotals(after);
	const keys = [...new Set([...beforeTotals.keys(), ...afterTotals.keys()])].sort();
	const rows = keys.flatMap((key) => {
		const change = (afterTotals.get(key) ?? 0) - (beforeTotals.get(key) ?? 0);
		if (change > 0) return [`adds ~${change} tokens to every ${key} session`];
		if (change < 0) return [`removes ~${Math.abs(change)} tokens from every ${key} session`];
		return [];
	});
	return rows.length <= 3 ? rows : [...rows.slice(0, 2), `and ${rows.length - 2} more`];
}

export function useProjectLoadoutFeedback(project?: string) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const refreshFootprint = useCallback((targetProject: string, staleTime: number) =>
		queryClient.fetchQuery({
			queryKey: qk.usageFootprint(targetProject),
			queryFn: () => fetchUsageFootprint(targetProject),
			staleTime,
		}), [queryClient]);
	const compose = useCallback(async (mutation: ProjectLoadoutMutation): Promise<void> => {
		const targetProject = mutation.project ?? project;
		if (!targetProject) throw new Error("project is required for loadout feedback");
		const run = async () => {
			let beforePayload: UsageFootprintPayload | undefined;
			let before: number | null = null;
			try {
				beforePayload = await refreshFootprint(targetProject, 60_000);
				before = footprintTotal(beforePayload);
			} catch {
				// A missing baseline must not turn a landed write into a reported failure.
			}
			await mutation.write();
			let flagged: Awaited<ReturnType<typeof collectMissingRefs>> = [];
			let afterPayload: UsageFootprintPayload | undefined;
			let postWriteOk = true;
			try {
				flagged = mutation.skillNames && mutation.readRefs
					? await collectMissingRefs(mutation.skillNames, targetProject, { readEnv: mutation.readRefs })
					: [];
				await invalidateUsageComposition(queryClient);
				afterPayload = await refreshFootprint(targetProject, 0);
			} catch {
				postWriteOk = false;
			} finally {
				try {
					await invalidateRegistry(queryClient);
				} catch {
					postWriteOk = false;
				}
			}
			const after = footprintTotal(afterPayload);
			if (postWriteOk && before != null && after != null) publishUsageLoadoutDelta(targetProject, before, after);
			const details = postWriteOk
				? (mutation.details?.slice(0, 3) ?? costDetails(beforePayload, afterPayload))
				: [];
			const appendDetail = typeof mutation.appendDetail === "function" ? mutation.appendDetail() : mutation.appendDetail;
			if (appendDetail && details.length < 3) details.push(appendDetail);
			let undone = false;
			const actions = [] as Array<{ label: string; onClick: () => void }>;
			if (mutation.undo) actions.push({ label: "Undo", onClick: () => (async () => {
			if (undone) return;
			undone = true;
			try {
				await mutation.undo?.();
				// A reversal is a registry write too: stale the registry so the
				// card leaves (or re-enters) the grid, not only the usage reads.
				await invalidateRegistry(queryClient);
				const undoPayload = await refreshFootprint(targetProject, 0);
				const undoAfter = footprintTotal(undoPayload);
				if (after != null && undoAfter != null) publishUsageLoadoutDelta(targetProject, after, undoAfter);
			} catch (error) {
				undone = false;
				toast.error("Couldn't undo", String(error));
			}
			})() });
			if (flagged.length > 0) actions.push({
			label: `Equip ${new Set(flagged.flatMap((r) => r.refs)).size}`,
			onClick: () => void (async () => {
				try {
					await compose({
						project: targetProject,
						title: `Equipped ${new Set(flagged.flatMap((r) => r.refs)).size} on ${targetProject}`,
						write: async () => {
							for (const record of flagged) {
								await mutation.equipRefs?.(record.skill, targetProject);
							}
						},
						duration: mutation.duration,
					});
				} catch (error) {
					await invalidateRegistry(queryClient);
					toast.error("Couldn't equip references", String(error));
				}
			})(),
			});
			const action = actions.length > 0 ? (flagged.length > 0 ? actions[actions.length - 1] : actions[0]) : undefined;
			toast.push({
			kind: flagged.length > 0 ? "info" : "success",
			title: flagged.length === 1
				? refsSentence(flagged[0].skill, flagged[0].refs)
				: flagged.length > 1
					? `${mutation.subject ?? mutation.title.split(" on ")[0]} references ${flagged.length} ${plural(flagged.length, "skill")}`
					: mutation.title,
			body: details.join("\n") || undefined,
			duration: mutation.duration,
			action,
			actions: actions.length > 0 ? actions : undefined,
			});
		};
		await run();
	}, [project, queryClient, refreshFootprint, toast]);
	return compose;
}

export function staticFootprintTokens(payload: UsageFootprintPayload | undefined): number | null {
	return footprintTotal(payload);
}
