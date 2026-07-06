import { useEffect, useRef } from "react";
import { invoke } from "@/lib/ipc";
import { Icon } from "@/components/Icon";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";
import { useTweaks, type Tweaks } from "@/hooks/useTweaks";
import { GlobalHarnessesPanel } from "@/components/GlobalHarnessesPanel";
import { Toggle } from "@/components/Toggle";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TweaksPanelInner({ open, onClose }: Props) {
  const [t, setTweak] = useTweaks();
  const setSyncStatus = useAppStore((s) => s.setSyncStatus);
  const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);
  const addToast = useAppStore((s) => s.addToast);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Demo: trigger sync when toggled on
  const lastDemoSync = useRef(false);
  useEffect(() => {
    if (t.demoSync && !lastDemoSync.current) {
      lastDemoSync.current = true;
      (async () => {
        setSyncStatus("syncing");
        addToast("info", "Demo sync — writing .claude / .agents");
        try {
          const result = await invoke<{ success: boolean; output: string }>(
            "hub_cmd",
            { args: ["sync"] },
          );
          if (!result.success) throw new Error(result.output);
          await queryClient.invalidateQueries({ queryKey: ["registry"] });
          setSyncStatus("synced");
          setLastSyncedAt(new Date());
          addToast("success", "Sync complete");
        } catch (err) {
          setSyncStatus("error");
          addToast("error", `Sync failed: ${String(err)}`);
        } finally {
          setTweak("demoSync", false);
          lastDemoSync.current = false;
          setTimeout(() => setSyncStatus("idle"), 3000);
        }
      })();
    }
  }, [t.demoSync, addToast, setLastSyncedAt, setSyncStatus, setTweak]);

  // Demo: python missing — must match the Preflight object shape the ["python"]
  // query holds (a bare `false` would corrupt the gate's `preflight?.ok` read).
  useEffect(() => {
    if (t.demoError) {
      queryClient.setQueryData(["python"], {
        ok: false,
        reason: "no-python",
        detail: null,
        python: null,
      });
    } else {
      queryClient.invalidateQueries({ queryKey: ["python"] });
    }
  }, [t.demoError]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  if (!open) return null;

  const densities: Tweaks["density"][] = ["compact", "default", "cozy"];

  return (
    <div ref={panelRef} className="tweaks-panel" role="dialog" aria-label="Tweaks">
      <div className="tweak-section">
        <div className="tweak-section-label">Aesthetic</div>
        <div className="tweak-row">
          <span>Density</span>
          <div className="radio-row">
            {densities.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={t.density === d}
                onClick={() => setTweak("density", d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="tweak-row">
          <span>Show icon rail</span>
          <Toggle
            variant="switch"
            size="sm"
            ariaLabel="Show icon rail"
            checked={t.showRail}
            onChange={(v) => setTweak("showRail", v)}
          />
        </div>
      </div>

      <GlobalHarnessesPanel />

      <div className="tweak-section">
        <div className="tweak-section-label">Demos</div>
        <div className="tweak-row">
          <span>Trigger sync</span>
          <input
            type="checkbox"
            aria-label="Trigger sync"
            checked={t.demoSync}
            onChange={(e) => setTweak("demoSync", e.target.checked)}
          />
        </div>
        <div className="tweak-row">
          <span>Python missing</span>
          <input
            type="checkbox"
            aria-label="Python missing"
            checked={t.demoError}
            onChange={(e) => setTweak("demoError", e.target.checked)}
          />
        </div>
      </div>
    </div>
  );
}

export function TweaksPanel({ open, onClose }: Props) {
  return <TweaksPanelInner open={open} onClose={onClose} />;
}

export function TweaksToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="tweaks-toggle"
      title="Tweaks"
      aria-label="Tweaks"
      onClick={onClick}
    >
      <Icon name="cog" size={14} />
    </button>
  );
}
