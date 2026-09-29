import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { Tag } from "./Tag";
import { ConfirmDialog } from "./Modal";
import { Toggle } from "./Toggle";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import { harnessLabel } from "./harness/harnessRegistry";
import type {
  DisableEntry,
  DisableMode,
  DisableResult,
  Scope,
} from "@/types/permissions";

export type DisableTarget =
  | { kind: "just_scope"; scope: Scope }
  | { kind: "all_projects" }
  | { kind: "everything" };

export interface DisableDialogProps {
  open: boolean;
  /** Scope the dialog was launched from (drives the `Just this scope` label). */
  fromScope: Scope;
  /** N for the "All projects" copy. */
  projectCount: number;
  onClose: () => void;
  /** Receives the apply result so the caller can invalidate every touched scope. */
  onApplied: (result: DisableResult) => void;
}

function targetMatchesScope(t: DisableTarget, s: Scope): boolean {
  if (t.kind !== "just_scope") return false;
  if (t.scope.kind !== s.kind) return false;
  if (t.scope.kind === "project" && s.kind === "project")
    return t.scope.name === s.name;
  return true;
}

function toRustTarget(t: DisableTarget): unknown {
  // Mirrors the Rust enum (rename_all = "snake_case", tag = "kind"):
  //   JustScope { scope }, AllProjects, Everything
  if (t.kind === "just_scope")
    return { kind: "just_scope", scope: t.scope };
  if (t.kind === "all_projects") return { kind: "all_projects" };
  return { kind: "everything" };
}

export function DisableDialog({
  open,
  fromScope,
  projectCount,
  onClose,
  onApplied,
}: DisableDialogProps) {
  const [target, setTarget] = useState<DisableTarget>({
    kind: "just_scope",
    scope: fromScope,
  });
  const [mode, setMode] = useState<DisableMode>("restore");
  const [preview, setPreview] = useState<DisableResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmTicked, setConfirmTicked] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget({ kind: "just_scope", scope: fromScope });
    setMode("restore");
    setConfirmTicked(false);
    setApplyError(null);
  }, [open, fromScope]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    (async () => {
      try {
        const result = await invoke<DisableResult>("permissions_disable", {
          target: toRustTarget(target),
          mode,
          apply: false,
        });
        if (!cancelled) setPreview(result);
      } catch (e) {
        if (!cancelled) setPreviewError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, target, mode]);

  if (!open) return null;

  const needsConfirm =
    target.kind === "everything" || target.kind === "all_projects";
  const confirmCopy =
    target.kind === "everything"
      ? "I understand this affects every project and the global scope"
      : `I understand this affects all ${projectCount} project${projectCount === 1 ? "" : "s"}`;

  const canApply =
    !applying &&
    preview !== null &&
    preview.entries.length > 0 &&
    (!needsConfirm || confirmTicked);

  async function applyNow() {
    setApplying(true);
    setApplyError(null);
    try {
      const result = await invoke<DisableResult>("permissions_disable", {
        target: toRustTarget(target),
        mode,
        apply: true,
      });
      onApplied(result);
      onClose();
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => void applyNow()}
      title="Disable hub-managed permissions"
      tone="danger"
      width={720}
      busy={applying}
      confirmDisabled={!canApply}
      confirmLabel={applying ? "Applying…" : "Confirm and apply"}
      body={
        <div className="disable-dialog-body">
        <fieldset
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <legend
            style={{ padding: "0 6px", color: "var(--fg-mid)", fontSize: 12 }}
          >
            Target
          </legend>
          <label style={radioStyle}>
            <input
              type="radio"
              name="target"
              checked={targetMatchesScope(target, fromScope)}
              onChange={() =>
                setTarget({ kind: "just_scope", scope: fromScope })
              }
            />
            <span>
              Just this scope —{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {fromScope.kind === "global" ? "global" : fromScope.name}
              </span>
            </span>
          </label>
          <label style={radioStyle}>
            <input
              type="radio"
              name="target"
              checked={target.kind === "all_projects"}
              onChange={() => setTarget({ kind: "all_projects" })}
            />
            <span>All projects ({projectCount})</span>
          </label>
          <label style={radioStyle}>
            <input
              type="radio"
              name="target"
              checked={target.kind === "everything"}
              onChange={() => setTarget({ kind: "everything" })}
            />
            <span>Everything (incl. global)</span>
          </label>
        </fieldset>

        <fieldset
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <legend
            style={{ padding: "0 6px", color: "var(--fg-mid)", fontSize: 12 }}
          >
            Mode
          </legend>
          <label style={radioStyle}>
            <input
              type="radio"
              name="mode"
              checked={mode === "restore"}
              onChange={() => setMode("restore")}
            />
            <span>Restore from backup</span>
          </label>
          <label style={radioStyle}>
            <input
              type="radio"
              name="mode"
              checked={mode === "detach"}
              onChange={() => setMode("detach")}
            />
            <span>Detach — keep current rules, take back native control</span>
          </label>
        </fieldset>

        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-mid)",
              marginBottom: 6,
              fontFamily: "var(--font-sans)",
            }}
          >
            Dry-run preview
          </div>
          {previewError && (
            <div role="alert" style={errorStyle}>
              {previewError}
            </div>
          )}
          {!previewError && !preview && (
            <div style={{ color: "var(--fg-mute)", fontSize: 12 }}>
              Resolving…
            </div>
          )}
          {preview && <DisableEntriesTable entries={preview.entries} />}
        </div>

        {needsConfirm && (
          <Toggle
            className="disable-confirm"
            checked={confirmTicked}
            onChange={setConfirmTicked}
            ariaLabel={confirmCopy}
            label={<span className="disable-confirm-copy">{confirmCopy}</span>}
          />
        )}

        {applyError && (
          <div role="alert" style={errorStyle}>
            {applyError}
          </div>
        )}
        </div>
      }
    />
  );
}

function DisableEntriesTable({ entries }: { entries: DisableEntry[] }) {
  if (entries.length === 0)
    return (
      <div style={{ color: "var(--fg-mute)", fontSize: 12 }}>
        Nothing to do — no managed permissions for this target.
      </div>
    );
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "var(--fg-dim)" }}>
          <th style={th}>scope</th>
          <th style={th}>harness</th>
          <th style={th}>action</th>
          <th style={th}>target</th>
          <th style={th}>backup</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr
            key={`${e.scope_kind}:${e.scope_label}:${e.harness_id}:${i}`}
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <td style={td}>
              {e.scope_kind === "global" ? "global" : e.scope_label}
            </td>
            <td style={td}>
              <span className="inline-harness-source">
                <HarnessGlyph
                  id={e.harness_id}
                  label={harnessLabel(e.harness_id)}
                  size={14}
                  decorative
                />
                {harnessLabel(e.harness_id)}
              </span>
            </td>
            <td style={td}>
              <Tag
                color={
                  e.action === "restore"
                    ? "var(--green)"
                    : e.action === "detach"
                      ? "var(--amber)"
                      : "var(--fg-mute)"
                }
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {e.action}
              </Tag>
            </td>
            <td style={td}>{e.target_file}</td>
            <td style={td}>{e.backup_path ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const radioStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
  fontSize: 13,
  fontFamily: "var(--font-sans)",
  color: "var(--fg-strong)",
};

const th: React.CSSProperties = { padding: "4px 8px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "4px 8px", color: "var(--fg-mid)" };

const errorStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: "var(--radius)",
  border: "1px solid var(--red)",
  color: "var(--red)",
  fontSize: 12,
  marginBottom: 8,
};
