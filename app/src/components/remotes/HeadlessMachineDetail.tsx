import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useMachine, useInvalidateMachines } from "@/hooks/useHeadlessMachines";
import { useRegistry } from "@/hooks/useRegistry";
import { machineCommand, MachineError, type CheckoutDiscoveryMatch, type Machine, type Revision } from "@/lib/headlessMachines";
import { machineDeliveryStatus } from "@/lib/machineDeliveryStatus";
import { invoke } from "@/lib/ipc";
import { CheckoutDiscoveryPicker } from "@/components/remotes/CheckoutDiscoveryPicker";
import { MachineDeliveryReview } from "./MachineDeliveryReview";
import "./headlessMachines.css";

const shortRevision = (value?: Revision | null) => value ? `${value.revision.slice(0, 12)} · generation ${value.generation}` : "Not observed";

export function HeadlessMachineDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const query = useMachine(id);
  if (query.data?.draft) return <MachineSetup key={id} machine={query.data} onBack={onBack} />;
  return <>
    <ScreenHeader title={id} back={{ label: "Remotes", onClick: onBack }} />
    {query.isLoading ? <p className="screen-pad">Loading machine setup…</p> :
      <div className="screen-pad" role="alert"><p>{String(query.error || query.data?.error || "Machine setup is unavailable.")}</p>
        <Button onClick={() => void query.refetch()}>Retry</Button></div>}
  </>;
}

