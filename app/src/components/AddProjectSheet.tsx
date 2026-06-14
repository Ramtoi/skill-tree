import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { useAppStore } from "@/store";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SLUG_RE = /^[a-z0-9-]+$/;

function deriveSlug(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function AddProjectSheet({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) {
      setPath("");
      setName("");
      setTouched(false);
    }
  }, [open]);

  const slugOk = name.length > 0 && SLUG_RE.test(name);
  const pathOk = path.length > 0;
  const canSubmit = slugOk && pathOk && !mutating;

  const pick = async () => {
    const chosen = await invoke<string | null>("pick_directory");
    if (chosen) {
      setPath(chosen);
      if (!touched) setName(deriveSlug(chosen));
    }
  };

  const submit = useMutation({
    mutationFn: async () => {
      setMutating(true);
      try {
        await invoke("project_add_with_path", { name, path });
      } finally {
        setMutating(false);
      }
    },
    onSuccess: () => {
      addToast("success", `Registered project '${name}'`);
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      onClose();
    },
    onError: (err: unknown) => {
      addToast("error", `Add project failed: ${err}`);
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
          width: 520,
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 16, fontSize: 16 }}>Add Project</h2>

        <Field label="Project folder">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={path}
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

        <div style={{ marginTop: 12 }}>
          <Field label="Project name">
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
              placeholder="kebab-case-name"
              style={{
                width: "100%",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                padding: "6px 10px",
                background: "var(--bg-0)",
                border: "1px solid var(--bg-3)",
                borderRadius: 6,
                color: "var(--fg-strong)",
              }}
            />
            {name && !slugOk && (
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--red)" }}>
                must match ^[a-z0-9-]+$ (lowercase, digits, hyphens)
              </div>
            )}
          </Field>
        </div>

        <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Adding…" : "Add Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
