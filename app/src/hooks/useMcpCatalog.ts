import { useQuery } from "@tanstack/react-query";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { McpCatalogPayload } from "@/lib/mcpContract";

/**
 * `hub mcp catalog <name> --json` (design G.md §6.2) — read-only, never
 * probes: it reads a file already written by the last `Check`, so unlike
 * `useMcpProbe` there is no `armed` gate here, only `enabled`. Callers pass
 * `enabled` as "the sheet is open" — the record can run to a couple hundred
 * KB (§5.6), so there is no reason to fetch it before the user asks to
 * browse.
 *
 * Success and failure both arrive as ordinary JSON on stdout (INTERFACES §3:
 * `{"ok":true,"catalog":…}` or `{"ok":false,"error":…,"code":"no_catalog"}`),
 * so this reads `result.output` regardless of the process exit code and lets
 * the caller discriminate on `data.ok`.
 */
export function useMcpCatalog(name: string | undefined, enabled: boolean) {
	return useQuery({
		queryKey: qk.mcpCatalog(name ?? ""),
		queryFn: async () =>
			parseCliJson<McpCatalogPayload>((await hubCmd(["mcp", "catalog", name ?? "", "--json"])).output),
		enabled: !!name && enabled,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}
