import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          Edit path: <span className="text-mono">{projectName}</span>
        </>
      }
      width={540}
      aria-label={`Edit path for ${projectName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={submit.isPending}
            disabled={!newPath || mutating}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Updating…" : "Update Path"}
          </Button>
        </>
      }
    >
      <div className="modal-form">
        <Field label="Current path">
          <div className="readonly-value">{currentPath}</div>
        </Field>

        <Field label="New path">
          <div className="browse-row">
            <button
              type="button"
              className="readonly-value"
              data-empty={!newPath || undefined}
              onClick={pick}
              title={newPath || "Click to choose a folder"}
            >
              {newPath || "Click Browse to choose a folder…"}
            </button>
            <Button onClick={pick}>Browse…</Button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
