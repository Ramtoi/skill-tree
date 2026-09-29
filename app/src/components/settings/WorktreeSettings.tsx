import { useState } from "react";
import { Button } from "@/components/Button";
import { ChipRadios } from "@/components/ChipRadios";
import { Field } from "@/components/Field";
import { Toggle } from "@/components/Toggle";
import { useWorktreeDefaults, useSaveWorktreeDefaults, useWorktreePreview } from "@/hooks/useWorktreeDefaults";
import { useBackupStatus } from "@/hooks/useBackup";
import { invoke } from "@/lib/ipc";
import { worktreeDefaultsEqual, type WorktreeDefaults } from "@/lib/worktreeDefaults";

export function WorktreeSettings({ active = true, draft, onDraftChange, onPendingChange, onNavigate }: {
  active?: boolean;
  draft: WorktreeDefaults | null;
  onDraftChange: (draft: WorktreeDefaults | null) => void;
  onPendingChange: (pending: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const query = useWorktreeDefaults(active);
  const save = useSaveWorktreeDefaults();
  const backup = useBackupStatus(active);
  const value = draft ?? query.data?.defaults;
  const preview = useWorktreePreview("my-project", "/path/to/my-project", value, active && !!value);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = !!draft && !!query.data && !worktreeDefaultsEqual(draft, query.data.defaults);

  function change(patch: Partial<WorktreeDefaults>) {
    if (!value || !query.data) return;
    const next = { ...value, ...patch };
    onDraftChange(worktreeDefaultsEqual(next, query.data.defaults) ? null : next);
    setSaved(false);
    setError(null);
  }

  async function submit() {
    if (!value || save.isPending || !preview.data || preview.isError) return;
    onPendingChange(true);
    setError(null);
    try {
      await save.mutateAsync(value);
      onDraftChange(null);
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      onPendingChange(false);
    }
  }

  return (
    <section className="settings-content" aria-labelledby="settings-worktrees-title">
      <div className="settings-section-heading">
        <h2 id="settings-worktrees-title">Worktrees</h2>
        <p>Defaults for new projects. Each project can override its directory and access.</p>
      </div>
      <p className="settings-help">Configures directory access. Agents choose where to create worktrees.</p>
      {query.isLoading ? <p>Loading worktree defaults…</p> : query.isError || !value ? (
        <div className="settings-inline-error" role="alert">
          <span>Could not load worktree defaults. {String(query.error ?? "No settings returned.")}</span>
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <Field label="Directory choice">
            <ChipRadios name="worktree-location" label="Directory choice" value={value.location}
              disabled={save.isPending} onChange={(location) => change({ location })}
              options={[
                { value: "shared-directory", label: "Shared directory" },
                { value: "project-subdirectory", label: "Inside project" },
              ]} />
          </Field>
          {value.location === "shared-directory" ? (
            <Field label="Base directory" htmlFor="settings-worktree-base" hint="Each new project uses a subdirectory named after its registered project name.">
              <div className="browse-row">
                <input id="settings-worktree-base" type="text" className="text-mono" value={value.base_dir}
                  disabled={save.isPending} onChange={(event) => change({ base_dir: event.target.value })} />
                <Button size="sm" variant="ghost" disabled={save.isPending} onClick={async () => {
                  try {
                    const path = await invoke<string | null>("pick_directory");
                    if (path) change({ base_dir: path });
                  } catch (err) { setError(String(err)); }
                }}>Browse…</Button>
              </div>
            </Field>
          ) : <p className="settings-help">Uses .worktrees inside each new project's folder.</p>}
          <div className="settings-path-preview" aria-live="polite">
            <span>Example for my-project</span>
            {preview.isError ? <p role="alert">{String(preview.error)}</p> : !preview.data ? <p>Resolving example…</p> : (
              <code>{preview.data.path}</code>
            )}
            <p className="settings-help">Example project folder: /path/to/my-project. Saving creates no directories.</p>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-control-label">Enable agent access for new projects</div>
              <p className="settings-help">The project's normal Sync applies supported grants. Project Permissions reports support and access status.</p>
            </div>
            <Toggle variant="switch" ariaLabel="Enable agent access for new projects" checked={value.access_enabled}
              disabled={save.isPending} onChange={(access_enabled) => change({ access_enabled })} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-control-label">Include worktree defaults in backups</div>
              <p className="settings-help">Includes the directory and access defaults for new projects. Worktree folders and project files are not included.</p>
            </div>
            <Toggle variant="switch" ariaLabel="Include worktree defaults in backups" checked={value.include_in_backup}
              disabled={save.isPending} onChange={(include_in_backup) => change({ include_in_backup })} />
          </div>
          <p className="settings-help">Applies to future backups. Turning this off does not erase earlier backup history.</p>
          {backup.data && (!backup.data.configured || !backup.data.initialized) && (
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => onNavigate("/backup")}>Set up backup</Button>
          )}
          {error && <p className="settings-inline-error" role="alert">{error}</p>}
          {saved && <p role="status">Defaults saved for future projects. Existing projects are unchanged.</p>}
          <div className="settings-actions">
            <Button size="sm" variant="primary" busy={save.isPending}
              disabled={!dirty || !preview.data || preview.isError || preview.isFetching}
              onClick={() => void submit()}>{error ? "Retry save defaults" : "Save defaults"}</Button>
            <Button size="sm" variant="ghost" disabled={!draft || save.isPending} onClick={() => {
              onDraftChange(null); setError(null); setSaved(false);
            }}>Cancel</Button>
          </div>
        </>
      )}
    </section>
  );
}
