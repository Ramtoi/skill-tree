import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/Button";
import { useAppStore } from "@/store";

interface Props {
  open: boolean;
  onClose: () => void;
  projectName: string;
  onRemoved?: () => void;
}

interface McpEntry {
  file: string;
  name: string;
}

export interface RemovalPlan {
  project: string;
  project_path: string;
  removed_symlinks: string[];
  removed_mcp_entries: McpEntry[];
  removed_empty_dirs: string[];
  warnings: string[];
}

export function RemoveProjectDialog({ open, onClose, projectName, onRemoved }: Props) {
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);

  // Refetch the preview whenever the dialog opens (or project changes)
  const [previewVersion, setPreviewVersion] = useState(0);
  useEffect(() => {
    if (open) setPreviewVersion((v) => v + 1);
  }, [open, projectName]);

  const preview = useQuery({
    queryKey: ["project-remove-preview", projectName, previewVersion],
    queryFn: () => invoke<RemovalPlan>("project_remove_preview", { name: projectName }),
    enabled: open,
    staleTime: 0,
  });

  const remove = useMutation({
    mutationFn: async () => {
      setMutating(true);
      try {
        await invoke("project_remove_clean", { name: projectName });
      } finally {
        setMutating(false);
      }
    },
    onSuccess: () => {
      addToast("success", `Removed project '${projectName}'`);
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      onRemoved?.();
      onClose();
    },
    onError: (err: unknown) => {
      addToast("error", `Remove failed: ${err}`);
    },
  });

  if (!open) return null;

  const plan = preview.data;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 600,
          maxHeight: "80vh",
          overflow: "auto",
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 16, fontSize: 16, color: "var(--red)" }}>
          Remove project: <span style={{ fontFamily: "var(--font-mono)" }}>{projectName}</span>
        </h2>

        {preview.isLoading && (
          <div style={{ color: "var(--fg-mute)" }}>Computing removal plan…</div>
        )}
        {preview.isError && (
          <div style={{ color: "var(--red)" }}>
            Failed to compute plan: {String(preview.error)}
          </div>
        )}

        {plan && (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-mid)", marginBottom: 12 }}>
              Path: <span style={{ fontFamily: "var(--font-mono)" }}>{plan.project_path}</span>
            </div>

            <h3 style={{ margin: "12px 0 6px", fontSize: 12, color: "var(--fg-mid)" }}>
              Hub-owned symlinks to delete ({plan.removed_symlinks.length})
            </h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {plan.removed_symlinks.length === 0 ? (
                <li style={{ color: "var(--fg-mute)" }}>(none)</li>
              ) : (
                plan.removed_symlinks.map((s) => <li key={s}>{s}</li>)
              )}
            </ul>

            <h3 style={{ margin: "12px 0 6px", fontSize: 12, color: "var(--fg-mid)" }}>
              MCP entries to remove ({plan.removed_mcp_entries.length})
            </h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {plan.removed_mcp_entries.length === 0 ? (
                <li style={{ color: "var(--fg-mute)" }}>(none)</li>
              ) : (
                plan.removed_mcp_entries.map((e) => (
                  <li key={`${e.file}:${e.name}`}>
                    {e.name} ← {e.file}
                  </li>
                ))
              )}
            </ul>

            {plan.removed_empty_dirs.length > 0 && (
              <>
                <h3 style={{ margin: "12px 0 6px", fontSize: 12, color: "var(--fg-mid)" }}>
                  Empty dirs to remove
                </h3>
                <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {plan.removed_empty_dirs.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </>
            )}

            {plan.warnings.length > 0 && (
              <>
                <h3 style={{ margin: "12px 0 6px", fontSize: 12, color: "var(--amber)" }}>
                  Warnings
                </h3>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--amber)" }}>
                  {plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!plan || mutating || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Removing…" : "Remove Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
