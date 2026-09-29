import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { Tag } from "@/components/Tag";
import type { InspectionRun, InspectionToolCall } from "@/features/usage/usageInspectionTypes";
import { groupToolCalls } from "./usageInspectionModel";
import { formatCount } from "./usageFormat";

export interface UsageSessionToolCallsProps {
  calls?: InspectionToolCall[];
  runs?: InspectionRun[];
  selectedRunId?: string | null;
  onBody?: (bodyId: string, label?: string) => void;
  /** Pages still arriving behind the ones shown; the caption names the count. */
  streaming?: { loaded: number; total: number };
}

function EvidencePart({ part, side, onBody }: { part: InspectionToolCall["input_parts"][number]; side: "input" | "result"; onBody?: (id: string, label?: string) => void }) {
  if (part.status === "pruned") {
    const sideLabel = side === "input" ? "Input" : "Result";
    const date = part.pruned_at ? new Date(part.pruned_at).toLocaleDateString() : "date unavailable";
    return <button type="button" className="usage-tool-part" disabled title={`${sideLabel} pruned · ${date}`}>{sideLabel} pruned · {date}</button>;
  }
  const canOpen = !!part.body_id && part.status !== "unavailable" && part.status !== "unsupported";
  const label = part.retained_version ? `Earlier captured version · ${bodyPartLabel(part.kind)}` : bodyPartLabel(part.kind);
  return <button type="button" className="usage-tool-part" disabled={!canOpen} onClick={() => part.body_id && onBody?.(part.body_id, label)} title={part.body_id ?? undefined}>{label}: {part.status} · {formatCount(part.bytes)} bytes</button>;
}

function CapturedToolCalls({ calls, runs = [], selectedRunId = null, onBody, streaming }: { calls: InspectionToolCall[]; runs?: InspectionRun[]; selectedRunId?: string | null; onBody?: (bodyId: string, label?: string) => void; streaming?: { loaded: number; total: number } }) {
  const [agent, setAgent] = useState(selectedRunId ?? "all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const agents = useMemo(() => {
    const known = runs.map((run) => run.id);
    const observed = calls.map((call) => call.run_id);
    return ["all", ...Array.from(new Set([...known, ...observed, ...(selectedRunId ? [selectedRunId] : [])]))];
  }, [calls, runs, selectedRunId]);
  const agentLabels = useMemo(() => new Map(runs.map((run) => [run.id, run.label])), [runs]);
  useEffect(() => { setAgent(selectedRunId ?? "all"); }, [selectedRunId]);
  const filtered = agent === "all" ? calls : calls.filter((call) => call.run_id === agent);
  const groups = useMemo(() => groupToolCalls(filtered), [filtered]);
  if (calls.length === 0 && !streaming) return <EmptyState icon="command" title="No tool calls were captured for this session." />;
  return <div className="usage-inspection-tools">
    <label className="usage-inspection-filter">Agent<select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Filter tool calls by agent">{agents.map((value) => <option key={value} value={value}>{value === "all" ? "All agents" : agentLabels.get(value) ?? "Agent"}</option>)}</select></label>
    <p className="usage-note" role="status">{formatCount(filtered.length)} of {formatCount(calls.length)} captured calls · grouped only when adjacent and equivalent{streaming && <span className="usage-tool-streaming"> · loading the rest, {formatCount(streaming.loaded)} of {formatCount(streaming.total)} read</span>}</p>
    <div className="usage-tool-group-list" role="list" aria-label="Captured tool calls">
      {groups.map((group) => { const isOpen = expanded.has(group.key); return <section key={group.key} className="usage-tool-group" role="listitem">
        <button type="button" className="usage-tool-group-toggle" aria-expanded={isOpen} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><span className="usage-tool-group-tool" title={group.tool.name}><Tag size="sm">{group.tool.name}</Tag></span><code>{group.label ?? "operation unavailable"}</code><span className="usage-tool-group-count">{group.calls.length} call{group.calls.length === 1 ? "" : "s"}</span></button>
        {isOpen && <div className="usage-tool-group-items">{group.calls.map((call) => <article key={call.id} className="usage-tool-item"><header><code>#{call.ordinal}</code><span>{agentLabels.get(call.run_id) ?? "Agent"}</span><span>{call.execution}</span><time>{call.at ? new Date(call.at).toLocaleTimeString() : "time unavailable"}</time></header><div className="usage-tool-parts"><span>Input</span>{call.input_parts.length ? call.input_parts.map((part, index) => <EvidencePart key={`${part.kind}-${index}`} part={part} side="input" onBody={onBody} />) : <span className="usage-note">unavailable</span>}<span>Result</span>{call.result_parts.length ? call.result_parts.map((part, index) => <EvidencePart key={`${part.kind}-${index}`} part={part} side="result" onBody={onBody} />) : <span className="usage-note">not recorded</span>}</div></article>)}</div>}
      </section>; })}
    </div>
  </div>;
}

function bodyPartLabel(kind: string) {
  return kind === "invocation" ? "Input" : kind === "tool_result_content" ? "Recorded result" : kind === "tool_use_result" ? "Tool result details" : kind === "persisted_output_attachment" ? "Saved output file" : kind;
}

export function UsageSessionToolCalls(props: UsageSessionToolCallsProps) {
  return <CapturedToolCalls calls={props.calls ?? []} runs={props.runs} selectedRunId={props.selectedRunId} onBody={props.onBody} streaming={props.streaming} />;
}
