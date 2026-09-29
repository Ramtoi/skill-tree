import { useQuery, useQueryClient } from "@tanstack/react-query";
import { machineCommand, type Machine } from "@/lib/headlessMachines";
import { qk } from "@/lib/queryKeys";

export function useMachines() {
  return useQuery({ queryKey: qk.machines.list(), queryFn: () => machineCommand<Machine[]>("list"),
    retry: false, refetchOnWindowFocus: false });
}
export function useMachine(id: string) {
  return useQuery({ queryKey: qk.machines.show(id), queryFn: () => machineCommand("show", [id]),
    retry: false, refetchOnWindowFocus: false });
}
export function useInvalidateMachines() {
  const client = useQueryClient();
  return async (id?: string) => {
    await client.invalidateQueries({ queryKey: qk.machines.list() });
    if (id) await client.invalidateQueries({ queryKey: qk.machines.show(id) });
    await client.invalidateQueries({ queryKey: qk.remotes.list() });
  };
}
