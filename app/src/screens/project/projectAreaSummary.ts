import { useMemo } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useAgentDocsListing } from "@/hooks/useAgentDocs";
import { useSubagentList } from "@/hooks/useSubagents";
import {
	directOnly,
	resolveActiveSkills,
} from "@/lib/resolveActiveSkills";
import { projectRecord } from "@/lib/syncFreshness";
import { useUsageFootprint, useUsageProject } from "@/hooks/useUsageAnalytics";
import { primaryHarness, useFootprintTokens, type HarnessFootprintTokens } from "@/lib/footprintTokens";
import { usageSummary, type UsageSummary } from "@/lib/usageProjectInsights";
import { isDeviating } from "@/components/agentDocs/agentDocHelpers";
import type { AgentDocsListing } from "@/types/agentDocs";
import type { SubagentListResult } from "@/lib/subagents";
import type { Project, Registry } from "@/types";

// ─── Per-area summaries ──────────────────────────────────────────────────────
// One pure function per area, each reading only what the area's own screen
// would read, so a card never disagrees with the screen it opens.

export interface SkillsSummary {
	equipped: number;
	direct: number;
	via: number;
	mcp: number;
	/** Equipped skills the last sync skipped for want of a matching harness. */
	wontSync: number;
}

export function skillsSummary(
	proj: Project,
	registry: Registry,
	wontSync = 0,
): SkillsSummary {
	const equipped = resolveActiveSkills(proj, registry);
	const direct = directOnly(proj, registry).length;
	const mcp = equipped.filter(
		(s) => registry.skills[s]?.type === "mcp-server",
	).length;
	return {
		equipped: equipped.length,
		direct,
		via: equipped.length - direct,
		mcp,
		wontSync,
	};
}

export interface AgentDocsSummary {
	/** Instruction files the agent loads (roots, nested docs, resolved imports). */
	files: number;
	upfrontTokens: number | null;
	/** Tokens in instruction files reached only by walking into their dir. */
	discoverableTokens: number | null;
	/** Directories whose layout deviates from the canonical root policy. */
	deviations: number;
}

export function agentDocsSummary(
	listing: AgentDocsListing,
	_projectHarnesses: readonly string[],
	tokens: HarnessFootprintTokens | null,
): AgentDocsSummary {
	const rels = listing.instruction_rels ?? [];
	const upfront = tokens?.upfront ?? null;
	const discoverable = tokens?.discoverable ?? null;
	return {
		files: rels.length,
		upfrontTokens: upfront,
		discoverableTokens: discoverable,
		deviations: (listing.instruction_sets ?? []).filter(isDeviating).length,
	};
}

export interface PermissionCounts {
	allow: number;
	deny: number;
	ask: number;
	/** Rules in effect: global ∪ project, deduped by pattern within a kind. */
	total: number;
	/** Distinct rules the project's own block declares. */
	own: number;
	/** Distinct global rules the project does not restate: total − own. */
	inherited: number;
}

type RuleLists = {
	allow?: unknown[];
	deny?: unknown[];
	ask?: unknown[];
};

const KINDS = ["allow", "deny", "ask"] as const;

function patternOf(rule: unknown): string {
	if (rule && typeof rule === "object" && "pattern" in rule) {
		const p = (rule as { pattern?: unknown }).pattern;
		if (typeof p === "string") return p;
	}
	return typeof rule === "string" ? rule : JSON.stringify(rule);
}

/**
 * Registry-only approximation of the effective view (`hub permissions show
 * --effective`): the merge dedupes on (pattern, kind), which is what a set
 * union per kind reproduces. Affinity-distinct duplicates are collapsed here
 * where the CLI keeps them, so this can under-count by those — never over.
 * `own` and `inherited` are set sizes too, so they always add up to `total`
 * even when a hand-edited block repeats a pattern.
 */
