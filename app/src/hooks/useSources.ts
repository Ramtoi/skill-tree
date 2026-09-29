import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { runHubCmd } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import type { SourceView } from "@/types";

interface ListPayload {
	sources: SourceView[];
	errors: string[];
}

/** Calls `hub source list --json` through the generic `hub_cmd` bridge.
 *  Throws on non-zero exit or unparseable output so React Query surfaces it. */
export async function fetchSources(): Promise<SourceView[]> {
	const res = await runHubCmd(["source", "list", "--json"]);
	let payload: ListPayload;
	try {
		payload = JSON.parse(res.output) as ListPayload;
	} catch (e) {
		throw new Error(`Could not parse hub source list output: ${(e as Error).message}`);
	}
	return payload.sources ?? [];
}

export function useSources() {
	return useQuery({
		queryKey: qk.sources(),
		queryFn: fetchSources,
	});
}

/** Helper for mutation handlers: invalidate both registry and sources after
 *  any source-mutating CLI call so the UI stays consistent. */
export function invalidateSourceQueries(client: ReturnType<typeof useQueryClient>) {
	void invalidateRegistry(client);
	client.invalidateQueries({ queryKey: qk.sources() });
}

export type ConflictDecision = "skip" | "replace" | "suffix";

export interface SourceApplyResult {
	ok: boolean;
	registered: string[];
	skipped?: string[];
	resolved: Array<{ name: string; action: ConflictDecision; final_name: string }>;
	counts?: Record<string, number>;
	error?: string;
}

/** Apply a `source add git` with per-conflict decisions (D7). `args` is the
 *  `["source","add","git",url,…]` vector WITHOUT `--dry-run`; the Rust layer
 *  appends `--decisions-stdin --json` and pipes `{ decisions, selected_new? }`.
 *
 *  `selectedNew` narrows which NEW candidates get imported. Pass it ONLY for a
 *  proper subset — omitting it keeps the back-compatible "import everything
 *  discovered" contract, which also leaves the source following upstream fully
 *  (no `include:` filter written). */
export async function applySourceWithDecisions(
	args: string[],
	decisions: Record<string, ConflictDecision>,
	selectedNew?: string[],
): Promise<SourceApplyResult> {
	const payload = await invoke<SourceApplyResult>("source_add_apply", {
		args,
		decisions,
		selectedNew: selectedNew ?? null,
	});
	if (!payload.ok) throw new Error(payload.error || "source add failed");
	return payload;
}
