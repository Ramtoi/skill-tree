import type { ProcessKind, ProcessStatus } from "@/store/processes";

interface KindMeta {
  accent: string;
  icon: string;
  label: string;
}

/** Kind → accent + icon. The color spine: violet/cyan/amber/green. */
export const PROC_KIND: Record<ProcessKind, KindMeta> = {
  local: { accent: "var(--violet)", icon: "cog", label: "local script" },
  remote: { accent: "var(--cyan)", icon: "link", label: "network" },
  batch: { accent: "var(--amber)", icon: "bundle", label: "batch" },
  fs: { accent: "var(--green)", icon: "folder", label: "disk" },
};

/** Resolve accent + icon for a process, switching on terminal state. */
export function kindMeta(kind: ProcessKind, status: ProcessStatus): KindMeta {
  if (status === "success") return { accent: "var(--green)", icon: "check", label: "done" };
  if (status === "error") return { accent: "var(--red)", icon: "warning", label: "failed" };
  return PROC_KIND[kind] ?? PROC_KIND.local;
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 100) / 10;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

export function fmtSinceStart(ms: number): string {
  const s = Math.floor(ms / 100) / 10;
  return `+${s.toFixed(1)}s`;
}
