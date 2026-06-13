import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { useAppStore } from "@/store";
import { useHarnesses } from "@/hooks/useHarnesses";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessTint } from "@/components/harness/harnessRegistry";

export function GlobalHarnessesPanel() {
  const harnesses = useHarnesses();
  const rescan = useAppStore((s) => s.rescanHarnesses);
  const setMutating = useAppStore((s) => s.setMutating);
  const mutating = useAppStore((s) => s.mutating);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();

  const toggle = async (id: string, enabled: boolean) => {
    setMutating(true);
    try {
      await invoke("harness_set_global", { id, enabled });
      await rescan();
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      addToast("success", `${id} ${enabled ? "enabled" : "disabled"} globally`);
    } catch (err) {
      addToast("error", `Failed: ${String(err)}`);
    } finally {
      setMutating(false);
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
            const disabled = !h.installed || mutating;
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
                <input
                  type="checkbox"
                  aria-label={`Enable ${h.label} globally`}
                  checked={h.on_globally}
                  disabled={disabled}
                  onChange={(e) => void toggle(h.id, e.target.checked)}
                />
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
