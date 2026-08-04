import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	attachableSkills,
	deleteSubagent,
	linkStatus,
	linkSubagent,
	listSubagents,
	provisionSkill,
	resolveDrift,
	saveSubagent,
	setSubagentDisabled,
	showSubagent,
	skillUsage,
	unlinkSubagent,
	type ProvisionResult,
	type SubagentHarness,
	type SubagentSavePayload,
	type SubagentScope,
} from "@/lib/subagents";
import { queryClient } from "@/lib/queryClient";

// ─── Query keys ───────────────────────────────────────────────────────────────
// The harness dimension is inserted right after the tag so a Claude query and a
// Codex query of the same scope/project never collide. It defaults to
// `claude-code` so shipped call sites keep their identity.

export const subagentKeys = {
	list: (
		scope: SubagentScope,
		project?: string | null,
		harness: SubagentHarness = "claude-code",
	) => ["subagents", harness, scope, project ?? null] as const,
	one: (
		scope: SubagentScope,
		project: string | null,
		name: string,
		harness: SubagentHarness = "claude-code",
	) => ["subagent", harness, scope, project ?? null, name] as const,
	attachable: (
		scope: SubagentScope,
		project?: string | null,
		harness: SubagentHarness = "claude-code",
	) => ["subagent-attachable", harness, scope, project ?? null] as const,
	skillUsage: () => ["subagent-skill-usage"] as const,
	linkStatus: (scope: SubagentScope) => ["subagent-link-status", scope] as const,
};

/** Every agent-capable harness in this release. A link/unlink/copy touches both
 *  sides' lists + show queries, so link mutations invalidate all of them. */
const LINKED_HARNESSES: SubagentHarness[] = ["claude-code", "codex"];

/** Invalidate everything a sub-agent mutation can touch in a scope/harness. */
export async function invalidateSubagents(
	scope: SubagentScope,
	project?: string | null,
	harness: SubagentHarness = "claude-code",
) {
	await queryClient.invalidateQueries({
		queryKey: subagentKeys.list(scope, project, harness),
	});
	// All `one` (show) queries for this harness/scope/project — refreshes the
	// open editor.
	await queryClient.invalidateQueries({
		predicate: (q) =>
			q.queryKey[0] === "subagent" &&
			q.queryKey[1] === harness &&
			q.queryKey[2] === scope &&
			q.queryKey[3] === (project ?? null),
	});
	// skill-usage is harness-agnostic (aggregates every harness) → always refresh.
	await queryClient.invalidateQueries({
		queryKey: subagentKeys.skillUsage(),
	});
	await queryClient.invalidateQueries({
		queryKey: subagentKeys.attachable(scope, project, harness),
	});
	await queryClient.invalidateQueries({
		queryKey: subagentKeys.linkStatus(scope),
	});
}

/** A link/unlink/copy/resolve changes BOTH sides' lists and open editors, so
 *  invalidate every agent-capable harness's query tree for the scope (D3). */
