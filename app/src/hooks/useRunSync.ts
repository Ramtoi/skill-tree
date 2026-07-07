import { useCallback } from "react";
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
  const syncStatus = useAppStore((s) => s.syncStatus);

  return useCallback(async () => {
    if (syncStatus === "syncing") return;
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
      addToast("error", `Sync failed: ${String(err)}`);
    }
  }, [syncStatus, setSyncStatus, setLastSyncedAt, addToast]);
}
