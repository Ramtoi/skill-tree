import { useEffect } from "react";
import { useAppStore, type HarnessStatus } from "@/store";

/**
 * Read-only hook that returns the cached harness list from the Zustand store
 * and rescans on first mount (idempotent — store already does nothing if
 * harness_list returns an error or stays the same).
 */
export function useHarnesses(): HarnessStatus[] {
  const harnesses = useAppStore((s) => s.harnesses);
  const rescan = useAppStore((s) => s.rescanHarnesses);
  useEffect(() => {
    if (harnesses.length === 0) {
      void rescan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return harnesses;
}