export async function invalidateBothHarnesses(
	scope: SubagentScope,
	project?: string | null,
) {
	for (const h of LINKED_HARNESSES) {
		await invalidateSubagents(scope, project, h);
	}
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useSubagentList(
	scope: SubagentScope,
	project?: string | null,
	enabled = true,
	harness: SubagentHarness = "claude-code",
) {
	return useQuery({
		queryKey: subagentKeys.list(scope, project, harness),
		queryFn: () => listSubagents(scope, project, harness),
		enabled,
	});
}

export function useSubagent(
	scope: SubagentScope,
	project: string | null,
	name: string | undefined,
	harness: SubagentHarness = "claude-code",
) {
	return useQuery({
		queryKey: subagentKeys.one(scope, project, name ?? "", harness),
		queryFn: () => showSubagent(scope, name as string, project, harness),
		enabled: !!name,
	});
}

export function useAttachableSkills(
	scope: SubagentScope,
	project?: string | null,
	enabled = true,
	harness: SubagentHarness = "claude-code",
) {
	return useQuery({
		queryKey: subagentKeys.attachable(scope, project, harness),
		queryFn: () => attachableSkills(scope, project, harness),
		enabled,
	});
}

export function useSkillUsage() {
	return useQuery({
		queryKey: subagentKeys.skillUsage(),
		queryFn: () => skillUsage(),
	});
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useSaveSubagent() {
	return useMutation({
		mutationFn: (payload: SubagentSavePayload) => saveSubagent(payload),
		onSuccess: (res, payload) => {
			if (res.ok)
				void invalidateSubagents(
					payload.scope,
					payload.project,
					payload.harness ?? "claude-code",
				);
		},
	});
}

/** Provision an attached skill (D5 phase 2). Global provisioning widens the
 *  skill across every installed harness, so on success invalidate the
 *  attachable-skills + list caches for the agent's harness/scope so the
 *  subsequent re-save sees the skill resolve. */
export function useProvisionSkill(
	scope: SubagentScope,
	project?: string | null,
	harness: SubagentHarness = "claude-code",
) {
	return useMutation({
		mutationFn: (args: {
			skill: string;
			global: boolean;
			project?: string | null;
			harnessId?: SubagentHarness;
			widenAffinity?: boolean;
		}): Promise<ProvisionResult> => provisionSkill(args),
		onSuccess: (res) => {
			if (res.ok) void invalidateSubagents(scope, project, harness);
		},
	});
}

export function useDeleteSubagent(
	scope: SubagentScope,
	project?: string | null,
	harness: SubagentHarness = "claude-code",
) {
	return useMutation({
		mutationFn: ({
			name,
			linkAction,
		}: {
			name: string;
			linkAction?: "this" | "both";
		}) => deleteSubagent(scope, name, project, harness, linkAction),
		// A "both" delete removes the twin too → invalidate every harness.
		onSuccess: (_res, { linkAction }) =>
			linkAction === "both"
				? invalidateBothHarnesses(scope, project)
				: invalidateSubagents(scope, project, harness),
	});
}

// ─── Linked-twin mutations (D3) ────────────────────────────────────────────────

/** Link / copy-to. A copy projects the core into the missing harness AND records
 *  the link, so both sides' lists change → invalidate every harness. */
export function useLinkSubagent(
	scope: SubagentScope,
	project?: string | null,
) {
	return useMutation({
		mutationFn: ({
			name,
			copyFrom,
		}: {
			name: string;
			copyFrom?: SubagentHarness;
		}) => linkSubagent(name, copyFrom),
		onSuccess: () => invalidateBothHarnesses(scope, project),
	});
}

export function useUnlinkSubagent(
	scope: SubagentScope,
	project?: string | null,
) {
	return useMutation({
		mutationFn: (name: string) => unlinkSubagent(name),
		onSuccess: () => invalidateBothHarnesses(scope, project),
	});
}

/** Resolve per-field drift. Writes the winner value into the loser file(s), so
 *  both sides' show/list caches change → invalidate every harness. */
export function useResolveDrift(
	scope: SubagentScope,
	project?: string | null,
) {
	return useMutation({
		mutationFn: ({
			name,
			decisions,
		}: {
			name: string;
			decisions: Record<string, SubagentHarness>;
		}) => resolveDrift(name, decisions),
		onSuccess: () => invalidateBothHarnesses(scope, project),
	});
}

/** All recorded links + suggestions for a scope (user scope only). */
export function useLinkStatus(scope: SubagentScope, enabled = true) {
	return useQuery({
		queryKey: subagentKeys.linkStatus(scope),
		queryFn: () => linkStatus(),
		enabled,
	});
}

/** Optimistic disable toggle: flip the list cache immediately, roll back on
 *  error, refetch on settle. */
export function useSetSubagentDisabled(
	scope: SubagentScope,
	project?: string | null,
	harness: SubagentHarness = "claude-code",
) {
	const qc = useQueryClient();
	const key = subagentKeys.list(scope, project, harness);
	return useMutation({
		mutationFn: ({ name, disabled }: { name: string; disabled: boolean }) =>
			setSubagentDisabled(scope, name, disabled, project, harness),
		onMutate: async ({ name, disabled }) => {
			await qc.cancelQueries({ queryKey: key });
			const prev = qc.getQueryData(key);
			qc.setQueryData(key, (old: unknown) => {
				if (!old || typeof old !== "object") return old;
				const data = old as {
					agents?: Array<{ name: string; disabled: boolean }>;
					builtins?: Array<{ name: string; disabled: boolean }>;
				};
				const flip = <T extends { name: string; disabled: boolean }>(
					arr?: T[],
				) => arr?.map((a) => (a.name === name ? { ...a, disabled } : a));
				return {
					...data,
					agents: flip(data.agents) ?? data.agents,
					builtins: flip(data.builtins) ?? data.builtins,
				};
			});
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev !== undefined) qc.setQueryData(key, ctx.prev);
		},
		onSettled: (_data, _err, { name }) => {
			void qc.invalidateQueries({ queryKey: key });
			// Refresh the open editor's own `show` query so its DISABLED pill updates.
			void qc.invalidateQueries({
				queryKey: subagentKeys.one(scope, project ?? null, name, harness),
			});
		},
	});
}
