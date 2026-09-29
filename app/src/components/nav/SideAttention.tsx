import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import type { AttentionAction, AttentionItem, AttentionLine } from "@/lib/navAttention";

export type { AttentionLine };
const VISIBLE = 3;

/** Collapse repeated delivery stages, but retain the exact report for diagnosis. */
function SyncFailureItem({ item, go }: { item: AttentionItem; go: (action: AttentionAction) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const errors = item.detail?.split("\n").filter(Boolean) ?? [];
  const missing = new Set<string>();
  const other: string[] = [];
  for (const error of errors) {
    const match = /^(?:symlink|invocation): source missing: (.+)$/.exec(error)
      ?? /^source missing: (.+) \((?:symlink|invocation)(?: \+ (?:symlink|invocation))*\)$/.exec(error);
    if (match) missing.add(match[1]);
    else other.push(error);
  }
  const sources = [...missing];
  const names = sources.slice(0, 6).map((path) => path.replace(/\/SKILL\.md$/, "").split("/").pop());
  return <li className="attention-failure">
    <div className="attention-failure-head">
      <strong>{item.label}</strong>
      {item.action && <Button variant="soft" size="sm" onClick={() => go(item.action!)} aria-label={`${item.action.label}: ${item.label}`}>{item.action.label}</Button>}
    </div>
    {sources.length > 0 && <div className="attention-failure-summary">
      <span>{sources.length} missing source{sources.length === 1 ? "" : "s"}</span>
      <p>{names.join(", ")}{sources.length > 6 ? `, +${sources.length - 6} more` : ""}</p>
    </div>}
    {other.length > 0 && <p className="attention-other-errors">{sources.length > 0
      ? `${other.length} other error${other.length === 1 ? "" : "s"}`
      : <>{other[0]}{other.length > 1 && <span> · +{other.length - 1} more</span>}</>}</p>}
    {!item.detail && <p>No error details in this report.</p>}
    {item.detail && <div className="attention-diagnostics">
      <Button size="sm" icon={open ? "chevron-down" : "chevron-right"} aria-expanded={open} aria-controls={id}
        aria-label={`Full diagnostics: ${item.label}`} onClick={() => setOpen(!open)}>Full diagnostics</Button>
      {open && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The bounded log needs keyboard focus for scrolling.
        <pre id={id} tabIndex={0} role="region" aria-label={`Diagnostics for ${item.label}`}>{item.detail}</pre>
      )}
    </div>}
  </li>;
}

/** A compact action queue. Opening an explanation never navigates or writes. */
export function SideAttention({ lines, groupLabel }: { lines: AttentionLine[]; groupLabel: string }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<AttentionLine | null>(null);
  const sorted = [...lines].sort((a, b) => a.tone === b.tone ? 0 : a.tone === "error" ? -1 : 1);
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE);
  const explanation = selected?.explanation;
  const legendId = `side-attn-legend-${groupLabel.toLowerCase().replace(/\s+/g, "-")}`;
  function go(action: AttentionAction) {
    setSelected(null);
    // Even on the current route, navigation closes the narrow navigator.
    navigate(action.href, action.navState);
  }

  return <>
    {sorted.length > 0 && <div className="side-plaque side-attn" data-worst={sorted[0].tone} role="group" aria-labelledby={legendId}>
      <span id={legendId} className="side-attn-legend">needs attention</span>
      {visible.map((line) => (
        <button key={line.key} type="button" className="side-attn-line" data-tone={line.tone}
          title={line.text} aria-label={`${line.text}, show details`} aria-haspopup="dialog" onClick={() => setSelected(line)}>
          <Icon name={line.tone === "error" ? "state.error" : "state.update"} size={11} />
          <span className="text">{line.text}</span>
          <Icon name="chevron-right" size={10} />
        </button>
      ))}
      {sorted.length > VISIBLE && <button type="button" className="side-attn-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? "show less" : `+${sorted.length - VISIBLE} more`}
      </button>}
    </div>}
    <Modal open={!!selected} onClose={() => setSelected(null)} title={explanation?.title} width={selected?.key === "projects.failed" ? 680 : 600} className="attention-dialog"
      footer={<>
        <Button onClick={() => setSelected(null)}>Close</Button>
        {explanation?.action && <Button variant="primary" onClick={() => go(explanation.action!)}>{explanation.action.label}</Button>}
      </>}>
      {explanation && <>
        <p>{explanation.happened}</p>
        <p className="attention-impact">{explanation.impact}</p>
        {selected?.key === "projects.failed" && <div className="attention-next-step"><h3>Next step</h3><p>{explanation.nextStep}</p></div>}
        <h3>{selected?.key === "projects.failed" ? `Affected projects · ${explanation.affected.length}` : "Affected items"}</h3>
        <ul className="attention-items">
          {explanation.affected.map((item) => selected?.key === "projects.failed" ? <SyncFailureItem key={item.id} item={item} go={go} /> : <li key={item.id}>
            <div className="attention-item-copy"><strong>{item.label}</strong>{item.detail && <p>{item.detail}</p>}</div>
            {item.action && <Button variant="soft" size="sm" onClick={() => go(item.action!)} aria-label={`${item.action.label}: ${item.label}`}>{item.action.label}</Button>}
          </li>)}
        </ul>
        {selected?.key !== "projects.failed" && <><h3>Next step</h3><p>{explanation.nextStep}</p></>}
      </>}
    </Modal>
  </>;
}
