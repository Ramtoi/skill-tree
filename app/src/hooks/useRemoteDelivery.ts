import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { remoteDeliveryCommand } from "@/lib/remoteDelivery";

export function useRemoteDelivery(enabled = true) {
  return useQuery({ queryKey: qk.remoteDelivery(), enabled,
    queryFn: () => remoteDeliveryCommand(["show"]), retry: false, refetchOnWindowFocus: false });
}

export function useChangeRemoteDelivery() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (args: string[]) => remoteDeliveryCommand(args),
    onSuccess: async (reply) => {
      client.setQueryData(qk.remoteDelivery(), reply);
      await Promise.all([
        ...(reply.last_run?.results ?? []).map(row =>
          client.invalidateQueries({ queryKey: qk.machines.show(row.id) })),
        client.invalidateQueries({ queryKey: qk.registry() }),
        client.invalidateQueries({ queryKey: qk.machines.list() }),
        client.invalidateQueries({ queryKey: qk.remotes.list() }),
      ]);
    } });
}
