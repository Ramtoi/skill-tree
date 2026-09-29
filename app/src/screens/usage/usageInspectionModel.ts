import type { InspectionRun, InspectionTimeline, InspectionToolCall } from "@/features/usage/usageInspectionTypes";

export type TimelineLane = InspectionRun & { children: TimelineLane[] };

/** Build one stable tree for the shared timeline. Main/root lanes always come
 *  first, then siblings use observed start and id as deterministic ties. */
export function buildTimelineLanes(runs: InspectionRun[]): TimelineLane[] {
  const byParent = new Map<string | null, TimelineLane[]>();
  for (const run of runs) {
    const lane = { ...run, children: [] };
    const list = byParent.get(run.parent_id) ?? [];
    list.push(lane);
    byParent.set(run.parent_id, list);
  }
  const sort = (a: TimelineLane, b: TimelineLane) => {
    const at = a.start.at ? Date.parse(a.start.at) : Number.POSITIVE_INFINITY;
    const bt = b.start.at ? Date.parse(b.start.at) : Number.POSITIVE_INFINITY;
    return at - bt || a.depth - b.depth || a.id.localeCompare(b.id);
  };
  for (const list of byParent.values()) list.sort(sort);
  for (const lane of byParent.values()) {
    for (const item of lane) item.children = byParent.get(item.id) ?? [];
  }
  return (byParent.get(null) ?? []).sort((a, b) => a.depth - b.depth || sort(a, b));
}

export function flattenTimelineLanes(lanes: TimelineLane[]): TimelineLane[] {
  return lanes.flatMap((lane) => [lane, ...flattenTimelineLanes(lane.children)]);
}

export function laneHasRecordedWork(run: InspectionRun): boolean {
  return run.worktree.status === "observed" || run.activity_intervals.length > 0 || run.tool_calls > 0 || run.edits > 0;
}

type NumericInterval = { start: number; end: number };
const GAP_MIN_MS = 20 * 60 * 1000;

function validInterval(start: string | null | undefined, end: string | null | undefined): NumericInterval | null {
  if (!start || !end) return null;
  const parsed = { start: Date.parse(start), end: Date.parse(end) };
  return Number.isFinite(parsed.start) && Number.isFinite(parsed.end) && parsed.end > parsed.start ? parsed : null;
}

function unionIntervals(intervals: NumericInterval[]): NumericInterval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end).reduce<NumericInterval[]>((merged, current) => {
    const previous = merged[merged.length - 1];
    if (previous && current.start <= previous.end) previous.end = Math.max(previous.end, current.end);
    else merged.push({ ...current });
    return merged;
  }, []);
}

/** Return the global complement intervals eligible for compression. The
 * union is built from observed work and completed waits before any lane is
 * filtered. Lifespan boundaries and point events split candidates so a quiet
 * span cannot erase evidence at either edge. */
export function globalGapIntervals(timeline: InspectionTimeline | undefined, runs: InspectionRun[]) {
  const active = runs.flatMap((run) => run.activity_intervals
    .filter((item) => item.status === "observed")
    .map((item) => validInterval(item.start, item.end))
    .filter((item): item is NumericInterval => item !== null));
  const points = runs.flatMap((run) => [run.lifespan.start, run.lifespan.end, ...run.activity_intervals.flatMap((item) => [item.start, item.end])]);
  const waitIntervals = timeline?.wait_intervals ?? [];
  for (const wait of waitIntervals) {
    const interval = wait.status === "observed" ? validInterval(wait.start, wait.end) : null;
    if (interval) active.push(interval);
    points.push(wait.start, wait.end);
  }
  const pendingWaits = new Map<string, number>();
  for (const event of timeline?.events ?? []) {
    if (event.at) points.push(event.at);
    if (!event.at || !event.run_id) continue;
    const key = event.run_id;
    if (event.kind === "wait_started") pendingWaits.set(key, Date.parse(event.at));
    if (event.kind === "wait_result") {
      const start = pendingWaits.get(key);
      const interval = start === undefined || !Number.isFinite(start) ? null : validInterval(new Date(start).toISOString(), event.at);
      if (interval && event.status !== "unavailable") active.push(interval);
      pendingWaits.delete(key);
    }
  }
  const numericPoints = [timeline?.origin, ...points].map((point) => point ? Date.parse(point) : NaN).filter(Number.isFinite) as number[];
  const merged = unionIntervals(active);
  if (numericPoints.length < 2) return [];
  const min = Math.min(...numericPoints);
  const max = Math.max(...numericPoints);
  const cutpoints = [...new Set([min, max, ...numericPoints])].sort((a, b) => a - b);
  const gaps: NumericInterval[] = [];
  for (let index = 0; index < cutpoints.length - 1; index += 1) {
    const start = cutpoints[index];
    const end = cutpoints[index + 1];
    if (end - start >= GAP_MIN_MS && !merged.some((interval) => interval.start <= start && interval.end >= end)) gaps.push({ start, end });
  }
  // Older stores may include explicit candidates. Keep them only when the
  // observed union does not span them; this remains safe for a long operation.
  for (const gap of timeline?.gaps ?? []) {
    const explicit = validInterval(gap.start, gap.end);
    if (explicit && explicit.end - explicit.start >= GAP_MIN_MS && !merged.some((interval) => interval.start <= explicit.start && interval.end >= explicit.end)) gaps.push(explicit);
  }
  return unionIntervals(gaps);
}