function MachineSetup({ machine, onBack }: { machine: Machine; onBack: () => void }) {
  const draft = machine.draft!;
  const saved = draft.input;
  const steps = draft.observations;
  const [form, setForm] = useState({
    host: saved.ssh_host || "", pin: saved.host_key_sha256 || "", pinConfirmed: !!saved.host_key_sha256,
    feed: saved.feed_url || "", privateFeed: saved.private_feed_confirmed || false,
    interval: String(steps.interval_update?.requested_interval ?? saved.poll_interval_seconds), checkout: "", binding: "", reviewBinding: false,
    project: "", manual: false, gitRemote: "origin", sourceRemote: "origin", providers: [] as string[],
    globalNative: [] as string[], globalAgents: "",
  });
  const { host, pin, pinConfirmed, feed, privateFeed, interval, checkout, binding, reviewBinding,
    project, manual, gitRemote, sourceRemote, providers, globalNative, globalAgents } = form;
  const field = <K extends keyof typeof form>(key: K) => (value: typeof form[K] | ((current: typeof form[K]) => typeof form[K])) =>
    setForm(current => ({ ...current, [key]: typeof value === "function" ? value(current[key]) : value }));
  const setHost = field("host");
  const setPin = field("pin");
  const setPinConfirmed = field("pinConfirmed");
  const setFeed = field("feed");
  const setPrivateFeed = field("privateFeed");
  const setInterval = field("interval");
  const setCheckout = field("checkout");
  const setBinding = field("binding");
  const setReviewBinding = field("reviewBinding");
  const setProject = field("project");
  const setManual = field("manual");
  const setGitRemote = field("gitRemote");
  const setSourceRemote = field("sourceRemote");
  const setProviders = field("providers");
  const setGlobalNative = field("globalNative");
  const setGlobalAgents = field("globalAgents");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" }); }, [error]);
  const [result, setResult] = useState<Machine["result"]>();
  const { data: registry } = useRegistry();
  const invalidate = useInvalidateMachines();
  const preview = steps.preview;
  const bindings = Object.entries(machine.bindings || {});
  const installed = !!steps.install;
  const configured = !!steps.configure;
  const channelConflict = configured ? undefined : steps.channel_conflict;
  const conflictLastApplied = channelConflict?.applied?.generation != null
    ? `generation ${channelConflict.applied.generation}${channelConflict.applied.applied_at ? ` · ${new Date(channelConflict.applied.applied_at).toLocaleString()}` : ""}`
    : "Not observed";
  const needsReconnect = !!channelConflict || errorCode === "feed_reconnect_required" || machine.delivery?.error?.code === "feed_reconnect_required";
  const reconnectLastApplied = steps.status?.applied || machine.delivery?.applied;
  const paused = !machine.sync_enabled && ((draft.phase || machine.phase) === "paused" || !!steps.start);
  const visibleError = error || machine.delivery?.error?.message;
  const deliveryStatus = machineDeliveryStatus(machine, { actionError: error, delivering: busy === "start" });
  const inspectionBlocked = deliveryStatus.inspectionIsCurrent && (steps.inspection?.plan.ok !== true || deliveryStatus.inspectionBlockers.length > 0);
  const inspectionApprovalDigest = steps.inspection?.plan.approval_digest;
  const approvalOutdated = deliveryStatus.inspectionIsCurrent && inspectionApprovalDigest !== preview?.approval_digest;
  const canEdit = !machine.sync_enabled;
  const nextAction = !steps.connect ? "connect" : !installed ? "install" : !configured ? "configure" : !bindings.length ? "bind" :
    !preview ? "preview" : preview.blockers.some(item => item.code === "approval_required") ? "approve" : "start";
  const actionStyle = (action: string) => nextAction === action && !(action === "preview" && paused) ? "primary" as const : "soft" as const;
  const pollDirty = !!steps.interval_update || interval !== String(saved.poll_interval_seconds);
  const pollValid = /^\d+$/.test(interval) && Number(interval) >= 30 && Number(interval) <= 3600;
  async function run(action: string, args: string[] = [], settings?: object) {
    if (busy) return;
    setBusy(action); setError(null); setErrorCode(undefined);
    try {
      if (settings) await machineCommand("draft", [machine.id, "--settings-json", JSON.stringify(settings)]);
      const updated = await machineCommand(action, [machine.id, ...args]);
      if (action === "discover") setResult(updated.result);
      if ((action === "interval" || (action === "start" && steps.interval_update)) && updated.draft) setInterval(String(updated.draft.input.poll_interval_seconds));
      if (action !== "discover") await invalidate(machine.id);
    } catch (err) {
      setError(String(err));
      setErrorCode(err instanceof MachineError ? err.code : undefined);
      await invalidate(machine.id);
    } finally { setBusy(null); }
  }
  async function confirmSelectedMappings(matches: CheckoutDiscoveryMatch[]): Promise<Record<string, string>> {
    if (!configured || machine.sync_enabled || !providers.length) return Object.fromEntries(matches.map(match => [match.source_project, "Receiver setup is incomplete."]));
    setBusy("bind"); setError(null);
    const failed: Record<string, string> = {};
    try {
      for (const match of matches) {
        try {
          const args = ["--binding", match.source_project, "--project", match.source_project, "--checkout", match.checkout_path,
            ...providers.flatMap(provider => ["--harness", provider]), "--remote", match.destination_remote,
            "--source-remote", match.source_remote,
            ...globalNative.flatMap(area => ["--global-native", area]),
            ...(globalNative.includes("agents") ? globalAgents.split(",").map(name => name.trim()).filter(Boolean).flatMap(name => ["--global-agent", name]) : [])];
          await machineCommand("bind", [machine.id, ...args]);
        } catch (err) { failed[match.source_project] = String(err); }
      }
      await invalidate(machine.id);
      if (Object.keys(failed).length) setError(`Some mappings need retry: ${Object.keys(failed).join(", ")}.`);
    } finally { setBusy(null); }
    return failed;
  }
  async function fetchPin() {
    setBusy("host-key"); setError(null); setPinConfirmed(false); setPin("");
    try {
      const found = await invoke<{ fingerprint: string | null; detail: string }>("remote_fetch_host_key", { host });
      if (!found.fingerprint) throw new Error(found.detail || "No host key returned.");
      setPin(found.fingerprint);
    } catch (err) { setError(String(err)); } finally { setBusy(null); }
  }
  const next = steps.interval_update ? steps.interval_update.message : !steps.connect ? "Confirm the host key and test the connection." : !installed ?
    "Install the receiver in the remote user account." : !configured ? "Configure a private Git feed." : !bindings.length ?
    "Choose a source project and confirm its remote checkout." : !preview ? paused ? "Delivery is paused. Resume delivery prepares a preview for review first." : "Preview the next delivery." :
    preview.blockers.length ? "Resolve the preview blockers before delivery." : deliveryStatus.outcomeMessage;
  const needsApproval = !!preview?.blockers.some(item => item.code === "approval_required");
  const startLabel = machine.sync_enabled ? "Deliver now" : paused ? "Resume delivery" : "Apply and start periodic delivery";
  const intervalLabel = saved.poll_interval_seconds ? ` · every ${saved.poll_interval_seconds} seconds` : "";
  return <>
    <ScreenHeader title={machine.id} back={{ label: "Remotes", onClick: onBack }}
      subline={steps.interval_update ? "Timer update incomplete" : `${deliveryStatus.settingLabel}${deliveryStatus.setting === "off" ? "" : intervalLabel}`}
      state={<StatusBadge channel={deliveryStatus.outcomeChannel}>{deliveryStatus.outcomeLabel}</StatusBadge>}
      primary={preview || (configured && bindings.length > 0 && paused) ? <Button variant="primary" busy={busy === "start" || busy === "preview"}
        disabled={!!busy || inspectionBlocked || (!!preview && (!preview.ok || !preview.plan_digest))}
        onClick={() => void (preview ? run("start", ["--plan-digest", preview.plan_digest!]) : run("preview"))}>{startLabel}</Button> : undefined}
      secondary={machine.sync_enabled ? <Button variant="soft" busy={busy === "pause"} disabled={!!busy}
        onClick={() => void run("pause")}>Pause delivery</Button> : undefined} />
    <div className="screen-pad machine-detail">
    <div className="machine-status" role="status"><StatusBadge channel={deliveryStatus.outcomeChannel}>{deliveryStatus.outcomeLabel}</StatusBadge><p>{deliveryStatus.settingLabel}{deliveryStatus.setting === "enabled" ? intervalLabel : ""}</p></div>
    {(!configured || !bindings.length || !preview) && <p>{next}</p>}
    {visibleError && <div ref={errorRef} className="machine-error" role="alert"><p>{busy === "start" ? "Previous delivery attempt" : error ? "Last action" : "Last delivery attempt"}</p><p>{visibleError}</p><p>Completed steps remain saved. Retry the action after resolving the error.</p></div>}
    <section className="machine-section" aria-labelledby="machine-delivery-title">
      <h2 id="machine-delivery-title">{deliveryStatus.outcomeTitle}</h2>
      <p>{deliveryStatus.outcomeMessage}</p>
      <p className="settings-help">{steps.connect ? "SSH connection passed its setup check." : "SSH connection has not been tested."} {configured ? "Receiver setup is saved." : "Receiver setup is not complete."}</p>
      <p className="settings-help">Last confirmed applied: {deliveryStatus.lastConfirmedApplied ? shortRevision(deliveryStatus.lastConfirmedApplied) : "No confirmed delivery yet"}.</p>
      <details><summary>Delivery details</summary>
      <dl className="machine-receipts"><dt>Published</dt><dd>{shortRevision(deliveryStatus.published)}</dd>
        <dt>Last confirmed applied</dt><dd>{shortRevision(deliveryStatus.lastConfirmedApplied)}</dd>
        <dt>Last delivery result</dt><dd>{machine.delivery?.state.replace(/_/g, " ") || "Not attempted"}</dd>
        <dt>{deliveryStatus.confirmationObserved ? "Confirmation observed" : "Last delivery observation"}</dt><dd><time title={deliveryStatus.resultObservedAt || undefined}>{deliveryStatus.resultObservedAt ? new Date(deliveryStatus.resultObservedAt).toLocaleString() : "Not observed"}</time></dd>
        <dt>Connection check</dt><dd>{steps.connect ? "Saved during setup" : "Not observed"}</dd>
        <dt>Receiver setup</dt><dd>{configured ? "Saved" : "Not complete"}</dd></dl></details>
      <div className="settings-actions"><Button variant={actionStyle("preview")} busy={busy === "preview"} disabled={!!busy || !configured || !bindings.length}
        onClick={() => void run("preview")}>Preview latest loadouts</Button>
        {configured && <Button variant="ghost" busy={busy === "status"} disabled={!!busy} onClick={() => void run("status")}>Refresh receiver status</Button>}</div>
      <p className="settings-help">Preview publishes to the feed. {machine.sync_enabled ? "The receiver can apply published changes. Pause first to review before delivery." : "Review the preview before starting delivery."}</p>
      <MachineDeliveryReview machine={machine} preview={preview} />
      {preview?.approval_digest && needsApproval && <Button variant="primary" disabled={!!busy || approvalOutdated} busy={busy === "approve"}
        onClick={() => void run("approve", ["--digest", preview.approval_digest!])}>Approve these native and shared changes</Button>}

    </section>
    <section className="machine-section" aria-labelledby="machine-connection-title">
      <details open={!steps.connect}><summary id="machine-connection-title">Connection · {host || "Not connected"}</summary>
      <div className="machine-form">
        <Field label="SSH host or alias" htmlFor={installed ? undefined : "detail-machine-host"}>{installed ? <span className="field-static">{host}</span> : <input id="detail-machine-host" value={host}
          disabled={!!busy} onChange={e => { setHost(e.target.value); setPin(""); setPinConfirmed(false); }} />}</Field>
        {!installed && <Button variant="soft" disabled={!!busy || !host.trim()} onClick={() => void fetchPin()}>Fetch host key</Button>}
        {pin && <><code className="machine-wrap">{pin}</code>{!installed && <label><input type="checkbox" checked={pinConfirmed}
          disabled={!!busy} onChange={e => setPinConfirmed(e.target.checked)} /> I checked this fingerprint against the machine.</label>}</>}
        <div className="settings-actions"><Button variant={actionStyle("connect")} busy={busy === "connect"} disabled={!!busy || !host || !pinConfirmed || !pin}
          onClick={() => void run("connect", [], { ssh_host: host, host_key_sha256: pin })}>Test connection</Button>
</div>
        <p className="settings-help">Uses your SSH configuration and agent. The machine needs Git, Python 3.9 or newer, and a systemd user session.</p>
      </div>
      </details>
    </section>
    <section className="machine-section" aria-labelledby="machine-receiver-title">
      <h2 id="machine-receiver-title">Receiver and feed</h2>
      {machine.sync_enabled && <p className="settings-help">The interval can change during delivery. Pause delivery before repairing the receiver or changing checkout mappings.</p>}
      <details open={!configured}><summary>{configured ? "Receiver installation and feed" : "Set up receiver and feed"}</summary>
      <p>Install the headless CLI under <code>~/.local/share/skill-tree/receiver</code>. Starting delivery later enables a user timer.</p>
      <Button variant={actionStyle("install")} busy={busy === "install"} disabled={!!busy || !steps.connect || !canEdit}
        onClick={() => void run("install")}>{installed ? "Repair receiver installation" : "Install receiver"}</Button>
      <div className="machine-form">
        <Field label="Private Git feed URL" htmlFor={configured ? undefined : "machine-feed"} hint={`A private backup repository can be reused. Loadouts use the ${machine.id} branch; keep backups on another branch. Repository access also permits reading backup history.`}>
          {configured ? <span className="field-static machine-wrap">{feed}</span> : <input id="machine-feed" value={feed} disabled={!!busy} placeholder="git@example.org:team/loadouts.git"
            onChange={e => setFeed(e.target.value)} />}</Field>
        <p className="settings-help">The Mac needs write access and the receiver needs read access. GitHub HTTPS can use an existing gh login on each machine. SSH needs Git host trust and an authorized key on each machine. Configure receiver checks read access on both.</p>
        {!configured && <label><input type="checkbox" checked={privateFeed} disabled={!!busy || !canEdit}
          onChange={e => setPrivateFeed(e.target.checked)} /> I configured private repository access for this Mac and receiver.</label>}
      </div></details>
      {needsReconnect && !machine.sync_enabled && <div className="machine-conflict" role="group" aria-labelledby="machine-conflict-title">
        <h3 id="machine-conflict-title">{channelConflict ? "This receiver already delivers loadouts for another Skill Tree installation." : "The feed branch was published by another Skill Tree installation."}</h3>
        <dl className="machine-receipts">
          {channelConflict ? <>
            <dt>Receiver publisher key</dt><dd>{channelConflict.publisher_key_id || "Unknown"}</dd>
            <dt>This Mac's key</dt><dd>{channelConflict.controller_key_id || "Unknown"}</dd>
            <dt>Last applied</dt><dd>{conflictLastApplied}</dd>
          </> : reconnectLastApplied ? <>
            <dt>Last applied</dt><dd>{shortRevision(reconnectLastApplied)}</dd>
          </> : null}
        </dl>
        <p className="settings-help">Reconnect keeps the files on the receiver and pauses delivery. Review each checkout mapping, preview the next delivery, and approve its native changes again before resuming.</p>
        <div className="settings-actions">
          <Button variant="primary" busy={busy === "configure"} disabled={!!busy || !installed || !feed || !privateFeed || !pollValid || !canEdit}
            onClick={() => void run("configure", ["--replace-channel"], { feed_url: feed, private_feed_confirmed: privateFeed,
              poll_interval_seconds: Number(interval) })}>Reconnect receiver</Button>
        </div>
      </div>}
      <div className="machine-polling">
        <Field label="Polling interval in seconds" htmlFor="machine-interval" hint="30 to 3600 seconds. Changes apply only when saved.">
          <input id="machine-interval" inputMode="numeric" value={interval} disabled={!!busy} aria-invalid={!pollValid}
            onChange={e => setInterval(e.target.value)} /></Field>
        {configured ? <Button variant="soft" disabled={!!busy || !pollValid || !pollDirty} busy={busy === "interval"}
          onClick={() => void run("interval", ["--poll-interval-seconds", interval])}>Save interval</Button> :
          <Button variant={channelConflict ? "soft" : actionStyle("configure")} disabled={!!busy || !installed || !feed || !privateFeed || !pollValid || !canEdit} busy={busy === "configure"}
            onClick={() => void run("configure", [], { feed_url: feed, private_feed_confirmed: privateFeed,
              poll_interval_seconds: Number(interval) })}>Configure receiver</Button>}
        {steps.interval_update && <p role="status">{steps.interval_update.message}</p>}
        {!pollValid && <p role="status">Enter a whole number from 30 to 3600.</p>}
        {pollDirty && pollValid && <p className="settings-help">Unsaved interval</p>}
      </div>
    </section>
    <section className="machine-section" aria-labelledby="machine-bindings-title">
      <h2 id="machine-bindings-title">Confirmed project checkouts</h2>
      {bindings.length ? <ul className="machine-bindings">{bindings.map(([key, value]) => <li key={key}>
        <strong>{key}</strong><span><Link to={`/project/${encodeURIComponent(value.source_project)}`}>{value.source_project}</Link> · {value.harnesses.join(", ")} · {value.mode}</span>
        <Button size="sm" variant="ghost" disabled={!!busy || machine.sync_enabled} onClick={() => { setReviewBinding(true); setBinding(key); setProject(value.source_project); setProviders(value.harnesses); setManual(value.mode === "manual"); setGlobalNative(value.global_native || []); setGlobalAgents((value.global_agents || []).join(", ")); }}>Review checkout mapping</Button>
        <Button size="sm" variant="ghost" disabled={!!busy || machine.sync_enabled}
          onClick={() => void run("unbind", ["--binding", key])}>Remove binding, retain files</Button>
      </li>)}</ul> : <p>No checkout has been confirmed.</p>}
      <details open={!bindings.length || reviewBinding || !!result?.candidates}><summary>Add a project checkout</summary><div className="machine-form">
        <Field label="Source project" htmlFor="machine-project"><select id="machine-project" value={project} disabled={!!busy}
          onChange={e => { setProject(e.target.value); setBinding(e.target.value); setGitRemote("origin"); setSourceRemote("origin"); }}><option value="">Choose a project</option>
          {Object.keys(registry?.projects || {}).map(name => <option key={name} value={name}>{name}</option>)}</select></Field>
        <Field label="Binding name" htmlFor="machine-binding"><input id="machine-binding" value={binding} disabled={!!busy || reviewBinding}
          onChange={e => setBinding(e.target.value)} /></Field>
        <p className="settings-help">Select the checkouts to add. The provider and global settings choices below apply to every selected mapping.</p>
        <CheckoutDiscoveryPicker
          candidates={result?.candidates}
          busy={!!busy}
          scanning={busy === "discover"}
          partial={!!result?.partial}
          issues={result?.issues}
          onDiscover={searchRoot => void run("discover", searchRoot ? ["--root", searchRoot] : [])}
          onChoose={(_candidate, match) => {
            setProject(match.source_project); setBinding(match.source_project); setCheckout(match.checkout_path);
            setGitRemote(match.destination_remote); setSourceRemote(match.source_remote); setManual(false);
          }}
          onConfirm={confirmSelectedMappings}
          confirmDisabled={!!busy || !configured || machine.sync_enabled || !providers.length || (globalNative.includes("agents") && !globalAgents.trim())} />
        <Field label="Remote checkout path" htmlFor="machine-checkout"><input id="machine-checkout" value={checkout} disabled={!!busy}
          onChange={e => setCheckout(e.target.value)} placeholder="/home/me/projects/app" /></Field>
        <label><input type="checkbox" checked={manual} disabled={!!busy} onChange={e => setManual(e.target.checked)} />
          Confirm this path manually without repository matching.</label>
        {!manual && <Field label="Remote checkout Git remote" htmlFor="machine-git-remote"><input id="machine-git-remote" value={gitRemote} disabled={!!busy} onChange={e => setGitRemote(e.target.value)} /></Field>}
        {!manual && <Field label="Source project Git remote" htmlFor="machine-source-remote"><input id="machine-source-remote" value={sourceRemote} disabled={!!busy} onChange={e => setSourceRemote(e.target.value)} /></Field>}
        <p className="settings-help">Review each selected checkout and provider list before confirmation. A receiver scan never changes mappings by itself.</p>
        <fieldset disabled={!!busy}><legend>Providers to configure on the receiver</legend>{["codex", "claude-code", "pi", "opencode"].map(provider =>
          <label key={provider}><input type="checkbox" checked={providers.includes(provider)} onChange={e =>
            setProviders(current => e.target.checked ? [...current, provider] : current.filter(item => item !== provider))} />{provider}</label>)}</fieldset>
        <fieldset disabled={!!busy || !canEdit}><legend>Also deliver selected Mac global settings</legend>
          {["mcp", "permissions", "hooks", "agents"].map(area => <label key={area}><input type="checkbox"
            checked={globalNative.includes(area)} onChange={e => setGlobalNative(current => e.target.checked ? [...current, area] : current.filter(item => item !== area))} />{area === "mcp" ? "MCP servers" : area}</label>)}
        </fieldset>
        <p className="settings-help">Project settings are included. Global categories apply to the selected providers and require receiver approval. Existing server settings remain locally owned.</p>
        {globalNative.includes("agents") && <Field label="Global agent names" htmlFor="machine-global-agents" hint="Comma-separated names. Only these agents will be delivered.">
          <input id="machine-global-agents" value={globalAgents} disabled={!!busy} onChange={e => setGlobalAgents(e.target.value)} /></Field>}
        {!configured && <p className="settings-help">Configure the receiver before confirming a checkout.</p>}
        <Button variant={actionStyle("bind")} disabled={!!busy || (globalNative.includes("agents") && !globalAgents.trim()) || !configured || !project || !binding || !checkout || !providers.length || (!manual && !gitRemote.trim()) || machine.sync_enabled}
          busy={busy === "bind" || busy === "reconfirm"} onClick={() => void run(reviewBinding ? "reconfirm" : "bind", ["--binding", binding, "--project", project, "--checkout", checkout,
            ...providers.flatMap(provider => ["--harness", provider]), ...globalNative.flatMap(area => ["--global-native", area]),
            ...(globalNative.includes("agents") ? globalAgents.split(",").map(name => name.trim()).filter(Boolean).flatMap(name => ["--global-agent", name]) : []), ...(manual ? ["--manual"] : ["--remote", gitRemote.trim(), "--source-remote", sourceRemote.trim()])])}>{reviewBinding ? "Reconfirm checkout mapping" : "Confirm checkout mapping"}</Button>
        {reviewBinding && <Button variant="ghost" disabled={!!busy} onClick={() => { setReviewBinding(false); setBinding(""); setCheckout(""); }}>Cancel mapping review</Button>}
        {machine.sync_enabled && <p>Pause delivery before changing checkout mappings.</p>}
      </div></details>
    </section>

  </div></>;
}
