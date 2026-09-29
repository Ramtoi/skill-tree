import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import type { InspectionPayload, InspectionRun, InspectionTimeline } from "@/features/usage/usageInspectionTypes";
import { buildTimeTransform, buildTimelineLanes, flattenTimelineLanes, laneHasRecordedWork } from "./usageInspectionModel";
import { formatCompact, formatDuration } from "./usageFormat";
import { ModelName } from "./ModelName";

type WaitSpan = NonNullable<InspectionTimeline["wait_intervals"]>[number];
type WaitTick = { at: string; label?: string };

export function UsageInspectionTimeline({ payload, onToolCalls, onPin, isPinned, pinBusy = false, selectedRunId = null }: { payload: InspectionPayload; onToolCalls: (runId?: string) => void; onPin?: (runId?: string | null) => void; isPinned?: (runId?: string | null) => boolean; pinBusy?: boolean; selectedRunId?: string | null }) {
  const [selected, setSelected] = useState<string | null>(selectedRunId);
  const [zoom, setZoom] = useState(1);
  const [collapseGaps, setCollapseGaps] = useState(true);
  const [locationId, setLocationId] = useState("all");
  useEffect(() => { setSelected(selectedRunId); }, [selectedRunId]);
  const runs = useMemo(() => payload.runs ?? [], [payload.runs]);
  const lanes = useMemo(() => buildTimelineLanes(runs), [runs]);
  const visible = useMemo(() => flattenTimelineLanes(lanes), [lanes]);
  const unassignedWaits = useMemo(() => (payload.timeline?.wait_intervals ?? []).filter((wait) => wait.end && !wait.run_id && wait.status !== "unavailable"), [payload.timeline]);
  // Index recorded waits once per payload. A long session carries tens of
  // thousands of timeline events, and filtering them again inside every lane
  // on each zoom or selection made the lane list the slowest part of a render.
  const waitSpansByRun = useMemo(() => {
    const map = new Map<string, WaitSpan[]>();
    for (const wait of payload.timeline?.wait_intervals ?? []) {
      if (!wait.end || !wait.run_id || wait.status === "unavailable") continue;
      const list = map.get(wait.run_id) ?? [];
      list.push(wait);
      map.set(wait.run_id, list);
    }
    return map;
  }, [payload.timeline]);
  const waitEventsByRun = useMemo(() => {
    const map = new Map<string, WaitTick[]>();
    for (const event of payload.timeline?.events ?? []) {
      if (!event.run_id || !event.at || !event.kind.startsWith("wait_")) continue;
      const list = map.get(event.run_id) ?? [];
      list.push({ at: event.at, label: event.label });
      map.set(event.run_id, list);
    }
    return map;
  }, [payload.timeline]);
  const recordedLocations = (run: InspectionRun) => run.worktree.locations?.length ? run.worktree.locations : run.worktree.status === "observed" && run.worktree.label ? [{ id: run.worktree.label, label: run.worktree.label, basis: "command_workdir" as const }] : [{ id: "unknown", label: "Unknown", basis: "command_workdir" as const }];
  const locationOptions = useMemo(() => [{ id: "all", label: "All recorded locations" }, ...Array.from(new Map(runs.flatMap((run) => recordedLocations(run)).map((location) => [location.id, location])).values())], [runs]);
  const filtered = locationId === "all" ? visible : visible.filter((run) => recordedLocations(run).some((location) => location.id === locationId));
  const transform = useMemo(() => buildTimeTransform(payload.timeline, runs, zoom, collapseGaps), [payload.timeline, runs, zoom, collapseGaps]);
  const chosenId = selected ?? runs[0]?.id;
  const chosen = runs.find((run) => run.id === chosenId);
  // Zoom applies once to the shared canvas. The lane track stays 100% of its
  // grid column so its end remains reachable by scrolling at 200%.
  const canvasWidth = `${Math.max(100, zoom * 100)}%`;
  const start = chosen?.scopes.own.timing.first_at;
  const end = chosen?.scopes.own.timing.last_at;
  return (
    <div className="usage-inspection-timeline" data-testid="usage-inspection-timeline">
      <div className="usage-inspection-toolbar">
        <span className="usage-kicker">Captured activity</span>
        <span className="usage-note">Observed work, lifespan, and waits stay separate. Locations come from recorded command context.</span>
        <span className="usage-inspection-zoom" aria-label="Timeline zoom">
          <Button size="sm" variant="ghost" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - .25))}>−</Button>
          <span>{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((value) => Math.min(2, value + .25))}>+</Button>
        </span>
        <label className="usage-inspection-filter">Recorded location<select value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Filter timeline by recorded location">{locationOptions.map((location) => <option key={location.id} value={location.id}>{location.label}</option>)}</select></label>
        <Button size="sm" variant="ghost" aria-pressed={collapseGaps} onClick={() => setCollapseGaps((value) => !value)}>{collapseGaps ? "Expand quiet gaps" : "Collapse quiet gaps"}</Button>
      </div>
      {visible.length === 0 ? <p className="usage-note">No timeline events were captured for this session.</p> : (
        <div className="usage-timeline-canvas">
        <div className="usage-lane-list" style={{ width: canvasWidth, ['--timeline-zoom' as string]: zoom }} role="list" aria-label="Session lanes">
          {filtered.map((run) => {
            const active = run.id === chosenId;
            return (
              <button key={run.id} type="button" className={`usage-lane${active ? " is-selected" : ""}`} onClick={() => setSelected(run.id)} aria-pressed={active} data-testid="usage-inspection-lane">
                <span className="usage-lane-name" style={{ paddingLeft: `${run.depth * 18}px` }}>
                  <span className="usage-lane-label">{run.label}</span>
                  <LaneModels models={run.models} />
                </span>
                <span className="usage-lane-track" aria-hidden="true">
                  {transform.gaps.map((gap, index) => { const geometry = transform.span(new Date(gap.start).toISOString(), new Date(gap.end).toISOString()); return <span key={`gap-${gap.start}-${index}`} className="usage-lane-gap" title={`Quiet interval compressed: ${formatDuration(gap.end - gap.start)}`} style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }} />; })}
                  {run.lifespan.start && <span className={`usage-lane-life${laneHasRecordedWork(run) ? " is-observed" : ""}`} style={{ left: `${transform.span(run.lifespan.start, run.lifespan.end).left}%`, width: `${transform.span(run.lifespan.start, run.lifespan.end).width}%` }} />}
                  {run.activity_intervals.filter((item) => item.status === "observed").map((item) => { const geometry = transform.span(item.start, item.end); return <span key={`${item.start}-${item.end}`} className="usage-lane-active" style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }} />; })}
                  {(waitSpansByRun.get(run.id) ?? []).map((wait, index) => { const geometry = transform.span(wait.start, wait.end); return <span key={`wait-interval-${wait.start}-${index}`} className="usage-lane-wait-span" title="Recorded wait interval" style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }} />; })}
                  {(waitEventsByRun.get(run.id) ?? []).map((event, index) => <span key={`${event.at}-${index}`} className="usage-lane-wait" title={event.label ?? "Recorded wait"} style={{ left: `${transform.position(event.at)}%` }} />)}
                </span>
                {(() => { const stat = `${tokenLabel(run.scopes.own.tokens)} tok · ${formatCount(run.tool_calls)} ${run.tool_calls === 1 ? "tool" : "tools"}`; return <span className="usage-lane-stat" title={stat}>{stat}</span>; })()}
              </button>
            );
          })}
          {unassignedWaits.length > 0 && <div className="usage-lane usage-lane-unassigned" role="listitem">
            <span className="usage-lane-name"><span className="usage-lane-label">Session waits (unassigned)</span></span>
            <span className="usage-lane-track" aria-hidden="true">
              {unassignedWaits.map((wait, index) => { const geometry = transform.span(wait.start, wait.end); return <span key={`unassigned-wait-${wait.start}-${index}`} className="usage-lane-wait-span" title="Recorded session wait" style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }} />; })}
            </span>
            <span className="usage-lane-stat">{formatCount(unassignedWaits.length)} {unassignedWaits.length === 1 ? "wait" : "waits"}</span>
          </div>}
        </div>
        {transform.min < transform.max && <div className="usage-timeline-ticks" style={{ width: canvasWidth }} aria-label="Elapsed timeline scale"><span aria-hidden="true" /><div className="usage-timeline-axis-track"><time>0m</time><time>{formatDuration(transform.max - transform.min)}</time></div><span className="usage-timeline-axis-stat" aria-hidden="true" /></div>}
        </div>
      )}
      {chosen && (
        <section className="usage-inspection-selection" aria-label={`${chosen.label} statistics`}>
          <div className="usage-inspection-selection-heading"><div><strong>{chosen.label}</strong>{chosen.role.value && <Tag size="sm">{chosen.role.value}</Tag>}</div><div className="usage-inspection-selection-actions"><Button size="sm" variant="soft" onClick={() => onToolCalls(chosen.id)}>Open Tool calls for this agent</Button>{onPin && (() => { const pinRunId = chosen.parent_id === null ? null : chosen.id; const pinned = isPinned?.(pinRunId) ?? false; const label = pinned ? (pinRunId ? "Unpin agent subtree" : "Unpin session") : (pinRunId ? "Pin agent subtree" : "Pin session"); return <Button size="sm" variant="ghost" icon="pin" title={label} aria-label={label} aria-pressed={pinned} busy={pinBusy} onClick={() => onPin(pinRunId)} />; })()}</div></div>
          <div className="usage-inspection-stats">
            <span>Own <b>{tokenLabel(chosen.scopes.own.tokens)}</b></span>
            <span>Children <b>{tokenLabel(chosen.scopes.children.tokens)}</b></span>
            <span>Subtree <b>{tokenLabel(chosen.scopes.subtree.tokens)}</b></span>
            <span>Cost <b>{chosen.scopes.own.cost.status !== "known" || chosen.scopes.own.cost.value == null ? chosen.scopes.own.cost.status : `$${chosen.scopes.own.cost.value.toFixed(4)}`}</b></span>
            <span>Activity <b>{chosen.scopes.own.timing.active_ms == null ? "unavailable" : formatDuration(chosen.scopes.own.timing.active_ms)}</b></span>
            <span>Models <b>{chosen.models.length ? chosen.models.join(", ") : "unavailable"}</b></span>
            <span>Edits <b>{formatCount(chosen.edits)}</b></span>
          </div>
          {start && end && <span className="usage-note">Observed {new Date(start).toLocaleTimeString()}–{new Date(end).toLocaleTimeString()}</span>}
        </section>
      )}
      {transform.gaps.length ? <p className="usage-note">{transform.gaps.length} shared quiet interval{transform.gaps.length === 1 ? "" : "s"} {collapseGaps ? "compressed across lanes" : "shown at recorded duration"}.</p> : null}
      <div className="usage-timeline-legend" aria-label="Timeline legend"><span><i className="is-life" /> observed lifespan</span><span><i className="is-active" /> recorded activity</span><span><i className="is-wait" /> recorded wait</span>{transform.gaps.length > 0 && <span><i className="is-gap" /> quiet interval compressed</span>}</div>
      {payload.timeline?.relationship_edges?.length ? <div className="usage-timeline-relationships" aria-label="Observed relationships">{payload.timeline.relationship_edges.map((edge, index) => <span key={`${edge.from_run_id}-${edge.to_run_id ?? "generic"}-${index}`}><Tag size="sm">{formatRelationship(edge.kind)}</Tag> {runLabel(runs, edge.from_run_id)} → {edge.to_run_id ? runLabel(runs, edge.to_run_id) : "target unavailable"}</span>)}</div> : null}
    </div>
  );
}

/** The lane's second line: which model answered. The first model reads as
 *  the shared `ModelName` label; further models fold into a `+N` whose hover
 *  lists them all. A lane the capture could not attribute says so quietly. */
function LaneModels({ models }: { models: string[] }) {
  if (models.length === 0) return <span className="usage-lane-model is-unavailable">model unavailable</span>;
  return (
    <span className="usage-lane-model">
      <ModelName model={models[0]} />
      {models.length > 1 && <span className="usage-lane-model-more" title={models.join(", ")}>+{models.length - 1}</span>}
    </span>
  );
}

function formatCount(value: number) { return new Intl.NumberFormat().format(value); }
function tokenLabel(tokens: InspectionRun["scopes"]["own"]["tokens"]) {
  if (tokens.total == null || tokens.status !== "available") return tokens.status === "partial" && tokens.total != null ? `${formatCompact(tokens.total)} · partial` : "unavailable";
  return formatCompact(tokens.total);
}
function formatRelationship(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function runLabel(runs: InspectionRun[], id: string) { return runs.find((run) => run.id === id)?.label ?? "run unavailable"; }

export type { InspectionRun };
