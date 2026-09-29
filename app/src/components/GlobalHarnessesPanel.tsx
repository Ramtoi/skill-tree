import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { invalidateRegistry } from "@/lib/invalidate";

import { LoadingButton, Spinner } from "@/components/loading";
import { Toggle } from "@/components/Toggle";
import { useAppStore } from "@/store";
import { useHarnesses } from "@/hooks/useHarnesses";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessTint } from "@/components/harness/harnessRegistry";

export function GlobalHarnessesPanel({ onPendingChange }: { onPendingChange?: (pending: boolean) => void } = {}) {
  const harnesses = useHarnesses();
  const rescan = useAppStore((s) => s.rescanHarnesses);
  const addToast = useAppStore((s) => s.addToast);
  const harnessesError = useAppStore((s) => s.harnessesError);
  const detecting = useAppStore((s) => s.harnessScans > 0);
  // Per-harness in-flight set — only the toggled row disables; siblings stay
  // interactive. The ambient "something is happening" signal is the StatusBar
  // global busy indicator.
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  // Both Rescan buttons in this panel drive the SAME probe, so they share one
  // busy flag — a scan started from the empty state must not leave the footer
  // button looking idle and re-clickable.
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    // Rescans are reads and may remain available while Settings dismisses;
    // only a write owns the dialog's close guard.
    onPendingChange?.(pending.size > 0);
  }, [onPendingChange, pending, scanning]);

  const doRescan = async () => {
    if (scanning || detecting) return;
    setScanning(true);
    try {
      await rescan();
    } finally {
      setScanning(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    if (pending.has(id)) return;
    setPending((p) => new Set(p).add(id));
    try {
      await invoke("harness_set_global", { id, enabled });
      await rescan();
      void invalidateRegistry();
      const refreshed = !useAppStore.getState().harnessesError;
      addToast(
        refreshed ? "success" : "error",
        refreshed
          ? `${id} ${enabled ? "enabled" : "disabled"} globally — run Sync to update agent configuration`
          : `${id} global membership changed, but the installed harness list could not be refreshed — rescan to verify`,
      );
    } catch (err) {
      addToast("error", `Couldn't update harness — ${String(err)}`);
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <div className="settings-section settings-harnesses">
      <div className="settings-section-label">Harnesses enabled for all projects</div>
      <p className="settings-help">
        This changes global membership only. Run Sync to update agent configuration;
        project-specific membership can still keep an agent enabled.
      </p>
      {harnessesError && (
        <div className="settings-inline-error" role="alert">
          Couldn't detect installed harnesses. {harnessesError}
        </div>
      )}
      {harnesses.length === 0 ? (
        <div className="settings-row">
          <span className="settings-muted">{detecting ? "Detecting…" : harnessesError ? "Detection failed" : "No installed harnesses detected"}</span>
          <LoadingButton
            size="sm"
            variant="ghost"
            loading={scanning || detecting}
            loadingLabel="Scanning…"
            onClick={() => void doRescan()}
          >
            Rescan
          </LoadingButton>
        </div>
      ) : (
        <>
          {harnesses.map((h) => {
            const isPending = pending.has(h.id);
            const disabled = !h.installed || isPending;
            return (
              <div
                key={h.id}
                className="settings-row"
                style={{
                  ["--harness-accent" as string]: harnessTint(h.id),
                }}
                data-disabled={!h.installed || undefined}
              >
                <span className="settings-harness-label">
                  <HarnessGlyph id={h.id} label={h.label} size={18} decorative />
                  <span className="settings-harness-name" data-enabled={h.on_globally || undefined}>
                    {h.label}
                  </span>
                  {!h.installed && (
                    <span className="settings-harness-status">not installed</span>
                  )}
                  {h.used_by_projects?.length > 0 && (
                    <span className="settings-harness-status">
                      {h.used_by_projects.length} project{h.used_by_projects.length === 1 ? "" : "s"} pinned
                    </span>
                  )}
                </span>
                <span className="settings-harness-control">
                  {isPending && <Spinner size={11} color="currentColor" />}
                  <Toggle
                    variant="switch"
                    size="sm"
                    ariaLabel={`Enable ${h.label} globally`}
                    checked={h.on_globally}
                    disabled={disabled}
                    ariaBusy={isPending}
                    onChange={(next) => void toggle(h.id, next)}
                  />
                </span>
              </div>
            );
          })}
          <div className="settings-row">
            <span className="settings-muted">Detection refresh</span>
            <LoadingButton
              size="sm"
              variant="ghost"
              loading={scanning || detecting}
              loadingLabel="Scanning…"
              onClick={() => void doRescan()}
            >
              Rescan
            </LoadingButton>
          </div>
        </>
      )}
    </div>
  );
}
