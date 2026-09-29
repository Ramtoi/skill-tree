import { RemoteDeliverySettings } from "./RemoteDeliverySettings";
import { useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import {
  parseRemotePollInterval,
  REMOTE_POLL_INTERVAL_DEFAULT,
  REMOTE_POLL_INTERVAL_MAX,
  REMOTE_POLL_INTERVAL_MIN,
} from "@/lib/remoteDefaults";
import { useRemoteDefaults, useSaveRemoteDefaults } from "@/hooks/useRemoteDefaults";

export function RemotesSettings({ active = true, draft, onDraftChange, onPendingChange, onNavigate }: {
  active?: boolean;
  draft: string | null;
  onDraftChange: (draft: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const query = useRemoteDefaults(active);
  const save = useSaveRemoteDefaults();
  const [deliveryPending, setDeliveryPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? String(query.data?.defaults?.poll_interval_seconds ?? REMOTE_POLL_INTERVAL_DEFAULT);
  const parsed = parseRemotePollInterval(value);
  const current = query.data?.defaults?.poll_interval_seconds ?? REMOTE_POLL_INTERVAL_DEFAULT;
  const dirty = draft !== null && (parsed === undefined || parsed !== current);

  function change(next: string) {
    onDraftChange(next === String(current) ? null : next);
    setSaved(false);
    setError(null);
  }

  async function submit() {
    if (parsed === undefined || save.isPending) return;
    onPendingChange(true);
    setError(null);
    try {
      await save.mutateAsync({ poll_interval_seconds: parsed });
      onDraftChange(null);
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      onPendingChange(false);
    }
  }

  return (
    <section className="settings-content" aria-labelledby="settings-remotes-title">
      <div className="settings-section-heading">
        <h2 id="settings-remotes-title">Remotes</h2>
        <p>Choose what Sync publishes and deliver to your machines.</p>
      </div>
      <RemoteDeliverySettings active={active} disabled={save.isPending} onPendingChange={pending => {
        setDeliveryPending(pending); onPendingChange(pending);
      }} />
      <h3>New machine defaults</h3>
      {query.isLoading ? <p>Loading remote defaults…</p> : query.isError || !query.data ? (
        <div className="settings-inline-error" role="alert">
          <span>Could not read remote defaults. {String(query.error ?? "No settings returned.")}</span>
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <Field
            label="Default polling interval for new machines"
            htmlFor="settings-remote-poll-interval"
            hint="Applies to future machines only. Existing machines and saved drafts are unchanged."
          >
            <input
              id="settings-remote-poll-interval"
              type="text"
              inputMode="numeric"
              min={REMOTE_POLL_INTERVAL_MIN}
              max={REMOTE_POLL_INTERVAL_MAX}
              step={1}
              value={value}
              disabled={save.isPending || deliveryPending}
              onChange={(event) => change(event.target.value)}
            />
          </Field>
          {draft !== null && parsed === undefined && (
            <p className="settings-inline-error" role="alert">
              Enter an integer from {REMOTE_POLL_INTERVAL_MIN} to {REMOTE_POLL_INTERVAL_MAX} seconds.
            </p>
          )}
          <p className="settings-help">The receiver checks for published loadouts at this interval. Saving does not contact a machine or change its timer.</p>
          {error && <div className="settings-inline-error" role="alert">
            <span>Could not save remote defaults. {error}</span>
            <Button size="sm" variant="ghost" disabled={save.isPending || deliveryPending} onClick={() => void submit()}>Retry</Button>
          </div>}
          {saved && <p role="status">Remote defaults saved for future machines. Existing machines are unchanged.</p>}
          <div className="settings-actions">
            <Button size="sm" busy={save.isPending} disabled={!dirty || parsed === undefined || deliveryPending} onClick={() => void submit()}>
              {error ? "Retry save defaults" : "Save defaults"}
            </Button>
            <Button size="sm" variant="ghost" disabled={draft === null || save.isPending || deliveryPending} onClick={() => {
              onDraftChange(null);
              setError(null);
              setSaved(false);
            }}>Cancel</Button>
          </div>
        </>
      )}
      <Button size="sm" variant="ghost" disabled={save.isPending || deliveryPending} onClick={() => onNavigate("/remotes")}>
        Manage machines
      </Button>
    </section>
  );
}
