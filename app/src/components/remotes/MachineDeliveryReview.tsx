import type { Machine, MachinePreview, NativeLimitation } from "@/lib/headlessMachines";
import { inspectionBlockerMessage, machineDeliveryStatus } from "@/lib/machineDeliveryStatus";

function nativeLabel(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "Native setting";
  const row = entry as Record<string, unknown>;
  const selector = Array.isArray(row.selector) ? row.selector.join(" / ") : "Native setting";
  return `${row.binding || "Global"} · ${selector}`;
}

export function MachineDeliveryReview({ machine, preview }: { machine: Machine; preview?: MachinePreview }) {
  const groups = new Map<string, string[]>();
  for (const row of machine.delivery?.invocation || []) {
    const key = `${row.harness} · ${row.limitations.join(" ")}`;
    groups.set(key, [...(groups.get(key) || []), `${row.skill} (${row.binding})`]);
  }
  const native = [...(machine.delivery?.native_limitations || []), ...(preview?.limitations || [])];
  const unique = [...new Map(native.map(row => [JSON.stringify(row), row])).values()];
  const total = groups.size + unique.length;
  const deliveryStatus = machineDeliveryStatus(machine);
  const inspection = machine.draft?.observations.inspection;
  const inspectionCurrent = inspection && deliveryStatus.inspectionIsCurrent;
  return <>
    {total > 0 && <details className="machine-disclosure">
      <summary>Provider limitations · {total}</summary>
      <p className="settings-help">Supported settings are delivered. These limitations do not block delivery.</p>
      <div aria-label="Provider limitations">{[...groups].map(([message, skills]) => <div key={message} className="machine-review-entry">
        <p>{message}</p><p className="settings-help">{skills.join(", ")}</p>
      </div>)}</div>
      {(machine.delivery?.invocation_total || 0) > (machine.delivery?.invocation?.length || 0) &&
        <p>Showing {machine.delivery?.invocation?.length} of {machine.delivery?.invocation_total} skill limitations.</p>}
      <ul aria-label="Native configuration limitations">{unique.map((row: NativeLimitation, index) =>
        <li key={index}>{row.harness} · {row.area} · {row.name}: {row.message}{row.risk ? ` Risk: ${row.risk}` : ""}</li>)}</ul>
    </details>}
    {inspectionCurrent && <section className="machine-disclosure" aria-label="Current receiver inspection">
      <h3>Current receiver inspection</h3>
      <p className="settings-help">Receiver responded at <time dateTime={inspection.observed_at}>{new Date(inspection.observed_at).toLocaleString()}</time>.</p>
      <p>Candidate: {deliveryStatus.inspectionCandidate ? `${deliveryStatus.inspectionCandidate.revision.slice(0, 12)} · generation ${deliveryStatus.inspectionCandidate.generation}` : "Not observed"}</p>
      {deliveryStatus.inspectionApplied && <p>Applied: {deliveryStatus.inspectionApplied.revision.slice(0, 12)} · generation {deliveryStatus.inspectionApplied.generation}</p>}
      {deliveryStatus.inspectionBlockers.length > 0
        ? <ul role="status">{deliveryStatus.inspectionBlockers.map((blocker, index) => <li key={index}>{inspectionBlockerMessage(blocker)}</li>)}</ul>
        : <p className="settings-help">{inspection.plan.ok === true ? "No blockers found. Preview the latest loadouts before delivering." : "The receiver could not produce a usable plan. Refresh its status or preview again."}</p>}
    </section>}
    {preview && <div className="machine-preview">
      <h3>Saved delivery preview</h3>
      <p className="settings-help">Saved preview may be out of date. Preview again to review the latest changes.</p>
      {preview.blockers.length > 0 && <ul role="status">{preview.blockers.map((block, index) =>
        <li key={index}>{block.code.replace(/_/g, " ")}{block.path ? `: ${block.path}` : ""}</li>)}</ul>}
      <details className="machine-disclosure"><summary>File changes · {preview.changes_total ?? preview.changes?.length ?? 0}</summary>
        <ul>{preview.changes?.map(change => <li key={change.path}><span>{change.action}</span> <code>{change.path}</code></li>)}</ul>
        {(preview.changes_total || 0) > (preview.changes?.length || 0) && <p>Showing the first {preview.changes?.length} of {preview.changes_total} file changes.</p>}
        {!preview.changes?.length && <p>No file changes in this preview.</p>}
      </details>
      {preview.native_review && <details className="machine-disclosure"><summary>Review native configuration and scripts</summary>
        <p className="settings-help">{preview.blockers.some(row => row.code === "approval_required") ? "Review these exact values and scripts before approval." : "These values and scripts are approved for this preview."} Provider trust and credentials remain on the receiver.</p>
        {preview.native_review.entries.map((entry, index) => {
          const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          return <div className="machine-review-entry" key={index}><h3>{nativeLabel(entry)}</h3>
            {typeof row.path === "string" && <code className="machine-wrap settings-help">{row.path}</code>}
            <pre className="machine-native-review">{JSON.stringify(row.value ?? entry, null, 2)}</pre>
          </div>;
        })}
        {preview.native_review.files.map(file => <details key={file.path} className="machine-review-entry">
          <summary>Script or document · <code>{file.path}</code></summary><pre className="machine-native-review">{file.content}</pre>
        </details>)}
        {!!preview.native_review.removals.length && <div className="machine-review-entry"><h3>Removals</h3><pre className="machine-native-review">{JSON.stringify(preview.native_review.removals, null, 2)}</pre></div>}
        {!!preview.native_review.retained_bindings.length && <p>Retain existing files: {preview.native_review.retained_bindings.join(", ")}</p>}
        <details><summary>Complete approval data</summary><pre className="machine-native-review">{JSON.stringify(preview.native_review, null, 2)}</pre></details>
      </details>}
    </div>}
  </>;
}
