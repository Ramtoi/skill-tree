import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useRegistry } from "@/hooks/useRegistry";
import { useAppStore } from "@/store";
import { useRunSync } from "@/hooks/useRunSync";
import { useUpdate } from "@/hooks/useUpdate";
import { Icon } from "@/components/Icon";
import { StatusBarWorking, useRunningCount } from "@/components/loading";

const APP_VERSION = __APP_VERSION__;

type RuntimeState = "ok" | "syncing" | "error";

export function StatusBar() {
  const { data: registry } = useRegistry();
  const { data: pythonOk } = useQuery({
    queryKey: ["python"],
    queryFn: () => invoke<boolean>("check_python"),
    staleTime: Infinity,
  });
  const syncStatus = useAppStore((s) => s.syncStatus);
  const openPalette = useAppStore((s) => s.openPalette);
  const runningCount = useRunningCount();
  const runSync = useRunSync();
  const { updateInfo, updateStatus, updateProgress, installUpdate } = useUpdate();

  const onUpdateClick = () => {
    if (!updateInfo) return;
    if (updateStatus === "available" || updateStatus === "error") {
      if (
        window.confirm(
          `Download and install Skill Tree v${updateInfo.version}? The app will restart.`
        )
      ) {
        void installUpdate();
      }
    }
  };

  let updateLabel: string | null = null;
  if (updateStatus === "available" && updateInfo) {
    updateLabel = `↑ v${updateInfo.version}`;
  } else if (updateStatus === "downloading") {
    updateLabel = `↓ ${updateProgress}%`;
  } else if (updateStatus === "ready") {
    updateLabel = "restarting…";
  } else if (updateStatus === "error") {
    updateLabel = "update failed";
  }

  let runtimeState: RuntimeState = "ok";
  let runtimeLabel = "registry · in sync";
  if (pythonOk === false) {
    runtimeState = "error";
    runtimeLabel = "python 3: not found";
  } else if (syncStatus === "syncing") {
    runtimeState = "syncing";
    runtimeLabel = "hub sync · writing…";
  } else if (syncStatus === "error") {
    runtimeState = "error";
    runtimeLabel = "sync failed";
  }

  const skills = registry ? Object.keys(registry.skills).length : 0;
  const bundles = registry ? Object.keys(registry.bundles).length : 0;
  const projects = registry ? Object.keys(registry.projects).length : 0;
  const registryPath = registry?.hub_path ?? "~/.config/skill-hub";

  return (
    <div className="app-status">
      {pythonOk !== false && runningCount > 0 ? (
        <StatusBarWorking />
      ) : (
        <button
          type="button"
          className="status-segment sync-chip"
          data-state={runtimeState}
          onClick={() => runSync()}
          disabled={pythonOk === false || runtimeState === "syncing"}
          title="Sync registry to disk"
        >
          <span className="sync-dot" data-state={runtimeState} />
          {runtimeLabel}
        </button>
      )}
      <span className="status-segment" title={registryPath}>
        <Icon name="source" size={11} />
        {registryPath}
      </span>
      <span className="status-segment">
        <Icon name="command" size={11} />
        tauri 2.0
      </span>
      <span className="status-spacer" />
      <span className="status-segment">
        <Icon name="skill" size={11} /> {skills} ·{" "}
        <Icon name="bundle" size={11} /> {bundles} ·{" "}
        <Icon name="project" size={11} /> {projects}
      </span>
      <span className="status-segment">v{APP_VERSION}</span>
      {updateLabel && (
        <button
          type="button"
          className="status-segment update-chip"
          data-update-state={updateStatus}
          onClick={onUpdateClick}
          disabled={updateStatus === "downloading" || updateStatus === "ready"}
          title={
            updateInfo
              ? `Skill Tree v${updateInfo.version} available — click to install`
              : "Update"
          }
        >
          {updateLabel}
        </button>
      )}
      <button
        type="button"
        className="status-segment clickable"
        onClick={() => openPalette()}
      >
        ⌘K palette
      </button>
    </div>
  );
}
