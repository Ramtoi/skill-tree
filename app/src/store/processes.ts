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

export interface ProcessLogEntry {
  ts: number;
  body: string;
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

  fail(id: string, body?: string, opts: { retry?: () => void } = {}): void {
    useProcessStore.setState((s) => ({
      processes: s.processes.map((p) =>
        p.id === id
          ? {
              ...p,
              status: "error",
              body: body ?? p.body,
              endedAt: Date.now(),
              retry: opts.retry ?? null,
            }
          : p,
      ),
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
