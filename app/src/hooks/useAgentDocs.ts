import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type {
	AgentDocContent,
	AgentDocFile,
	AgentDocFixApplyResult,
	AgentDocFixPlan,
	AgentDocPublishInfo,
	AgentDocPublishResult,
	AgentDocResolveOp,
	AgentDocResolveResult,
	AgentDocRootStatus,
	AgentDocRootStrategy,
	AgentDocStrategyInfo,
	AgentDocWriteResult,
	AgentDocsListing,
} from "@/types/agentDocs";

/**
 * `staleTime: 0` is deliberate and load-bearing. Agent Docs' whole premise is
 * that disk is the source of truth and agents rewrite these files constantly;
 * there is no watcher, so a cached listing would be the one thing standing
 * between the user and a file that changed in a terminal.
 */
export function useAgentDocsListing(
	projectPath: string | undefined,
	includeAllMarkdown = false,
	enabled = true,
	includeIgnored = false,
	/** A summary reader may accept a stale listing; the editor never does. */
	opts: { staleTime?: number } = {},
) {
	return useQuery<AgentDocsListing>({
		queryKey: qk.agentDocs.listing(
			projectPath ?? "",
			includeAllMarkdown,
			includeIgnored,
		),
		queryFn: async () => {
			if (!projectPath) throw new Error("missing project path");
			return invoke<AgentDocsListing>("list_agent_docs", {
				projectPath,
				includeAllMarkdown,
				includeIgnored,
			});
		},
		enabled: !!projectPath && enabled,
		staleTime: opts.staleTime ?? 0,
		gcTime: 0,
	});
}

/**
 * Size and mtime for one directory's files, fetched when its rows are actually
 * displayed. The listing ships browse rows with unresolved metadata so this
 * cost lands per expanded folder rather than per project mount.
 */
export function useAgentDocDirMeta(
	projectPath: string | undefined,
	relativeDir: string | null,
) {
	return useQuery<AgentDocFile[]>({
		queryKey: qk.agentDocs.dirMeta(projectPath ?? "", relativeDir ?? ""),
		queryFn: async () => {
			if (!projectPath || relativeDir === null) return [];
			return invoke<AgentDocFile[]>("resolve_agent_doc_dir_meta", {
				projectPath,
				relativeDir,
			});
		},
		enabled: !!projectPath && relativeDir !== null,
		staleTime: 0,
		gcTime: 0,
	});
}

export async function resolveAgentDocDirMeta(
	projectPath: string,
	relativeDir: string,
): Promise<AgentDocFile[]> {
	const res = await invoke<AgentDocFile[]>("resolve_agent_doc_dir_meta", {
		projectPath,
		relativeDir,
	});
	// A metadata top-up is a convenience, never a reason to take the map down.
	return Array.isArray(res) ? res.filter((f) => !!f?.rel) : [];
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
	publishOnSave?: boolean;
}): Promise<AgentDocWriteResult> {
	return invoke<AgentDocWriteResult>("write_agent_doc", {
		projectPath: args.projectPath,
		relativePath: args.relativePath,
		content: args.content,
		expectedHash: args.expectedHash ?? null,
		overwrite: args.overwrite ?? false,
		...(args.publishOnSave ? { publishOnSave: true } : {}),
	});
}

// ─── Canonical root status / strategy / fix / resolve ───────────────────────

/** Read-only root status (calls hub.py via the Rust bridge). Cheap; safe to
 *  refetch alongside the listing. */
export function useAgentDocsRootStatus(projectPath: string | undefined) {
	return useQuery<AgentDocRootStatus>({
		queryKey: qk.agentDocs.rootStatus(projectPath ?? ""),
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
export function useAgentDocsStrategy(projectName?: string, enabled = true) {
	return useQuery<AgentDocStrategyInfo>({
		queryKey: qk.agentDocs.strategy(projectName ?? ""),
		enabled,
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

export function useAgentDocsPublish(projectName: string | undefined) {
	return useQuery<AgentDocPublishInfo>({
		queryKey: qk.agentDocs.publish(projectName ?? ""),
		queryFn: async () => {
			if (!projectName) throw new Error("missing project name");
			return invoke<AgentDocPublishInfo>("agent_docs_publish_get", {
				projectName,
			});
		},
		enabled: !!projectName,
		staleTime: 0,
		gcTime: 0,
	});
}

export async function setAgentDocsPublish(
	projectName: string,
	enabled: boolean,
): Promise<AgentDocPublishInfo> {
	return invoke<AgentDocPublishInfo>("agent_docs_publish_set", {
		projectName,
		enabled,
	});
}

export async function publishAgentDocsNow(
	projectPath: string,
): Promise<AgentDocPublishResult> {
	return invoke<AgentDocPublishResult>("agent_docs_publish_now", {
		projectPath,
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
