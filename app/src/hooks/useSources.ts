import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SourceView } from "@/types";

interface HubCmdResult {
	success: boolean;
	output: string;
}

interface ListPayload {
	sources: SourceView[];
	errors: string[];
}

/** Calls `hub source list --json` through the generic `hub_cmd` bridge.
 *  Throws on non-zero exit or unparseable output so React Query surfaces it. */
export async function fetchSources(): Promise<SourceView[]> {
	const res = await invoke<HubCmdResult>("hub_cmd", {
		args: ["source", "list", "--json"],
	});
	if (!res.success) {
		throw new Error(res.output || "hub source list failed");
	}
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
		queryKey: ["sources"],
		queryFn: fetchSources,
	});
}

/** Helper for mutation handlers: invalidate both registry and sources after
 *  any source-mutating CLI call so the UI stays consistent. */
export function invalidateSourceQueries(client: ReturnType<typeof useQueryClient>) {
	client.invalidateQueries({ queryKey: ["registry"] });
	client.invalidateQueries({ queryKey: ["sources"] });
}
