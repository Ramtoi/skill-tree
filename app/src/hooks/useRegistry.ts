import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type { Registry } from "@/types";

export function useRegistry() {
  return useQuery({
    queryKey: ["registry"],
    queryFn: () => invoke<Registry>("read_registry"),
  });
}
