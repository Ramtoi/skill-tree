import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import {
  useClearProjectRepository,
  useInspectProjectRepository,
  useProjectRepository,
  useSetProjectRepository,
} from "@/hooks/useProjectRepository";
import type { RepositoryAssociation, RepositoryInspection } from "@/lib/projectRepository";

export type ProjectRepositoryDialogMode = "offer" | "manage";

interface Props {
  open: boolean;
  onClose: () => void;
  projectName: string;
  mode?: ProjectRepositoryDialogMode;
}

function AssociationSummary({ association }: { association: RepositoryAssociation }) {
  return (
    <dl className="settings-details">
      <div><dt>Remote</dt><dd><code>{association.remote}</code></dd></div>
      <div><dt>Repository</dt><dd><code>{association.url}</code></dd></div>
      <div><dt>Subdirectory</dt><dd><code>{association.subdirectory}</code></dd></div>
    </dl>
  );
}

function InspectionSummary({ inspection }: { inspection: RepositoryInspection }) {
  return (
    <div className="settings-path-preview" aria-live="polite">
      <span>Detected checkout</span>
      <AssociationSummary association={inspection.association} />
      <p className="settings-help">
        {inspection.is_worktree ? "Linked Git worktree" : "Primary Git checkout"} · {inspection.git_root}
      </p>
    </div>
  );
}

export function ProjectRepositoryDialog({
  open,
  onClose,
  projectName,
  mode = "manage",
}: Props) {
  const saved = useProjectRepository(projectName, open && mode === "manage");
  const inspect = useInspectProjectRepository();
  const connect = useSetProjectRepository();
  const clear = useClearProjectRepository();
  const [remote, setRemote] = useState("origin");
  const [inspection, setInspection] = useState<RepositoryInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setInspection(null);
    setError(null);
    setRemote("origin");
  }, [open, mode, projectName]);

  useEffect(() => {
    const savedRemote = saved.data?.repository?.remote;
    if (open && mode === "manage" && savedRemote) setRemote(savedRemote);
  }, [open, mode, projectName, saved.data?.repository?.remote]);

  const existing = mode === "manage" ? saved.data?.repository ?? null : null;
  const busy = inspect.isPending || connect.isPending || clear.isPending;
  const displayedError = error ?? (saved.isError ? String(saved.error) : null);

  useEffect(() => {
    // Native disabled buttons lose focus while a command runs. Restore it only
    // if the user has not focused another control, so Escape remains usable.
    if (open && !busy && document.activeElement === document.body && actionRef.current?.isConnected) {
      actionRef.current.focus();
    }
  }, [open, busy]);

  async function detect() {
    const selectedRemote = remote.trim();
    if (!selectedRemote) {
      setError("Enter a Git remote name.");
      return;
    }
    setError(null);
    try {
      const reply = await inspect.mutateAsync({ project: projectName, remote: selectedRemote });
      if (!reply.inspection) throw new Error("The backend returned no repository inspection.");
      setInspection(reply.inspection);
    } catch (err) {
      setInspection(null);
      setError(String(err));
    }
  }

  async function save() {
    if (!inspection || busy) return;
    setError(null);
    try {
      await connect.mutateAsync({ project: projectName, remote: remote.trim() });
      onClose();
    } catch (err) {
      setError(String(err));
    }
  }

  async function disconnect() {
    if (busy) return;
    setError(null);
    try {
      await clear.mutateAsync(projectName);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  }

  const title = mode === "offer" ? "Connect repository" : "Project repository";
  const isInitialOffer = mode === "offer" && !inspection;
  const hasExisting = mode === "manage" && !!existing;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<>{title}: <span className="text-mono">{projectName}</span></>}
      aria-label={`${title} for ${projectName}`}
      width={600}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {mode === "offer" ? "Skip for now" : "Close"}
          </Button>
          {hasExisting && !inspection && (
            <Button variant="danger" onClick={() => void disconnect()} busy={clear.isPending}>
              {clear.isError ? "Retry disconnect" : "Disconnect"}
            </Button>
          )}
          <Button
            variant="primary"
            busy={inspect.isPending || connect.isPending}
            disabled={busy || saved.isLoading || (!inspection && !remote.trim())}
            onClick={(event) => {
              actionRef.current = event.currentTarget;
              void (inspection ? save() : detect());
            }}
          >
            {inspection ? (hasExisting ? "Update repository" : "Connect repository") :
              (hasExisting ? "Detect current checkout" : "Detect repository")}
          </Button>
        </>
      }
    >
      <div className="modal-form">
        {mode === "offer" && isInitialOffer && (
          <p>
            This project is registered. Repository association is optional and can be added later.
            It makes repository-linked loadout bindings possible without changing project files.
          </p>
        )}
        {mode === "manage" && saved.isLoading && <p>Reading saved repository association…</p>}
        {hasExisting && !inspection && (
          <>
            <p>Repository association is saved for this project.</p>
            <AssociationSummary association={existing} />
            <p className="settings-help">
              Disconnecting preserves the project path and loadout. Repository-linked remote bindings may need review.
            </p>
          </>
        )}
        {(
          <Field
            label="Git remote"
            htmlFor={`project-repository-remote-${projectName}`}
            hint="Usually origin. Detection reads the local checkout and makes no changes."
          >
            <input
              id={`project-repository-remote-${projectName}`}
              type="text"
              className="text-mono"
              value={remote}
              disabled={busy || saved.isLoading}
              onChange={(event) => {
                setRemote(event.target.value);
                setInspection(null);
                setError(null);
              }}
            />
          </Field>
        )}
        {inspection && <InspectionSummary inspection={inspection} />}
        {displayedError && (
          <div className="settings-inline-error" role="alert">
            <span>{displayedError}</span>
            {mode === "manage" && saved.isError && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void saved.refetch()}>Retry read</Button>
            )}
            {mode === "offer" && !inspection && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void detect()}>Retry detection</Button>
            )}

          </div>
        )}
      </div>
    </Modal>
  );
}
