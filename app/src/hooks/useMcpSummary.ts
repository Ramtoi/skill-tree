import { useQuery } from "@tanstack/react-query";
import { runHubCmd } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { parseCliJson } from "@/lib/skillPack";
import type { McpShowPayload } from "@/lib/mcpContract";
export function mcpSummaryOptions(name: string) {
  return {
    queryKey: qk.mcpShow(name),
    queryFn: async () =>
      parseCliJson<McpShowPayload>(
        (await runHubCmd(["mcp", "show", name, "--json"])).output,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
}
export function useMcpSummary(name: string) {
  return useQuery(mcpSummaryOptions(name));
}
