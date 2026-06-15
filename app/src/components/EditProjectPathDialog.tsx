import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { useAppStore } from "@/store";

interface Props {
  open: boolean;
  onClose: () => void;
  projectName: string;
  currentPath: string;
}

export function EditProjectPathDialog({ open, onClose, projectName, currentPath }: Props) {
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);

  const [newPath, setNewPath] = useState("");

  const pick = async () => {
    const chosen = await invoke<string | null>("pick_directory");
    if (chosen) setNewPath(chosen);
  };

  const submit = useMutation({
    mutationFn: async () => {
      setMutating(true);
      try {
        await invoke("project_edit_path", { name: projectName, newPath });
      } finally {
        setMutating(false);
      }
    },
    onSuccess: () => {
      addToast("success", `Updated path for '${projectName}'`);
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      onClose();
    },
    onError: (err: unknown) => {
      addToast("error", `Edit path failed: ${err}`);
    },
  });

  if (!open) return null;

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
          width: 540,
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 16, fontSize: 16 }}>
          Edit path: <span style={{ fontFamily: "var(--font-mono)" }}>{projectName}</span>
        </h2>

        <Field label="Current path">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--fg-mid)",
              padding: "6px 10px",
              background: "var(--bg-0)",
              border: "1px solid var(--bg-2)",
              borderRadius: 6,
            }}
          >
            {currentPath}
          </div>
        </Field>

        <div style={{ marginTop: 12 }}>
          <Field label="New path">
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={newPath}
                readOnly
                placeholder="Click Browse…"
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  padding: "6px 10px",
                  background: "var(--bg-0)",
                  border: "1px solid var(--bg-3)",
                  borderRadius: 6,
                  color: "var(--fg-strong)",
                }}
              />
              <Button onClick={pick}>Browse…</Button>
            </div>
          </Field>
        </div>

        <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!newPath || mutating || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Updating…" : "Update Path"}
          </Button>
        </div>
      </div>
    </div>
  );
}
