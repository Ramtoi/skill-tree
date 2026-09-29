import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type {
	SnippetDeleteResult,
	SnippetEditResult,
	SnippetInfo,
	SnippetMutationResult,
	SnippetScanResult,
	SnippetUpdateEverywhereResult,
} from "@/types/snippets";

/**
 * Library list incl. scan-derived usage roll-ups.
 *
 * `enabled: false` is how a passive READER (the NavPanel's info block) rides
 * along on the screen's cache entry without ever fetching. It must go through
 * this hook rather than declaring its own `useQuery` on the same key: observers
 * share one Query and `Query.setOptions` is last-writer-wins over `queryFn`, so
 * a second definition — a stub, `skipToken`, or a hand-copied fetcher — becomes
 * what every later invalidation actually runs.
 */
export function useSnippets(filters?: {
	tag?: string;
	query?: string;
	enabled?: boolean;
}) {
	return useQuery<SnippetInfo[]>({
		queryKey: qk.snippets.list(filters?.tag ?? "", filters?.query ?? ""),
		queryFn: () =>
			invoke<SnippetInfo[]>("snippets_list", {
				tag: filters?.tag ?? null,
				query: filters?.query ?? null,
			}),
		enabled: filters?.enabled ?? true,
	});
}

/**
 * Names-only list — no project-tree scan, so it returns in well under the
 * ~1.8s a full `usage` roll-up costs on a real home. Used wherever the
 * caller only needs which snippets exist (the landing redirect, the empty
 * state, allTags) and not their applied-location counts.
 */
export function useSnippetNames(filters?: { enabled?: boolean }) {
	return useQuery<SnippetInfo[]>({
		queryKey: qk.snippets.names(),
		queryFn: () => invoke<SnippetInfo[]>("snippets_list", { tag: null, query: null, noUsage: true }),
		enabled: filters?.enabled ?? true,
		// The Library's floating search reads this on every mount alongside the
		// Snippets screen's own fetch — a 5-minute stale window means a second
		// consumer within that window serves from cache instead of re-fetching.
		staleTime: 5 * 60_000,
	});
}

/**
 * One snippet's body + metadata — no project-tree scan (`noUsage: true`).
 * The editor paints this immediately and gets applied locations separately
 * from `useSnippetScan` (`snippet status --name`, one walk shared with the
 * side panel), instead of waiting on the scan `show` used to bundle in.
 */
export function useSnippet(name: string | undefined) {
	return useQuery<SnippetInfo>({
		queryKey: qk.snippets.one(name ?? ""),
		queryFn: () => invoke<SnippetInfo>("snippet_show", { name, noUsage: true }),
		enabled: !!name,
	});
}

/** Marker scan across registered projects (optionally narrowed). */
export function useSnippetScan(filters?: { name?: string; project?: string }) {
	return useQuery<SnippetScanResult>({
		queryKey: qk.snippets.scan(filters?.name ?? "", filters?.project ?? ""),
		queryFn: () =>
			invoke<SnippetScanResult>("snippet_status", {
				name: filters?.name ?? null,
				project: filters?.project ?? null,
			}),
	});
}

/** Invalidate everything a snippet mutation can change: library, scans, the
 * agent-doc buffers/trees (mutations rewrite doc files on disk), and the
 * Library's content-search corpus (a snippet body edit goes through this
 * hook, never through `invalidateRegistry` — without this the edited body
 * stays stale in search for up to 5 minutes). */
export function useInvalidateSnippets() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: qk.snippets.listAll() });
		qc.invalidateQueries({ queryKey: qk.snippets.oneAll() });
		qc.invalidateQueries({ queryKey: qk.snippets.scanAll() });
		qc.invalidateQueries({ queryKey: qk.agentDocs.all() });
		qc.invalidateQueries({ queryKey: qk.searchCorpus() });
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
