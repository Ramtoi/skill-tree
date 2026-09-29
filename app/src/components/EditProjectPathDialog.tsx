import { migrateProjectLoadoutOrder } from "@/hooks/useProjectLoadoutOrder";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { invalidateRegistry } from "@/lib/invalidate";
import { syncReportQueryFn } from "@/hooks/useSyncReport";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
  projectName: string;
  currentPath: string;
}

export function EditProjectPathDialog({ open, onClose, projectName, currentPath }: Props) {
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
      const startedAt = Date.now();
      setMutating(true);
      try {
        await invoke("project_edit_path", { name: projectName, newPath });
        return startedAt;
      } finally {
        setMutating(false);
      }
    },
    onSuccess: async (startedAt) => {
      let orderMoved = false;
      try {
        // The backend resolves symlinks. Use its saved identity for local layout.
        const registry = await invoke<Registry>("read_registry");
        const savedPath = registry.projects[projectName]?.path;
        if (savedPath) orderMoved = migrateProjectLoadoutOrder(currentPath, savedPath);
      } catch {
        // The project write succeeded. Keep the old preference recoverable.
      }
      if (!orderMoved) addToast("error", "Path updated, but the personal loadout order could not be moved.");
      try {
        const envelope = await syncReportQueryFn();
        const report = envelope?.report;
        const current = report && Date.parse(report.generated_at) >= startedAt - 5000;
        const delivery = current ? report.projects?.[projectName] : undefined;
        if (delivery && !delivery.ok) {
          addToast("info", `Path saved for ${projectName}. Delivery still has errors; review the sync report or finish setup in Backup.`);
        } else {
          addToast("success", `Updated path for ${projectName}`);
          if (!delivery) addToast("info", "Delivery status is unavailable. Review the sync report before retrying sync.");
        }
      } catch {
        addToast("info", `Path saved for ${projectName}. Delivery status could not be checked.`);
      }
      void invalidateRegistry();
      onClose();
    },
    onError: (err: unknown) => {
      addToast("error", `Couldn't update path — ${err}`);
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
            {submit.isPending ? "Updating…" : "Update path"}
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
