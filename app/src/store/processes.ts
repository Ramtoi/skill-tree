import { useMemo } from "react";
import { create } from "zustand";

// ════════════════════════════════════════════════════════════════════════════
//  Process registry — the source of truth for in-flight work.
//
//  Mirrors the design handoff's pubsub model on top of Zustand so the imperative
//  `Processes.*` API can be called from anywhere (event handlers, async flows)
//  while React components subscribe via `useProcesses` / `useProcessFor`.
//
//    Processes.start({ ... })       → id
//    Processes.update(id, patch)
//    Processes.succeed(id, body?)   → auto-dismisses after 3.4s
//    Processes.fail(id, body?, { retry })
//    Processes.dismiss(id)
// ════════════════════════════════════════════════════════════════════════════

export type ProcessKind = "local" | "remote" | "batch" | "fs";
export type ProcessStatus = "running" | "success" | "error";

/** `app` — a client-side phase breadcrumb, timed against the process start.
 *  `cli` — a line the command itself printed. We only get the command's output
 *  at exit, so those lines have no honest per-line timing; the card renders
 *  them without an elapsed stamp rather than stamping them all identically. */
export type ProcessLogSource = "app" | "cli";

export interface ProcessLogEntry {
  ts: number;
  body: string;
  source?: ProcessLogSource;
}

export interface Process {
  id: string;
  title: string;
  body: string;
  kind: ProcessKind;
  target: string | null;
  steps: number | null;
  step: number;
  /** 0..1 when determinate, null when indeterminate. */
  progress: number | null;
  indeterminate: boolean;
  status: ProcessStatus;
  startedAt: number;
  endedAt: number | null;
  log: ProcessLogEntry[];
  retry: (() => void) | null;
}

export interface StartProcessInput {
  title: string;
  body?: string;
  kind?: ProcessKind;
  steps?: number | null;
  target?: string | null;
  indeterminate?: boolean;
}

export type ProcessPatch = Partial<
  Pick<Process, "progress" | "step" | "body" | "indeterminate">
>;

interface ProcessStore {
  processes: Process[];
}

const useProcessStore = create<ProcessStore>(() => ({ processes: [] }));

let idCounter = 0;

/** How long a succeeded card lingers as a banner before auto-dismissing. */
const SUCCESS_LINGER_MS = 3400;

/** Upper bound on the COMMAND output a failed card keeps. Generous (a real
 *  `hub sync` failure can run to dozens of lines and the log pane scrolls) but
 *  not unbounded. Applies to the appended output only — existing entries, incl.
 *  the app's own phase breadcrumbs, are never evicted. */
const FAILURE_LOG_CAP = 200;

