import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Registry } from "@/types";

export function useRegistry() {
  return useQuery({
    queryKey: ["registry"],
    queryFn: () => invoke<Registry>("read_registry"),
  });
}
