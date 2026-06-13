import { useProcesses } from "@/store/processes";
import { Spinner } from "./Spinner";
import { ProgressBar } from "./ProgressBar";

/** Status-bar segment shown while one or more processes are running. Renders
 *  null when nothing is in flight, so the host can fall back to its idle
 *  segment. Aggregate progress is the mean of running processes (indeterminate
 *  counts as 0.4 so the bar never flatlines). */
export function StatusBarWorking() {
  const procs = useProcesses();
  const running = procs.filter((p) => p.status === "running");
  if (running.length === 0) return null;

  const aggregate =
    running.reduce((sum, p) => sum + (p.progress ?? 0.4), 0) / running.length;
  const head = running[0];

  return (
    <span className="status-segment lds-status-working" title={head.title}>
      <Spinner size={9} color="var(--amber)" />
      {running.length === 1 ? (
        <span className="lds-status-label">
          {head.title}
          <span className="text-dim"> · {head.body}</span>
        </span>
      ) : (
        <span className="lds-status-label">
          {running.length} processes
          <span className="text-dim"> · {head.title}</span>
        </span>
      )}
      <span className="lds-status-bar">
        <ProgressBar value={aggregate} height={3} accent="var(--amber)" />
      </span>
    </span>
  );
}

/** Number of currently-running processes — lets the host pick render priority. */
export function useRunningCount(): number {
  const procs = useProcesses();
  return procs.filter((p) => p.status === "running").length;
}
