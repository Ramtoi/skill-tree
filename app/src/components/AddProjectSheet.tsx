import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
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
      addToast("success", `Registered project ${name}`);
      queryClient.invalidateQueries({ queryKey: ["registry"] });
      onClose();
    },
    onError: (err: unknown) => {
      addToast("error", `Couldn't add project — ${err}`);
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add project"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={submit.isPending}
            disabled={!canSubmit}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Adding…" : "Add project"}
          </Button>
        </>
      }
    >
      <div className="modal-form">
        <Field label="Project folder">
          <div className="browse-row">
            <button
              type="button"
              className="readonly-value"
              data-empty={!path || undefined}
              onClick={pick}
              title={path || "Click to choose a folder"}
            >
              {path || "Click Browse to choose a folder…"}
            </button>
            <Button onClick={pick}>Browse…</Button>
          </div>
        </Field>

        <Field label="Project name">
          <input
            type="text"
            className="text-mono"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
            placeholder="kebab-case-name"
            aria-invalid={!!(name && !slugOk)}
          />
          {name && !slugOk && (
            <span className="field-error" role="alert">
              must match ^[a-z0-9-]+$ (lowercase, digits, hyphens)
            </span>
          )}
        </Field>
      </div>
    </Modal>
  );
}
