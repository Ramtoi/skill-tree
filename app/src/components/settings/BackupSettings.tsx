import { useState } from "react";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { useBackupStatus, useBackupSetEnabled } from "@/hooks/useBackup";
import { relativeTimestamp } from "@/lib/backupContract";

export function BackupSettings({ active = true, onNavigate, onPendingChange }: {
  active?: boolean;
  onNavigate: (path: string) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const status = useBackupStatus(active);
  const mutation = useBackupSetEnabled();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState<boolean | null>(null);
  async function save(enabled: boolean) {
    setAttempted(enabled);
    setError(null);
    onPendingChange(true);
    try {
      await mutation.mutateAsync(enabled);
      await status.refetch();
    } catch (err) {
      setError(String(err));
    } finally {
      onPendingChange(false);
    }
  }
  const data = status.data;
  return (
    <section className="settings-content" aria-labelledby="settings-backup-title">
      <div className="settings-section-heading">
        <h2 id="settings-backup-title">Backup</h2>
        <p>Choose whether Sync also backs up your Skill Tree configuration.</p>
      </div>
      {status.isLoading ? <p>Loading backup settings…</p> : status.isError || !data ? (
        <div className="settings-inline-error" role="alert">
          <span>Could not read backup settings. {String(status.error ?? "No status returned.")}</span>
          <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-control-label">Automatic backup after sync</div>
              <p className="settings-help">Saving this preference does not run a backup.</p>
            </div>
            <Toggle variant="switch" ariaLabel="Automatic backup after sync" checked={data.enabled}
              disabled={!data.configured || !data.initialized || mutation.isPending}
              onChange={(value) => void save(value)} />
          </div>
          {!data.configured ? <p>Backups are not set up.</p> : !data.initialized ? (
            <p>The destination is configured. Finish setting up its backup repository.</p>
          ) : (
            <>
              <dl className="settings-details">
                <dt>Destination</dt><dd>{data.repo ?? data.remote ?? data.dir}</dd>
                <dt>Local directory</dt><dd>{data.dir}</dd>
                <dt>Last snapshot</dt><dd>{data.last_commit ? relativeTimestamp(data.last_commit.ts) : "No snapshot yet"}</dd>
                <dt>Remote status</dt><dd>{data.drift === "in-sync" ? "In sync at last check" : data.drift === "unknown" ? "Not verified" : data.drift}</dd>
              </dl>
              {data.pending_reconcile && <p className="settings-help">Remote pushes are paused after a restore. Review the restored configuration in Manage backup.</p>}
              {data.last_push_error && <p className="settings-inline-error" role="alert">Last push failed: {data.last_push_error}</p>}
              {data.error && <p className="settings-inline-error" role="alert">{data.error}</p>}
              {data.warnings.map((warning) => <p className="settings-help" key={warning}>{warning}</p>)}
            </>
          )}
          {error && <div className="settings-inline-error" role="alert">
            <span>Could not save backup settings. {error}</span>
            <Button size="sm" variant="ghost" disabled={mutation.isPending}
              onClick={() => attempted !== null && void save(attempted)}>Retry</Button>
          </div>}
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => onNavigate("/backup")}>
            {data.configured && data.initialized ? "Manage backup" : "Set up backup"}
          </Button>
        </>
      )}
    </section>
  );
}
