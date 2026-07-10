import { useMemo } from "react";
import { Processes, useProcesses } from "@/store/processes";
import { ProcessCard } from "./ProcessCard";

/** Persistent bottom-right stack of process cards. Completed cards sit above
 *  running ones so the user's most recent action is closest to the status bar. */
export function ProcessTray() {
  const procs = useProcesses();

  const { running, done, ordered } = useMemo(() => {
    const running = procs.filter((p) => p.status === "running");
    const done = procs.filter((p) => p.status !== "running");
    return { running, done, ordered: [...done, ...running] };
  }, [procs]);

  if (procs.length === 0) return null;

  return (
    <div className="lds-tray">
      {procs.length > 2 && running.length > 0 && (
        <div className="lds-tray-header text-mono">
          <span>
            {running.length} running · {done.length} done
          </span>
          {done.length > 0 && (
            <button className="lds-proc-link" onClick={() => Processes.dismissAllDone()}>
              clear done
            </button>
          )}
        </div>
      )}
      {ordered.map((p) => (
        <ProcessCard key={p.id} proc={p} />
      ))}
    </div>
  );
}
