import { useRef, useState } from "react";
import { Sheet } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import {
  useHookList,
  useHookAttach,
  useHookDetach,
  type HookRow,
} from "@/hooks/useHooks";
import type { HubResult } from "@/types";

export function ProjectHooksSheet({
  projectName,
  open,
  onClose,
  navigate,
}: {
  projectName: string;
  open: boolean;
  onClose: () => void;
  navigate: (path: string) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Hooks on ${projectName}`}
      aria-label={`Hooks on ${projectName}`}
    >
      <ProjectHookAttachments projectName={projectName} navigate={navigate} />
    </Sheet>
  );
}
export function ProjectHookAttachments({
  projectName,
  navigate,
}: {
  projectName: string;
  navigate: (path: string) => void;
}) {
  const query = useHookList();
  const attach = useHookAttach();
  const detach = useHookDetach();
  const runUndoable = useUndoableAction();
  const toast = useToast();
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<string[]>([]);
  const [failure, setFailure] = useState<HookRow | null>(null);
  async function checked(promise: Promise<HubResult>) {
    const result = await promise;
    if (!result.success) throw new Error(result.output);
  }
  async function toggle(hook: HookRow) {
    if (pending.current.has(hook.name)) return;
    (
      document.activeElement?.closest('[role="dialog"]') as HTMLElement | null
    )?.focus();
    pending.current.add(hook.name);
    setBusy([...pending.current]);
    setFailure(null);
    const attached = hook.attached_projects.includes(projectName);
    const attachHere = () =>
      checked(attach.mutateAsync({ name: hook.name, project: projectName }));
    const detachHere = () =>
      checked(detach.mutateAsync({ name: hook.name, project: projectName }));
    try {
      await runUndoable({
        invalidate: [],
        do: attached ? detachHere : attachHere,
        undo: async () => {
          if (pending.current.has(hook.name))
            throw new Error("Wait for this hook's current change to finish.");
          pending.current.add(hook.name);
          setBusy([...pending.current]);
          try {
            await (attached ? attachHere() : detachHere());
          } finally {
            pending.current.delete(hook.name);
            setBusy([...pending.current]);
          }
        },
        label: attached
          ? `Removed ${hook.name}'s project attachment${hook.attached_global ? "; still inherited globally" : ""}`
          : `Attached ${hook.name} to ${projectName}`,
      });
    } catch (error) {
      setFailure(hook);
      toast.error("Couldn't change hook attachment", String(error));
    } finally {
      pending.current.delete(hook.name);
      setBusy([...pending.current]);
    }
  }
  return (
    <div className="project-hook-attachments">
      <p>Project attachments apply here. Global hooks stay inherited.</p>
      <Button
        variant="ghost"
        size="sm"
        icon="arrow-right"
        onClick={() => navigate("/hooks")}
      >
        Open hook library
      </Button>
      {query.isError ? (
        <p>
          Could not read hooks.{" "}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </p>
      ) : query.isPending ? (
        <p>Reading hooks…</p>
      ) : !query.data?.hooks?.length ? (
        <p>
          No hooks in the library.{" "}
          <Button onClick={() => navigate("/hook/new")}>Create hook</Button>
        </p>
      ) : (
        <div role="group" aria-label="Project hooks">
          {query.data.hooks.map((hook) => {
            const local = hook.attached_projects.includes(projectName);
            const inheritedOnly = hook.attached_global && !local;
            return (
              <div className="project-hook-row" key={hook.name}>
                <Toggle
                  checked={local || hook.attached_global}
                  disabled={busy.includes(hook.name) || inheritedOnly}
                  onChange={() => void toggle(hook)}
                  ariaLabel={`${local ? "Detach" : inheritedOnly ? "Inherited" : "Attach"} ${hook.name}`}
                  label={<span className="text-mono">{hook.name}</span>}
                />
                <span>
                  {hook.event} · {hook.attached_global ? "global" : ""}
                  {hook.attached_global && local ? " + " : ""}
                  {local ? "project" : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    navigate(`/hook/${encodeURIComponent(hook.name)}`)
                  }
                >
                  Edit
                </Button>
                {hook.attached_global && local && (
                  <small>Removing this attachment keeps the global hook.</small>
                )}
              </div>
            );
          })}
        </div>
      )}
      {failure && (
        <p role="alert">
          Attachment unchanged.{" "}
          <Button
            onClick={() =>
              void toggle(
                query.data?.hooks.find((hook) => hook.name === failure.name) ??
                  failure,
              )
            }
          >
            Retry {failure.name}
          </Button>
        </p>
      )}
    </div>
  );
}
