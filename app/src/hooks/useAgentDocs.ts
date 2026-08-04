import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type {
	AgentDocContent,
	AgentDocFixApplyResult,
	AgentDocFixPlan,
	AgentDocResolveOp,
	AgentDocResolveResult,
	AgentDocRootStatus,
	AgentDocRootStrategy,
	AgentDocStrategyInfo,
	AgentDocWriteResult,
	AgentDocsListing,
} from "@/types/agentDocs";

export function useAgentDocsListing(
	projectPath: string | undefined,
	includeAllMarkdown = false,
) {
	return useQuery<AgentDocsListing>({
		queryKey: ["agent-docs", projectPath ?? "", includeAllMarkdown],
		queryFn: async () => {
			if (!projectPath) throw new Error("missing project path");
			return invoke<AgentDocsListing>("list_agent_docs", {
				projectPath,
				includeAllMarkdown,
			});
		},
		enabled: !!projectPath,
		staleTime: 0,
		gcTime: 0,
	});
}

export async function readAgentDoc(
	projectPath: string,
	relativePath: string,
): Promise<AgentDocContent> {
	return invoke<AgentDocContent>("read_agent_doc", {
		projectPath,
		relativePath,
	});
}

export async function writeAgentDoc(args: {
	projectPath: string;
	relativePath: string;
	content: string;
	expectedHash?: string | null;
	overwrite?: boolean;
}): Promise<AgentDocWriteResult> {
	return invoke<AgentDocWriteResult>("write_agent_doc", {
		projectPath: args.projectPath,
		relativePath: args.relativePath,
		content: args.content,
		expectedHash: args.expectedHash ?? null,
		overwrite: args.overwrite ?? false,
	});
}

// ─── Canonical root status / strategy / fix / resolve ───────────────────────

/** Read-only root status (calls hub.py via the Rust bridge). Cheap; safe to
 *  refetch alongside the listing. */
export function useAgentDocsRootStatus(projectPath: string | undefined) {
	return useQuery<AgentDocRootStatus>({
		queryKey: ["agent-docs-root-status", projectPath ?? ""],
		queryFn: async () => {
			if (!projectPath) throw new Error("missing project path");
			return invoke<AgentDocRootStatus>("agent_docs_root_status", {
				projectPath,
			});
		},
		enabled: !!projectPath,
		staleTime: 0,
		gcTime: 0,
	});
}

/** Resolved root strategy. Pass `projectName` to include the per-project
 *  override and the effective resolution; otherwise returns the global only. */
export function useAgentDocsStrategy(projectName?: string) {
	return useQuery<AgentDocStrategyInfo>({
		queryKey: ["agent-docs-strategy", projectName ?? ""],
		queryFn: async () =>
			invoke<AgentDocStrategyInfo>("agent_docs_strategy_get", {
				projectName: projectName ?? null,
			}),
		staleTime: 0,
		gcTime: 0,
	});
}

export async function setAgentDocsStrategy(args: {
	projectName?: string;
	value?: AgentDocRootStrategy;
	clear?: boolean;
}): Promise<AgentDocStrategyInfo> {
	return invoke<AgentDocStrategyInfo>("agent_docs_strategy_set", {
		projectName: args.projectName ?? null,
		value: args.value ?? null,
		clear: args.clear ?? false,
	});
}

/** Build the transactional fix plan (dry-run; never writes). The returned
 *  plan carries precondition fingerprints — pass it back unchanged (apart
 *  from `selected` flags on opt-in steps) to `applyAgentDocsFix`. */
export async function fetchAgentDocsFixPlan(
	projectPath: string,
): Promise<AgentDocFixPlan> {
	return invoke<AgentDocFixPlan>("agent_docs_fix_plan", { projectPath });
}

/** Apply a previewed fix plan. hub.py re-verifies every precondition against
 *  disk and aborts the whole apply (`applied: false`, `error: "disk_changed"`)
 *  if anything changed since the preview. `commit` opts into a scoped git
 *  commit of exactly the touched files (never a push). */
export async function applyAgentDocsFix(
	projectPath: string,
	plan: AgentDocFixPlan,
	commit = false,
): Promise<AgentDocFixApplyResult> {
	return invoke<AgentDocFixApplyResult>("agent_docs_fix_apply", {
		projectPath,
		plan,
		commit,
	});
}

/** Explicit conflict/appendix resolution — never merges. */
export async function resolveAgentDocsRoot(args: {
	projectPath: string;
	dir?: string;
	op: AgentDocResolveOp;
	commit?: boolean;
}): Promise<AgentDocResolveResult> {
	return invoke<AgentDocResolveResult>("agent_docs_resolve", {
		projectPath: args.projectPath,
		dir: args.dir ?? "",
		op: args.op,
		commit: args.commit ?? false,
	});
}