export const Processes = {
  start({
    title,
    body = "",
    kind = "local",
    steps = null,
    target = null,
    indeterminate = false,
  }: StartProcessInput): string {
    const id = `p${++idCounter}`;
    const now = Date.now();
    const next: Process = {
      id,
      title,
      body,
      kind,
      target,
      steps,
      step: 0,
      progress: indeterminate ? null : 0,
      indeterminate,
      status: "running",
      startedAt: now,
      endedAt: null,
      log: body ? [{ ts: now, body }] : [],
      retry: null,
    };
    useProcessStore.setState((s) => ({ processes: [...s.processes, next] }));
    return id;
  },

  update(id: string, patch: ProcessPatch): void {
    useProcessStore.setState((s) => ({
      processes: s.processes.map((p) => {
        if (p.id !== id) return p;
        const log =
          patch.body && patch.body !== p.body
            ? [...p.log, { ts: Date.now(), body: patch.body }].slice(-12)
            : p.log;
        return { ...p, ...patch, log };
      }),
    }));
  },

  succeed(id: string, body?: string): void {
    useProcessStore.setState((s) => ({
      processes: s.processes.map((p) =>
        p.id === id
          ? {
              ...p,
              status: "success",
              progress: 1,
              body: body ?? p.body,
              endedAt: Date.now(),
            }
          : p,
      ),
    }));
    // Success cards double as the success banner — auto-dismiss after a beat.
    setTimeout(() => Processes.dismiss(id), SUCCESS_LINGER_MS);
  },

  /**
   * Terminate a process as failed. `body` is the one-line "what failed";
   * `opts.log` is the operation's real output, appended to the card's log so a
   * failure carries its evidence instead of just the client-side breadcrumb the
   * card was seeded with. Passing no `log` leaves the log untouched — the card
   * then renders no log chrome at all.
   *
   * IDEMPOTENT: a process that already failed is left exactly as it is. A retry
   * path that double-reports (or two callers racing the same id) must not append
   * the same output twice or re-stamp `endedAt`.
   */
  fail(
    id: string,
    body?: string,
    opts: { retry?: () => void; log?: string[] } = {},
  ): void {
    const now = Date.now();
    const supplied = (opts.log ?? []).filter((line) => line.trim() !== "");
    // Cap the COMMAND output only, keeping its tail (where the failure is), and
    // say so rather than silently dropping lines. Existing entries are never
    // evicted — a blanket `.slice(-CAP)` over the merged list would delete the
    // app's own phase breadcrumbs on a very chatty failure.
    const omitted = Math.max(0, supplied.length - FAILURE_LOG_CAP);
    const kept = omitted > 0 ? supplied.slice(-FAILURE_LOG_CAP) : supplied;
    const appended = [
      ...(omitted > 0
        ? [
            {
              ts: now,
              body: `… ${omitted} earlier ${omitted === 1 ? "line" : "lines"} omitted`,
              source: "cli" as const,
            },
          ]
        : []),
      ...kept.map((b) => ({ ts: now, body: b, source: "cli" as const })),
    ];
    useProcessStore.setState((s) => ({
      processes: s.processes.map((p) => {
        if (p.id !== id || p.status === "error") return p;
        return {
          ...p,
          status: "error",
          body: body ?? p.body,
          endedAt: now,
          retry: opts.retry ?? null,
          log: appended.length ? [...p.log, ...appended] : p.log,
        };
      }),
    }));
    // Errors stay until dismissed.
  },

  dismiss(id: string): void {
    useProcessStore.setState((s) => ({
      processes: s.processes.filter((p) => p.id !== id),
    }));
  },

  dismissAllDone(): void {
    useProcessStore.setState((s) => ({
      processes: s.processes.filter((p) => p.status === "running"),
    }));
  },

  list(): Process[] {
    return useProcessStore.getState().processes;
  },
};

/** Subscribe a component to the full process list. */
export function useProcesses(): Process[] {
  return useProcessStore((s) => s.processes);
}

/** Subscribe to the (first) process tied to a given target id, e.g. a source. */
export function useProcessFor(target: string | null | undefined): Process | null {
  return useProcessStore((s) =>
    target == null ? null : s.processes.find((p) => p.target === target) ?? null,
  );
}

/** The shared empty result. A stable reference so a caller with no prefix
 *  (out of bundle mode) or no matching processes never sees a fresh array
 *  on every render. */
const EMPTY_TARGETS: string[] = [];

/** Subscribe to just the running targets under `prefix` — e.g. a library row
 *  in bundle mode, which only cares about its own bundle's `bundle-add:`
 *  writes, not a per-chunk progress update on some unrelated process
 *  (`useProcesses()` re-renders on every process-store change anywhere).
 *  `prefix` is `null` out of bundle mode; the hook is still called every
 *  render (React's rules of hooks), and a `null` prefix always resolves to
 *  `EMPTY_TARGETS` without scanning the process list.
 *  The zustand selector returns a joined STRING, not an array — a fresh
 *  array from `.filter().map()` would compare unequal every render even
 *  when the matching targets haven't changed, defeating zustand's
 *  reference-equality bailout. The string is stable across unrelated
 *  updates, so `useMemo` below only re-splits when it actually changes.
 *  The join/split separator is "\u001f" (unit separator), not a character
 *  a process target can ever contain, unlike "\n" or ":". */
export function useRunningTargets(prefix: string | null): string[] {
  const joined = useProcessStore((s) =>
    prefix == null
      ? ""
      : s.processes
          .filter((p) => p.status === "running" && p.target?.startsWith(prefix))
          .map((p) => p.target as string)
          .join("\u001f"),
  );
  return useMemo(() => (joined ? joined.split("\u001f") : EMPTY_TARGETS), [joined]);
}
