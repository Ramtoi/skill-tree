import { useQuery } from "@tanstack/react-query";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { McpProbe } from "@/lib/mcpContract";

/**
 * The panel's `Check` control (design D3/§4.5) — the `RemoteCard` health-chip
 * pattern (`RemotesScreen.tsx`'s `useRemoteHealth`): a live probe is
 * EXPENSIVE (it spawns/connects), so it never fires on mount or on registry
 * invalidation — only `armed` (flipped by the button's own click) enables the
 * query. `staleTime: 0` + `retry: false` so a second click always re-probes
 * rather than serving a cached result silently.
 *
 * C3: `staleTime: 0` alone leaves the default react-query
 * `refetchOnWindowFocus`/`refetchOnReconnect` at `true` — once armed, every
 * later alt-tab back into the app would silently re-spawn/re-connect to the
 * user's server. §4.5 says "Never auto-run. Never on mount. Never on
 * registry invalidation." — a refocus was the one trigger this missed.
 */
export function useMcpProbe(name: string | undefined, armed: boolean) {
	return useQuery({
		queryKey: qk.mcpProbe(name ?? ""),
		queryFn: async () => {
			const result = await hubCmd(["mcp", "check", name ?? "", "--json"]);
			return parseCliJson<McpProbe>(result.output);
		},
		enabled: !!name && armed,
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}
