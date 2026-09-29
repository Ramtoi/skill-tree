import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import type { Registry } from "@/types";

export function useRegistry() {
  return useQuery({
    queryKey: qk.registry(),
    queryFn: () => invoke<Registry>("read_registry"),
  });
}
