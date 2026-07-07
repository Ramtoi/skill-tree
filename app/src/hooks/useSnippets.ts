import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type {
	SnippetDeleteResult,
	SnippetEditResult,
	SnippetInfo,
	SnippetMutationResult,
	SnippetScanResult,
	SnippetUpdateEverywhereResult,
} from "@/types/snippets";

/** Library list incl. scan-derived usage roll-ups. */
export function useSnippets(filters?: { tag?: string; query?: string }) {
	return useQuery<SnippetInfo[]>({
		queryKey: ["snippets", filters?.tag ?? "", filters?.query ?? ""],
		queryFn: () =>
			invoke<SnippetInfo[]>("snippets_list", {
				tag: filters?.tag ?? null,
				query: filters?.query ?? null,
			}),
	});
}

/** One snippet incl. body + applied locations (scan-derived). */
export function useSnippet(name: string | undefined) {
	return useQuery<SnippetInfo>({
		queryKey: ["snippet", name ?? ""],
		queryFn: () => invoke<SnippetInfo>("snippet_show", { name }),
		enabled: !!name,
	});
}

/** Marker scan across registered projects (optionally narrowed). */
export function useSnippetScan(filters?: { name?: string; project?: string }) {
	return useQuery<SnippetScanResult>({
		queryKey: ["snippet-scan", filters?.name ?? "", filters?.project ?? ""],
		queryFn: () =>
			invoke<SnippetScanResult>("snippet_status", {
				name: filters?.name ?? null,
				project: filters?.project ?? null,
			}),
	});
}

/** Invalidate everything a snippet mutation can change: library, scans, and
 * the agent-doc buffers/trees (mutations rewrite doc files on disk). */
export function useInvalidateSnippets() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: ["snippets"] });
		qc.invalidateQueries({ queryKey: ["snippet"] });
		qc.invalidateQueries({ queryKey: ["snippet-scan"] });
		qc.invalidateQueries({ queryKey: ["agent-docs"] });
	};
}

export async function createSnippet(args: {
	name: string;
	description?: string;
	tags?: string[];
	body?: string;
}): Promise<SnippetInfo> {
	return invoke<SnippetInfo>("snippet_new", {
		name: args.name,
		description: args.description ?? null,
		tags: args.tags ?? null,
		body: args.body ?? null,
	});
}

export async function editSnippet(args: {
	name: string;
	description?: string;
	tags?: string[];
	body?: string;
}): Promise<SnippetEditResult> {
	return invoke<SnippetEditResult>("snippet_edit", {
		name: args.name,
		description: args.description ?? null,
		tags: args.tags ?? null,
		body: args.body ?? null,
	});
}

export async function deleteSnippet(args: {
	name: string;
	force?: boolean;
}): Promise<SnippetDeleteResult> {
	return invoke<SnippetDeleteResult>("snippet_delete", {
		name: args.name,
		force: args.force ?? false,
	});
}

export async function applySnippet(args: {
	name: string;
	project: string;
	relativePath?: string;
}): Promise<SnippetMutationResult> {
	return invoke<SnippetMutationResult>("snippet_apply", {
		name: args.name,
		project: args.project,
		relativePath: args.relativePath ?? null,
	});
}

export async function removeSnippet(args: {
	name: string;
	project: string;
	relativePath?: string;
	force?: boolean;
}): Promise<SnippetMutationResult> {
	return invoke<SnippetMutationResult>("snippet_remove", {
		name: args.name,
		project: args.project,
		relativePath: args.relativePath ?? null,
		force: args.force ?? false,
	});
}

export async function updateSnippet(args: {
	name: string;
	project: string;
	relativePath?: string;
	force?: boolean;
}): Promise<SnippetMutationResult> {
	return invoke<SnippetMutationResult>("snippet_update", {
		name: args.name,
		project: args.project,
		relativePath: args.relativePath ?? null,
		all: false,
		force: args.force ?? false,
	});
}

export async function updateSnippetEverywhere(args: {
	name: string;
}): Promise<SnippetUpdateEverywhereResult> {
	return invoke<SnippetUpdateEverywhereResult>("snippet_update", {
		name: args.name,
		project: null,
		relativePath: null,
		all: true,
		force: false,
	});
}