export type TimeTransform = { min: number; max: number; gaps: Array<{ start: number; end: number }>; position: (at: string | null) => number; span: (start: string | null, end: string | null) => { left: number; width: number } };

/** One coordinate system for every lane. Gaps are selected before any lane
 *  filter is applied, and an observed interval spanning a candidate removes
 *  that candidate so a long running operation is never visually collapsed. */
export function buildTimeTransform(timeline: InspectionTimeline | undefined, runs: InspectionRun[], ...options: [number?, boolean?]): TimeTransform {
  // Zoom changes the shared canvas width in the view. Keep it out of the
  // timestamp transform so every lane and the elapsed axis retain one scale.
  const collapseGaps = options[1] ?? true;
  const points = [
    ...(timeline?.origin ? [Date.parse(timeline.origin)] : []),
    ...runs.flatMap((run) => [run.lifespan.start, run.lifespan.end, ...run.activity_intervals.flatMap((interval) => [interval.start, interval.end])]),
    ...(timeline?.events ?? []).map((event) => event.at),
    ...(timeline?.wait_intervals ?? []).flatMap((wait) => [wait.start, wait.end]),
  ].map((point) => typeof point === "string" ? Date.parse(point) : point).filter(Number.isFinite) as number[];
  const min = points.length ? Math.min(...points) : 0;
  const max = Math.max(...points, min + 1);
  const gaps = collapseGaps ? globalGapIntervals(timeline, runs) : [];
  const total = max - min;
  const collapsed = gaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  const compressedTotal = Math.max(1, total - collapsed);
  const transform = (at: string | null) => {
    if (!at) return 0;
    const value = Date.parse(at);
    if (!Number.isFinite(value)) return 0;
    const removed = gaps.reduce((sum, gap) => sum + Math.max(0, Math.min(value, gap.end) - gap.start), 0);
    const base = ((value - min - removed) / compressedTotal) * 100;
    return base;
  };
  return {
    min, max, gaps,
    position: (at) => Math.max(0, Math.min(100, transform(at))),
    span: (start, end) => {
      const left = transform(start);
      const right = transform(end ?? start);
      return { left: Math.max(0, left), width: Math.max(0.5, right - left) };
    },
  };
}

export type ToolGroup = { key: string; tool: InspectionToolCall["tool"]; operation: string | null; label: string | null; calls: InspectionToolCall[] };

/** Store paging can be ordered by opaque call id. Render chronology from the
 * recorded timestamp instead, with ordinal/id as deterministic fallbacks for
 * equal or unknown times. */
export function sortToolCallsChronologically(calls: InspectionToolCall[]): InspectionToolCall[] {
  return calls.map((call, index) => ({ call, index })).sort((a, b) => {
    const at = a.call.at ? Date.parse(a.call.at) : Number.POSITIVE_INFINITY;
    const bt = b.call.at ? Date.parse(b.call.at) : Number.POSITIVE_INFINITY;
    return at - bt || a.call.ordinal - b.call.ordinal || a.call.id.localeCompare(b.call.id) || a.index - b.index;
  }).map(({ call }) => call);
}

/** Group only adjacent, semantically identical calls. Keys on the operation
 * signature (a content hash), never the summary, so two distinct operations
 * that redact to the same human text stay separate; the summary is carried
 * only as the display label. Keeping this pure makes paging safe: callers
 * concatenate all pages before grouping. */
export function groupToolCalls(calls: InspectionToolCall[]): ToolGroup[] {
  return sortToolCallsChronologically(calls).reduce<ToolGroup[]>((groups, call) => {
    const operation = call.operation.signature ?? null;
    // Signatures are identity keys, not human-facing labels. Older or
    // partially captured rows without a summary remain explicit but never
    // expose the op:<sha256> value in the UI.
    const label = call.operation.summary;
    const previous = groups[groups.length - 1];
    if (previous && operation !== null && previous.tool.name === call.tool.name && previous.operation === operation) previous.calls.push(call);
    else groups.push({ key: call.id, tool: call.tool, operation, label, calls: [call] });
    return groups;
  }, []);
}

export function decodeBodyChunks(chunks: Array<{ base64: string }>): Uint8Array {
  const bytes = chunks.flatMap((chunk) => Array.from(atob(chunk.base64), (char) => char.charCodeAt(0)));
  return Uint8Array.from(bytes);
}

export function bodyText(bytes: Uint8Array, contentType = "text/plain"): string {
  if (contentType.includes("json")) {
    try { return JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2); } catch { /* retain raw */ }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
