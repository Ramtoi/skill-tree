import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { invalidateRegistry } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import { useWorktreePreview } from "@/hooks/useWorktreeDefaults";
import type { Registry } from "@/types";

import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { ProjectRepositoryDialog } from "@/components/ProjectRepositoryDialog";
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
  const client = useQueryClient();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const mutating = useAppStore((s) => s.mutating);
  const setMutating = useAppStore((s) => s.setMutating);

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [repositoryOffer, setRepositoryOffer] = useState<{ name: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setPath("");
      setName("");
      setTouched(false);
      setRepositoryOffer(null);
    }
  }, [open]);

  const slugOk = name.length > 0 && SLUG_RE.test(name);
  const pathOk = path.length > 0;
  const preview = useWorktreePreview(name, path, undefined, open && slugOk && pathOk);
  const canSubmit = slugOk && pathOk && !mutating && !!preview.data && !preview.isError && !preview.isFetching;

  const pick = async () => {
    try {
      const chosen = await invoke<string | null>("pick_directory");
      if (chosen) {
        setPath(chosen);
        if (!touched) setName(deriveSlug(chosen));
      }
    } catch (err) {
      addToast("error", `Could not choose a project folder. ${String(err)}`);
    }
  };

  const submit = useMutation({
    mutationFn: async () => {
      setMutating(true);
      try {
        await invoke("project_add_with_path", { name, path });
        try {
          await invalidateRegistry(client);
          const registry = await client.fetchQuery({
            queryKey: qk.registry(), queryFn: () => invoke<Registry>("read_registry"), staleTime: 0,
          });
          return registry.projects[name]?.permissions?.worktree_access;
        } catch {
          return undefined;
        }
      } finally {
        setMutating(false);
      }
    },
    onSuccess: (worktree) => {
      addToast("success", worktree
        ? `Registered project ${name}. Worktree directory: ${worktree.path}. Agent access ${worktree.enabled ? "enabled; use Sync to apply supported grants" : "off"}.`
        : `Registered project ${name}. Reopen its Permissions to inspect the saved worktree settings.`);
      setRepositoryOffer({ name });
    },
    onError: (err: unknown) => {
      addToast("error", `Couldn't add project — ${err}`);
    },
  });

  return (
    <>
    <Modal
      open={open && !repositoryOffer}
      onClose={onClose}
      title="Add project"
      dismissable={!submit.isPending}
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
              disabled={submit.isPending}
              title={path || "Click to choose a folder"}
            >
              {path || "Click Browse to choose a folder…"}
            </button>
            <Button onClick={pick} disabled={submit.isPending}>Browse…</Button>
          </div>
        </Field>

        <Field label="Project name" htmlFor="add-project-name">
          <input
            type="text"
            className="text-mono"
            id="add-project-name"
            disabled={submit.isPending}
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
        {slugOk && pathOk && <div className="settings-path-preview" aria-live="polite">
          <span>Worktree access defaults</span>
          {preview.isError ? <div role="alert">
            <p>Could not preview defaults. {String(preview.error)}</p>
            <Button size="sm" variant="ghost" onClick={() => void preview.refetch()}>Retry preview</Button>
          </div> : !preview.data ? <p>Resolving worktree directory…</p> : <>
            <code>{preview.data.path}</code>
            <p>Agent access {preview.data.access_enabled ? "on" : "off"}. You can override both in project Permissions.</p>
            <p className="settings-help">Uses the defaults saved when you add this project. Adding creates no worktree directory.</p>
          </>}
        </div>}
      </div>
    </Modal>
    <ProjectRepositoryDialog
      open={open && !!repositoryOffer}
      mode="offer"
      projectName={repositoryOffer?.name ?? name}
      onClose={() => {
        if (!repositoryOffer) return;
        onClose();
        navigate(`/project/${encodeURIComponent(repositoryOffer.name)}`);
      }}
    />
    </>
  );
}
