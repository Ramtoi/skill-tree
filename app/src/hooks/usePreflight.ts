import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type { Preflight } from "@/screens/PythonError";

/**
 * THE single definition of the `["python"]` runtime-preflight query. Every
 * consumer (App gate, StatusBar) MUST use this hook so the query has one key
 * AND one queryFn — a second `useQuery(["python"], …)` with a different queryFn
 * (e.g. the old `check_python` returning a bare boolean) would clobber the
 * Preflight object on refetch and bounce a healthy app to the error screen.
 */
export function usePreflight() {
  return useQuery({
    queryKey: ["python"],
    queryFn: () => invoke<Preflight>("runtime_preflight"),
    staleTime: Infinity,
  });
}
