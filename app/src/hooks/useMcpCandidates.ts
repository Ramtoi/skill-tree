import { useQuery } from "@tanstack/react-query";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { McpCandidate } from "@/lib/mcpContract";

/** `hub mcp reconcile --json` payload (INTERFACES §3). */
export interface McpReconcilePayload {
	ok: boolean;
	scope_kind: "global" | "project";
	project: string | null;
	candidates: McpCandidate[];
	kept: string[];
}

const EMPTY_RECONCILE: McpReconcilePayload = {
	ok: true,
	scope_kind: "global",
	project: null,
	candidates: [],
	kept: [],
};

/** Native MCP servers detected but not yet adopted, at global scope (design
 *  D5) — the Library's "Detected MCP servers" band. Mirrors
 *  `useLocalCandidates`'s shape: a plain read-only query with a
 *  catch-to-empty fallback, so a CLI hiccup never turns into an error card on
 *  the Library's first paint. `hub mcp reconcile --global` spawns a Python
 *  process and walks every installed harness's native config across the
 *  filesystem — heavier than `useLocalCandidates`'s own read — so (W4, the
 *  exact class 5e1-review flagged) it must not silently re-run on every
 *  window focus once `staleTime` has lapsed; the band is already kept fresh
 *  by `invalidateRegistry()` and by every adopt/keep decision. */
export function useMcpCandidates() {
	return useQuery({
		queryKey: qk.mcpCandidates("global"),
		queryFn: async () => {
			try {
				const result = await hubCmd(["mcp", "reconcile", "--global", "--json"]);
				if (!result.success) return EMPTY_RECONCILE;
				return parseCliJson<McpReconcilePayload>(result.output);
			} catch {
				return EMPTY_RECONCILE;
			}
		},
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}
