import { useCallback, useRef } from "react";
import { invoke } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";

/**
 * The one registry-sync flow, shared by the StatusBar chip and any other
 * surface that writes the resolved loadout to disk. Runs `hub sync`, refreshes
 * the registry query, and drives the global sync status + toasts.
 */
export function useRunSync(): () => Promise<void> {
  const setSyncStatus = useAppStore((s) => s.setSyncStatus);
  const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);
  const addToast = useAppStore((s) => s.addToast);

  // Synchronous in-flight guard: subscribed store state only updates on the
  // next render, so two triggers in the same tick would both read "idle" and
  // spawn a second `hub sync` (the backend .lock then fails the loser → a
  // spurious "Sync failed" toast). A ref flips immediately, closing the window.
  const inFlight = useRef(false);

  return useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncStatus("syncing");
    try {
      const result = await invoke<{ success: boolean; output: string }>(
        "hub_cmd",
        { args: ["sync"] },
      );
      if (!result.success) throw new Error(result.output);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      await queryClient.invalidateQueries({ queryKey: ["syncReport"] });
      setSyncStatus("synced");
      setLastSyncedAt(new Date());
      addToast("success", "Sync complete — registry aligned");
      setTimeout(() => setSyncStatus("idle"), 4000);
    } catch (err) {
      setSyncStatus("error");
      addToast("error", `Couldn't sync — ${String(err)}`);
    } finally {
      inFlight.current = false;
    }
  }, [setSyncStatus, setLastSyncedAt, addToast]);
}
