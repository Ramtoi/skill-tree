import { useCallback, useEffect } from "react";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import { errorDetail } from "@/lib/cliOutput";

/**
 * Self-update against the public GitHub release manifest (latest.json).
 *
 * `tauri-plugin-updater` reads the `plugins.updater.endpoints` configured in
 * tauri.conf.json, verifies the artifact's minisign signature against the baked
 * `pubkey`, then swaps the bundle in place. `relaunch()` restarts into the new
 * version.
 *
 * Everything is guarded so the hook is an inert no-op outside a Tauri runtime
 * (browser dev server, vitest/jsdom) and degrades silently when offline — the
 * same defensive posture as `rescanHarnesses` in the store.
 */

/** Process-card target id for the self-update run. */
export const UPDATE_TARGET = "app:update";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useUpdate() {
  const setUpdateInfo = useAppStore((s) => s.setUpdateInfo);
  const setUpdateStatus = useAppStore((s) => s.setUpdateStatus);
  const setUpdateProgress = useAppStore((s) => s.setUpdateProgress);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const updateProgress = useAppStore((s) => s.updateProgress);

  const checkForUpdate = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setUpdateStatus("checking");
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateInfo({ version: update.version, notes: update.body });
        setUpdateStatus("available");
      } else {
        setUpdateInfo(null);
        setUpdateStatus("idle");
      }
    } catch (err) {
      console.warn("update check failed", err);
      setUpdateStatus("idle");
    }
  }, [setUpdateInfo, setUpdateStatus]);

  /**
   * Download + install the available release.
   *
   * Reported through the app's ONE live-work banner (a process card) like every
   * other long-running action, rather than only as a `↓ 42%` status-bar chip.
   * It is driven imperatively instead of through `trackProcess` because this is
   * the app's one genuinely DETERMINATE process — the updater reports real
   * bytes, so the card gets a real progress bar instead of a fake indeterminate
   * one. The status-bar chip stays: it is the readout, the card is the banner.
   */
  const installUpdate = useCallback(async () => {
    if (!isTauri()) return;
    const proc = Processes.start({
      title: "Installing update",
      body: "checking release",
      kind: "remote",
      target: UPDATE_TARGET,
      indeterminate: true,
    });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      const update = await check();
      if (!update) {
        setUpdateStatus("idle");
        Processes.succeed(proc, "already up to date");
        return;
      }
      setUpdateStatus("downloading");
      setUpdateProgress(0);

      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            Processes.update(proc, {
              body: `downloading v${update.version}`,
              // Only claim determinate progress when the server sent a length;
              // a Content-Length-less download would otherwise pin the bar at 0.
              indeterminate: total === 0,
              progress: total === 0 ? null : 0,
            });
            break;
          case "Progress": {
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.min(1, downloaded / total);
              setUpdateProgress(Math.round(pct * 100));
              Processes.update(proc, { progress: pct });
            }
            break;
          }
          case "Finished":
            setUpdateProgress(100);
            Processes.update(proc, { body: "installing", progress: 1 });
            break;
        }
      });

      setUpdateStatus("ready");
      Processes.succeed(proc, "installed — restarting");
      await relaunch();
    } catch (err) {
      console.warn("update install failed", err);
      setUpdateStatus("error");
      Processes.fail(proc, errorDetail(err).headline, {
        retry: () => void installUpdate(),
      });
    }
  }, [setUpdateStatus, setUpdateProgress]);

  // Check once on mount.
  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  return {
    updateInfo,
    updateStatus,
    updateProgress,
    checkForUpdate,
    installUpdate,
  };
}
