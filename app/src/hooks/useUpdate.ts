import { useCallback, useEffect } from "react";
import { useAppStore } from "@/store";

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

  const installUpdate = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      const update = await check();
      if (!update) {
        setUpdateStatus("idle");
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
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) {
              setUpdateProgress(Math.min(100, Math.round((downloaded / total) * 100)));
            }
            break;
          case "Finished":
            setUpdateProgress(100);
            break;
        }
      });

      setUpdateStatus("ready");
      await relaunch();
    } catch (err) {
      console.warn("update install failed", err);
      setUpdateStatus("error");
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
