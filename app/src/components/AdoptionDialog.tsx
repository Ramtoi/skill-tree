import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./Button";
import { Tag } from "./Tag";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import {
  harnessTint,
  harnessDisplayLabel,
} from "./harness/harnessRegistry";
import type { AdoptionRequired, AdoptResult } from "@/types/permissions";

export interface AdoptionDialogProps {
  open: boolean;
  discovered: AdoptionRequired;
  onResolved: () => void;
  /** Optional harness labels for the table header. */
  harnessLabels?: Record<string, string>;
}

type Action = "import" | "replace" | "skip";

export function AdoptionDialog({
  open,
  discovered,
  onResolved,
  harnessLabels,
}: AdoptionDialogProps) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open || !discovered) return null;

  const entries = Object.entries(discovered).filter(
    ([, rules]) => Array.isArray(rules) && rules.length > 0,
  );
  if (entries.length === 0) return null;

  async function runAction(action: Action) {
    setBusy(action);
    setError(null);
    try {
      for (const [harness] of entries) {
        await invoke<AdoptResult>("permissions_adopt", {
          scope: { kind: "global" },
          action,
          harness,
        });
      }
      onResolved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="adoption-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: 720,
          maxHeight: "80vh",
          overflow: "auto",
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h2
          id="adoption-dialog-title"
          style={{
            margin: 0,
            marginBottom: 8,
            fontSize: 16,
            color: "var(--fg-strong)",
            fontFamily: "var(--font-sans)",
          }}
        >
          Adopt existing global permissions
        </h2>
        <p
          style={{
            margin: 0,
            marginBottom: 16,
            color: "var(--fg-mid)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
          }}
        >
          We discovered rules in your native config files that the hub is not
          managing yet. Pick how to handle them before editing global
          permissions.
        </p>

        {entries.map(([harness, rules]) => (
          <div key={harness} style={{ marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <Tag
                color={harnessTint(harness)}
                style={{
                  fontFamily: "var(--font-mono)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <HarnessGlyph
                  id={harness}
                  label={harnessDisplayLabel(harness, harnessLabels)}
                  size={14}
                  decorative
                />
                {harnessDisplayLabel(harness, harnessLabels)}
              </Tag>
              <span
                style={{
                  color: "var(--fg-mute)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {rules.length} rule{rules.length === 1 ? "" : "s"}
              </span>
            </div>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
              }}
            >
              <thead>
                <tr style={{ color: "var(--fg-dim)", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px", width: 80 }}>kind</th>
                  <th style={{ padding: "4px 8px" }}>pattern</th>
                  <th style={{ padding: "4px 8px" }}>source</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr
                    key={`${r.pattern}:${r.kind}:${i}`}
                    style={{
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <td style={{ padding: "4px 8px", color: "var(--fg-mid)" }}>
                      {r.kind}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--fg-strong)" }}>
                      {r.pattern}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--fg-mute)" }}>
                      {r.source_file}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {error && (
          <div
            role="alert"
            style={{
              padding: 10,
              borderRadius: "var(--radius)",
              border: "1px solid var(--red)",
              color: "var(--red)",
              marginBottom: 16,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 12,
          }}
        >
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void runAction("skip")}
          >
            {busy === "skip" ? "Skipping…" : "Skip (mark unmanaged)"}
          </Button>
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void runAction("replace")}
          >
            {busy === "replace" ? "Replacing…" : "Replace"}
          </Button>
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void runAction("import")}
          >
            {busy === "import" ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
