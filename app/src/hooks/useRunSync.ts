import { useCallback, useRef } from "react";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { runHubCmd } from "@/lib/hubCmd";
import { invoke } from "@/lib/ipc";
import { errorDetail } from "@/lib/cliOutput";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import {
  classifySyncFailure,
  type SyncReportEnvelope,
} from "@/lib/syncFreshness";

/** Process-card target id for the registry sync, so a surface can bind a row
 *  progress bar to the run the way `SourceCard` binds one per source. */
export const SYNC_TARGET = "hub:sync";

/**
 * The one registry-sync flow, shared by the StatusBar chip and every other
 * surface that writes the resolved loadout to disk. Runs `hub sync` inside a
 * process card (the app's one live-work banner), refreshes the registry query,
 * and drives the global sync status + toasts.
 *
 * Screens MUST NOT roll their own `runHubCmd(["sync"])`: two of them used to,
 * which meant the identical command reported itself as a process card from the
 * Library and as a bare toast from the StatusBar. One command, one banner.
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

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncStatus("syncing");
    const startedAt = Date.now();
    const refresh = async () => {
      await invalidateRegistry(queryClient);
      // A sync derives `CLAUDE.md` from `AGENTS.md` under the symlink/import
      // root strategy, so the map is stale the moment one finishes.
      await queryClient.invalidateQueries({ queryKey: qk.agentDocs.all() });
      await queryClient.invalidateQueries({ queryKey: qk.agentDocs.dirMetaAll() });
    };
    try {
      await trackProcess(
        {
          title: "Registry sync",
          body: "writing .claude / .agents",
          kind: "local",
          target: SYNC_TARGET,
        },
        async () => {
          await runHubCmd(["sync"]);
          await refresh();
        },
        { successBody: "registry aligned", retry: () => void run() },
      );
      setSyncStatus("synced");
      setLastSyncedAt(new Date());
      addToast("success", "Sync complete — registry aligned");
      setTimeout(() => setSyncStatus("idle"), 4000);
    } catch (err) {
      // `hub sync` exits non-zero on doctor DANGER findings even when every
      // write succeeded (the doctor rollup). That run applied everything, so
      // it must not read as a failed sync — classify via the report this run
      // just wrote before choosing the toast.
      let cls: "danger_only" | "hard_failure" = "hard_failure";
      try {
        const envelope = await invoke<SyncReportEnvelope | null>("sync_report");
        cls = classifySyncFailure(envelope, startedAt);
      } catch {
        /* report unreadable — treat as a hard failure below */
      }
      if (cls === "danger_only") {
        await refresh();
        setSyncStatus("synced");
        setLastSyncedAt(new Date());
        addToast(
          "info",
          "Synced — the doctor flagged danger findings. See Permissions → Doctor.",
        );
        setTimeout(() => setSyncStatus("idle"), 4000);
      } else {
        setSyncStatus("error");
        // The toast has no log surface, so it gets the ONE line that says what
        // broke — stderr-first and ANSI-stripped, never the raw stdout+stderr
        // blob (which led with a stdout warning while the real error hid below).
        addToast("error", `Couldn't sync — ${errorDetail(err).headline}`);
      }
    } finally {
      inFlight.current = false;
    }
  }, [setSyncStatus, setLastSyncedAt, addToast]);

  return run;
}

/**
 * Is a registry sync in flight right now?
 *
 * The one busy signal every Sync control reads, so the StatusBar chip, the
 * project header and the sync-report drawer can never disagree about whether
 * `hub sync` is running. Deliberately NOT `syncStatus !== "idle"`: the store
 * parks on "synced" for 4s afterwards, which is a result, not work in flight.
 */
export function useSyncing(): boolean {
  return useAppStore((s) => s.syncStatus === "syncing");
}
