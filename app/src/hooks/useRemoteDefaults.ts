import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import { parseRemoteDefaults, type RemoteDefaults } from "@/lib/remoteDefaults";

async function command(args: string[]) {
  const response = await hubCmd(["remote", "defaults", ...args, "--json"]);
  const reply = parseRemoteDefaults(hubStreams(response).stdout);
  if (!response.success) throw new Error(reply.error?.message ?? "Could not save remote defaults.");
  if (!reply.ok) throw new Error(reply.error?.message ?? "Could not read remote defaults.");
  return reply;
}

export function useRemoteDefaults(enabled = true) {
  return useQuery({
    enabled,
    queryKey: qk.remoteDefaults(),
    queryFn: () => command(["show"]),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSaveRemoteDefaults() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (defaults: RemoteDefaults) => command([
      "set",
      "--poll-interval-seconds",
      String(defaults.poll_interval_seconds),
    ]),
    onSuccess: async (reply) => {
      client.setQueryData(qk.remoteDefaults(), reply);
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.remoteDefaults() }),
        invalidateRegistry(client),
      ]);
    },
  });
}
