import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import type { CheckoutDiscoveryCandidate, CheckoutDiscoveryMatch } from "@/lib/headlessMachines";

export function CheckoutDiscoveryPicker({
  candidates,
  busy = false,
  scanning = busy,
  error,
  partial = false,
  issues,
  onDiscover,
  onChoose,
  onConfirm,
  confirmDisabled = false,
}: {
  candidates?: CheckoutDiscoveryCandidate[];
  busy?: boolean;
  scanning?: boolean;
  error?: string | null;
  partial?: boolean;
  issues?: { code: string; message?: string }[];
  onDiscover: (root?: string) => void;
  onChoose: (candidate: CheckoutDiscoveryCandidate, match: CheckoutDiscoveryMatch) => void;
  onConfirm?: (matches: CheckoutDiscoveryMatch[]) => Promise<Record<string, string>>;
  confirmDisabled?: boolean;
}) {
  const [root, setRoot] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const visible = useMemo(() => candidates || [], [candidates]);
  const grouped = useMemo(() => {
    const groups = new Map<string, { candidate: CheckoutDiscoveryCandidate; match: CheckoutDiscoveryMatch }[]>();
    visible.forEach(candidate => (candidate.matches || []).forEach(match => {
      const rows = groups.get(match.source_project) || [];
      rows.push({ candidate, match });
      groups.set(match.source_project, rows);
    }));
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);
  const selected = grouped.flatMap(([, rows]) => rows.filter(({ match }) =>
    chosen[match.source_project] === `${match.source_project}:${match.checkout_path}:${match.destination_remote}:${match.source_remote}`));
  async function confirmSelected() {
    if (!onConfirm || !selected.length || confirming) return;
    setConfirming(true); setRowErrors({});
    try {
      const failures = await onConfirm(selected.map(row => row.match));
      const failedSet = new Set(Object.keys(failures));
      setChosen(current => Object.fromEntries(Object.entries(current).filter(([project]) => failedSet.has(project))));
      setRowErrors(failures);
    } catch (err) {
      setRowErrors(Object.fromEntries(selected.map(({ match }) => [match.source_project, String(err)])));
    } finally { setConfirming(false); }
  }
  return <div className="checkout-picker">
    <div className="checkout-picker-controls">
      <Button variant="ghost" busy={busy} disabled={busy || confirming} onClick={() => onDiscover(root.trim() || undefined)}>
        Find project checkouts
      </Button>
      <label>Search within <input value={root} disabled={busy || confirming} placeholder="Receiver home" onChange={event => setRoot(event.target.value)} /></label>
    </div>
    {scanning && <p role="status">Scanning for Git checkouts…</p>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!busy && candidates && !grouped.length && <p role="status">No project matches were found. You can enter a path below and confirm it manually.</p>}
    {partial && <p role="status">The scan reached its limit. Narrow the search and try again; completed results remain available.</p>}
    {!!issues?.length && <details><summary>Scan details</summary><ul>{issues.map((issue, index) =>
      <li key={index}>{issue.message || issue.code.replace(/_/g, " ")}</li>)}</ul></details>}
    {!!grouped.length && <div className="checkout-picker-groups">
      {grouped.map(([project, rows]) => <fieldset key={project} disabled={busy || confirming}>
        <legend>{project}</legend>
        {rows.map(({ candidate, match }) => {
          const key = `${project}:${match.checkout_path}:${match.destination_remote}:${match.source_remote}`;
          return <label key={key} className="checkout-picker-row">
            <input type="checkbox" checked={chosen[project] === key} onChange={event => {
              setChosen(current => ({ ...current, [project]: event.target.checked ? key : "" }));
              if (event.target.checked) onChoose(candidate, match);
            }} />
            <span><code>{match.checkout_path}</code> · {match.source_remote} → {match.destination_remote}
              {rowErrors[project] && <em> · {rowErrors[project]}</em>}</span>
          </label>;
        })}
      </fieldset>)}
    </div>}
    {onConfirm && <Button variant="primary" busy={confirming} disabled={confirmDisabled || confirming || !selected.length}
      onClick={() => void confirmSelected()}>Confirm selected mappings ({selected.length})</Button>}
  </div>;
}
