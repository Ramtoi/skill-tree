import { useState } from "react";
import { Button } from "@/components/Button";
import { Toggle } from "@/components/Toggle";
import { useRemoteDelivery, useChangeRemoteDelivery } from "@/hooks/useRemoteDelivery";

const labels: Record<string, string> = {
  applied: "Delivered", unchanged: "Up to date", paused: "Paused · skipped",
  setup_required: "Finish setup", published_waiting_for_receiver: "Published · awaiting receiver",
  approval_required: "Needs approval", blocked_drift: "Remote edits need review",
};

export function RemoteDeliverySettings({ active, disabled, onPendingChange }: {
  active: boolean; disabled: boolean; onPendingChange: (pending: boolean) => void;
}) {
  const query = useRemoteDelivery(active);
  const change = useChangeRemoteDelivery();
  const [failed, setFailed] = useState<{ args: string[]; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  async function run(args: string[]) {
    if (change.isPending || disabled) return;
    setFailed(null);
    setSaved(false);
    onPendingChange(true);
    try {
      await change.mutateAsync(args);
      setSaved(args[0] === "set");
    } catch (error) {
      setFailed({ args, message: String(error) });
    } finally {
      onPendingChange(false);
    }
  }
  if (query.isLoading) return <p>Loading delivery settings…</p>;
  if (query.isError || !query.data) return <div className="settings-inline-error" role="alert">
    <span>Could not read delivery settings. {String(query.error ?? "No settings returned.")}</span>
    <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>Retry delivery settings</Button>
  </div>;
  const busy = disabled || change.isPending;
  const last = query.data.last_run;
  return <section aria-label="Delivery to existing machines" className="settings-remote-delivery">
    <div className="settings-row">
      <div>
        <div className="settings-control-label">Publish headless loadouts on Sync</div>
        <p className="settings-help">Only on explicit Sync. Other connectors keep their own sync settings. Editing skills or saving this switch does not publish.</p>
      </div>
      <Toggle variant="switch" ariaLabel="Publish headless loadouts on Sync"
        checked={query.data.settings.publish_on_sync} disabled={busy}
        onChange={value => void run(["set", "--publish-on-sync", String(value)])} />
    </div>
    {saved && <p role="status">Sync preference saved.</p>}
    <div className="settings-actions">
      <Button variant="primary" size="sm" busy={change.isPending && change.variables?.[0] === "run"} disabled={busy}
        onClick={() => void run(["run"])}>Deliver now to all</Button>
    </div>
    <p className="settings-help">Publishes and requests delivery for all enabled headless machines, even when Publish on Sync is off. Paused machines stay paused. Approvals and conflict checks still apply.</p>
    {failed && <div className="settings-inline-error" role="alert">
      <span>{failed.message}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(failed.args)}>Retry delivery action</Button>
    </div>}
    {last && <div aria-live="polite">
      <h3>Last delivery attempt</h3>
      <p className="settings-help"><time dateTime={last.at}>{new Date(last.at).toLocaleString()}</time></p>
      {last.results.length === 0 ? <p>No headless machines configured. Add one through Manage machines.</p> :
        <dl className="settings-details">{last.results.map(row => <div className="settings-delivery-result" key={row.id}>
          <dt>{row.id}</dt><dd>{labels[row.state] ?? row.state.replace(/_/g, " ")}
            {row.message && <p className="settings-help">{row.message}</p>}</dd>
        </div>)}</dl>}
    </div>}
  </section>;
}
