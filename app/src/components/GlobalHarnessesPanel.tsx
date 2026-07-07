import { useState } from "react";
import { invoke } from "@/lib/ipc";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Spinner } from "@/components/loading";
import { useAppStore } from "@/store";
import { useHarnesses } from "@/hooks/useHarnesses";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessTint } from "@/components/harness/harnessRegistry";

export function GlobalHarnessesPanel() {
  const harnesses = useHarnesses();
  const rescan = useAppStore((s) => s.rescanHarnesses);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  // Per-harness in-flight set — only the toggled row disables; siblings stay
  // interactive. The ambient "something is happening" signal is the StatusBar
  // global busy indicator.
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  const toggle = async (id: string, enabled: boolean) => {
    if (pending.has(id)) return;
    setPending((p) => new Set(p).add(id));
    try {
      await invoke("harness_set_global", { id, enabled });
      await rescan();
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      addToast("success", `${id} ${enabled ? "enabled" : "disabled"} globally`);
    } catch (err) {
      addToast("error", `Failed: ${String(err)}`);
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <div className="tweak-section">
      <div className="tweak-section-label">Global Harnesses</div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-mute)",
          padding: "2px 0 8px",
          lineHeight: 1.4,
        }}
      >
        Codex and Pi share <code>.agents/skills/</code>. Enabling one is
        usually best paired with the other.
      </div>
      {harnesses.length === 0 ? (
        <div className="tweak-row">
          <span style={{ color: "var(--fg-mute)" }}>(detecting…)</span>
          <Button size="sm" variant="ghost" onClick={() => void rescan()}>
            Rescan
          </Button>
        </div>
      ) : (
        <>
          {harnesses.map((h) => {
            const isPending = pending.has(h.id);
            const disabled = !h.installed || isPending;
            return (
              <div
                key={h.id}
                className="tweak-row"
                style={{
                  ["--harness-accent" as string]: harnessTint(h.id),
                  opacity: h.installed ? 1 : 0.5,
                }}
              >
                <span className="tweak-harness-label">
                  <HarnessGlyph id={h.id} label={h.label} size={18} decorative />
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: h.on_globally
                        ? "var(--harness-accent)"
                        : "var(--fg-strong)",
                    }}
                  >
                    {h.label}
                  </span>
                  {!h.installed && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        color: "var(--fg-mute)",
                        textTransform: "uppercase",
                      }}
                    >
                      not installed
                    </span>
                  )}
                </span>
                <span className="tweak-harness-control">
                  {isPending && <Spinner size={11} color="currentColor" />}
                  <input
                    type="checkbox"
                    aria-label={`Enable ${h.label} globally`}
                    checked={h.on_globally}
                    disabled={disabled}
                    aria-busy={isPending || undefined}
                    onChange={(e) => void toggle(h.id, e.target.checked)}
                  />
                </span>
              </div>
            );
          })}
          <div className="tweak-row">
            <span style={{ color: "var(--fg-mute)", fontSize: 11 }}>
              Detection refresh
            </span>
            <Button size="sm" variant="ghost" onClick={() => void rescan()}>
              Rescan
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
