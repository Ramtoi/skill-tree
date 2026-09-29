import { useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Sheet } from "@/components/Modal";
import { invoke } from "@/lib/ipc";
import { machineCommand } from "@/lib/headlessMachines";
import { useInvalidateMachines } from "@/hooks/useHeadlessMachines";

export function HeadlessMachineWizard({ onClose, onCreated, onBack }: {
  onClose: () => void; onCreated: (id: string) => void; onBack: () => void;
}) {
  const [id, setId] = useState("");
  const [host, setHost] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateMachines();
  async function scan() {
    setBusy(true); setError(null); setConfirmed(false); setFingerprint(null);
    try {
      const result = await invoke<{ fingerprint: string | null; detail: string }>("remote_fetch_host_key", { host });
      if (!result.fingerprint) throw new Error(result.detail || "No host key returned.");
      setFingerprint(result.fingerprint);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(null);
    try {
      await machineCommand("draft", [id, "--settings-json", JSON.stringify({ ssh_host: host,
        ...(confirmed && fingerprint ? { host_key_sha256: fingerprint } : {}) })]);
      await invalidate(id);
      onCreated(id);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  return <Sheet open onClose={onClose} dismissable={!busy} title="Add a headless machine"
    aria-label="Add a headless machine" footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
      <Button busy={busy} disabled={!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !host.trim()}
        onClick={() => void save()}>Save machine draft</Button>
    </>}>
    <div className="machine-form">
      <p>Keep selected project loadouts current in confirmed checkouts. Your Mac manages the loadouts; the receiver preserves local edits for review.</p>
      <Field label="Machine id" htmlFor="machine-id"><input id="machine-id" value={id} disabled={busy}
        onChange={event => setId(event.target.value)} placeholder="build-box" /></Field>
      <Field label="SSH host or alias" htmlFor="machine-host"><input id="machine-host" value={host} disabled={busy}
        onChange={event => { setHost(event.target.value); setFingerprint(null); setConfirmed(false); }}
        placeholder="my-linux-box" /></Field>
      <Button variant="soft" busy={busy} disabled={!host.trim()} onClick={() => void scan()}>Fetch host key</Button>
      {fingerprint && <><code className="machine-wrap">{fingerprint}</code>
        <label><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={event => setConfirmed(event.target.checked)} /> I checked this fingerprint against the machine.</label></>}
      <p className="settings-help">Connection settings stay in your private Skill Tree data. Save now and resume setup from Remotes. Installation and delivery each have a separate action.</p>
      {error && <p role="alert">{error}</p>}
    </div>
  </Sheet>;
}