export function permissionCounts(
	proj: Project,
	registry: Registry,
): PermissionCounts {
	const global = (registry.permissions_global ?? {}) as RuleLists;
	const ownLists = (proj.permissions ?? {}) as RuleLists;
	const counts = { allow: 0, deny: 0, ask: 0 };
	let own = 0;
	let inherited = 0;
	for (const kind of KINDS) {
		const ownSet = new Set((ownLists[kind] ?? []).map(patternOf));
		const globalOnly = new Set(
			(global[kind] ?? []).map(patternOf).filter((p) => !ownSet.has(p)),
		);
		counts[kind] = ownSet.size + globalOnly.size;
		own += ownSet.size;
		inherited += globalOnly.size;
	}
	return {
		...counts,
		total: counts.allow + counts.deny + counts.ask,
		own,
		inherited,
	};
}

export interface SubagentsSummary {
	agents: number;
	disabled: number;
	builtins: number;
	builtinsOff: number;
}

export function subagentsSummary(list: SubagentListResult): SubagentsSummary {
	const agents = list.agents ?? [];
	const builtins = list.builtins ?? [];
	return {
		agents: agents.length,
		disabled: agents.filter((a) => a.disabled).length,
		builtins: builtins.length,
		builtinsOff: builtins.filter((b) => b.disabled).length,
	};
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface AreaSummaries {
	skills: SkillsSummary | null;
	/** `null` while loading; `"error"` when the listing could not be read. */
	docs: AgentDocsSummary | null | "error";
	permissions: PermissionCounts | null;
	subagents: SubagentsSummary | null | "error";
	usage: UsageSummary | null | "error";
}

/**
 * Everything the project area strip shows, from the same queries the four
 * area screens use — react-query shares the cache, so opening an area after
 * the strip costs nothing extra, and the numbers cannot drift between the
 * two. Skills and permissions are registry-derived (no IPC); agent docs is
 * the Rust scanner; sub-agents is one `hub subagent list`.
 */
export function useProjectAreaSummaries(projectName: string): AreaSummaries {
	const { data: registry } = useRegistry();
	const { data: syncEnvelope } = useSyncReport();
	const proj = registry?.projects?.[projectName];
	const projectHarnesses = useMemo(
		() => [...(registry?.harnesses_global ?? []), ...(proj?.harnesses ?? [])],
		[registry?.harnesses_global, proj?.harnesses],
	);

	// The listing hook defaults to staleTime 0 for the editor (disk is the
	// source of truth there). A summary can be 30 s old: on the three screens
	// where the strip is this query's only observer, that turns a full
	// project scan on every window focus into one per half-minute.
	const attached = !!proj && !proj.path_unresolved;
	const listing = useAgentDocsListing(attached ? proj?.path : undefined, false, attached, false, {
		staleTime: 30_000,
	});
	const agentList = useSubagentList("project", projectName, attached);
	const usageProject = useUsageProject(projectName, 30);
	const usageFootprint = useUsageFootprint(projectName);
	const usageTokens = useFootprintTokens(
		usageFootprint.data,
		primaryHarness(usageFootprint.data),
	);

	const wontSync =
		projectRecord(projectName, syncEnvelope)?.affinity_skips?.length ?? 0;

	const skills = useMemo(
		() => (proj && registry ? skillsSummary(proj, registry, wontSync) : null),
		[proj, registry, wontSync],
	);
	const permissions = useMemo(
		() => (proj && registry ? permissionCounts(proj, registry) : null),
		[proj, registry],
	);
	const docs = useMemo<AreaSummaries["docs"]>(() => {
		if (!attached) return null;
		if (listing.isError) return "error";
		if (!listing.data) return null;
		return agentDocsSummary(listing.data, projectHarnesses, usageTokens);
	}, [attached, listing.data, listing.isError, projectHarnesses, usageTokens]);
	const subagents = useMemo<AreaSummaries["subagents"]>(() => {
		if (!attached) return null;
		if (agentList.isError) return "error";
		if (!agentList.data) return null;
		return subagentsSummary(agentList.data);
	}, [attached, agentList.data, agentList.isError]);

	const usage = usageProject.isError || usageFootprint.isError
		? "error"
		: usageSummary(usageProject.data, usageTokens);
	return { skills, docs, permissions, subagents, usage };
}
