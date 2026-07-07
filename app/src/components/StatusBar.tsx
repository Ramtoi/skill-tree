import { useState } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { usePreflight } from "@/hooks/usePreflight";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useAppStore } from "@/store";
import { useUpdate } from "@/hooks/useUpdate";
import { Icon } from "@/components/Icon";
import { SyncReportDrawer } from "@/components/SyncReportDrawer";
import { FreshnessDot } from "@/components/FreshnessBadge";
import {
  StatusBarWorking,
  StatusBarBusy,
  useRunningCount,
  useGlobalBusy,
} from "@/components/loading";

const APP_VERSION = __APP_VERSION__;

type RuntimeState = "ok" | "syncing" | "error" | "unknown";

export function StatusBar() {
  const { data: registry } = useRegistry();
  // Same shared query as the App gate — derive ok from the Preflight object.
  // A second query here with a boolean queryFn would clobber the object.
  const { data: preflight } = usePreflight();
  const pythonOk = preflight?.ok;
  // Honest "never synced" signal (C2): `sync_report` resolves to `null` until
  // the first `hub sync` ever runs, so the chip must not default to "in sync".
  const { data: syncEnvelope } = useSyncReport();
  const everSynced = !!syncEnvelope?.report;
  const syncStatus = useAppStore((s) => s.syncStatus);
  const chordPending = useAppStore((s) => s.chordPending);
  const openPalette = useAppStore((s) => s.openPalette);
  const runningCount = useRunningCount();
  const { busy: globalBusy, longRunning } = useGlobalBusy();
  const [reportOpen, setReportOpen] = useState(false);
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
    // After 5s of a pending sync, add a calm hint — sync also pushes remotes on
    // an explicit run, which can take a while.
    runtimeLabel = longRunning
      ? "hub sync · still working — this can take a while"
      : "hub sync · writing…";
  } else if (syncStatus === "error") {
    runtimeState = "error";
    runtimeLabel = "sync failed";
  } else if (syncEnvelope === undefined) {
    // The sync-report query is still pending — DON'T assert "not synced yet"
    // (a cold-load flash). Show a neutral checking state until it resolves.
    runtimeState = "unknown";
    runtimeLabel = "registry · checking…";
  } else if (!everSynced) {
    runtimeState = "unknown";
    runtimeLabel = "registry · not synced yet";
  }

  const skills = registry ? Object.keys(registry.skills).length : 0;
  const bundles = registry ? Object.keys(registry.bundles).length : 0;
  const projects = registry ? Object.keys(registry.projects).length : 0;
  const registryPath = registry?.hub_path ?? "~/.config/skill-hub";

  return (
    <div className="app-status">
      {chordPending && (
        <span className="status-segment chord-pending-chip" data-pending="true">
          <span className="chord-pending-key">{chordPending}</span>
          <span className="chord-pending-ellipsis">…</span>
        </span>
      )}
      {/* Screen-reader announcement for the pending chord (clears on complete). */}
      <span className="sr-only" aria-live="polite" role="status">
        {chordPending ? `${chordPending} — waiting for next key` : ""}
      </span>
      {pythonOk !== false && runningCount > 0 ? (
        <StatusBarWorking />
      ) : pythonOk !== false && globalBusy && syncStatus !== "syncing" ? (
        // Generic in-flight IPC (equip, save, toggle…) with no richer named
        // process and no sync in progress — the sync chip owns the syncing view.
        <StatusBarBusy longRunning={longRunning} />
      ) : (
        <span className="sync-chip-wrap">
          <button
            type="button"
            className="status-segment sync-chip"
            data-state={runtimeState}
            data-tour="sync"
            onClick={() => setReportOpen((o) => !o)}
            disabled={pythonOk === false}
            aria-expanded={reportOpen}
            title="Show sync report"
          >
            {runtimeState === "unknown" ? (
              <FreshnessDot state="unknown" size={7} />
            ) : (
              <span className="sync-dot" data-state={runtimeState} />
            )}
            {runtimeLabel}
          </button>
          <SyncReportDrawer
            open={reportOpen}
            onClose={() => setReportOpen(false)}
          />
        </span>
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
