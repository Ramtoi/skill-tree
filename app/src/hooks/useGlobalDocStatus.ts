import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { hubCmd } from "@/lib/hubCmd";
import { parseHubJson } from "@/lib/cloud";

/** Per-harness global-doc state, as classified by `global_docs.status()`
 *  (`hub harness doc status --json`). See `docs/AGENT-DOCS.md` § User-global
 *  instructions across harnesses for the full state table. */
export type GlobalDocState =
	| "missing"
	| "standalone"
	| "source"
	| "follows"
	| "broken"
	| "external";

export interface GlobalDocStatusRow {
	harness: string;
	label: string;
	path: string;
	state: GlobalDocState;
	/** The harness this one's doc follows, or null. Set for `follows`/`broken`. */
	follows: string | null;
	/** Harness ids whose doc follows THIS one. Non-empty only for `source`. */
	followers: string[];
	/** Byte size of the real file — `standalone`/`source` only; null otherwise. */
	bytes: number | null;
}

/** `hub harness doc status --json` never fails on a healthy install (it is a
 *  pure filesystem scan), so a non-zero exit is a real error — the CLI's own
 *  stdout/stderr still gets thrown as the query's error via `hubCmd`'s
 *  success flag check below. */
async function fetchGlobalDocStatus(): Promise<GlobalDocStatusRow[]> {
	const result = await hubCmd(["harness", "doc", "status", "--json"]);
	if (!result.success) {
		throw new Error(result.output || "hub harness doc status failed");
	}
	return parseHubJson<GlobalDocStatusRow[]>(result.output);
}

/**
 * Every harness's global-doc state in one query — the Harnesses card hints
 * and the doc editor's SHARED WITH rows both read it, so a link/unlink
 * anywhere invalidates this ONE key (`qk.globalDocStatus()`) and both surfaces
 * pick up the change.
 */
export function useGlobalDocStatus() {
	return useQuery({
		queryKey: qk.globalDocStatus(),
		queryFn: fetchGlobalDocStatus,
	});
}

/** Row lookup by harness id — undefined while loading, on error, or for an
 *  id the status scan doesn't know (a harness with no `global_doc`). */
export function docStatusFor(
	rows: GlobalDocStatusRow[] | undefined,
	id: string,
): GlobalDocStatusRow | undefined {
	return rows?.find((r) => r.harness === id);
}
