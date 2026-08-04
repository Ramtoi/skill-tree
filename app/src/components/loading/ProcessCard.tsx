import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Processes, type Process } from "@/store/processes";
import { Spinner } from "./Spinner";
import { ProgressBar } from "./ProgressBar";
import { PROC_KIND, kindMeta, fmtElapsed, fmtSinceStart } from "./processMeta";

/** Live elapsed time; ticks every 250ms while running, freezes on terminate. */
function useElapsed(startedAt: number, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [endedAt]);
  return Math.max(0, (endedAt ?? now) - startedAt);
}

export function ProcessCard({ proc }: { proc: Process }) {
  const [expanded, setExpanded] = useState(false);
  const meta = kindMeta(proc.kind, proc.status);
  const elapsed = useElapsed(proc.startedAt, proc.endedAt);
  const isRunning = proc.status === "running";
  const isSuccess = proc.status === "success";
  const isError = proc.status === "error";

  const showExpander = (isRunning && proc.log.length > 1) || expanded;

  return (
    <div
      className="lds-proc"
      data-status={proc.status}
      data-kind={proc.kind}
      style={{ "--lds-accent": meta.accent } as CSSProperties}
    >
      <div className="lds-proc-strip" />
      <div className="lds-proc-row">
        <span className="lds-proc-icon">
          {isRunning ? (
            <Spinner size={13} color={meta.accent} />
          ) : (
            <Icon name={meta.icon} size={13} />
          )}
        </span>
        <div className="lds-proc-text">
          <div className="lds-proc-title">
            {proc.title}
            {proc.steps && isRunning ? (
              <span className="lds-proc-stepcount">
                {proc.step}/{proc.steps}
              </span>
            ) : null}
          </div>
          <div className="lds-proc-body text-mono">
            {proc.body || PROC_KIND[proc.kind]?.label}
          </div>
        </div>
        <div className="lds-proc-meta text-mono">
          <span className="lds-proc-elapsed">{fmtElapsed(elapsed)}</span>
        </div>
        <button
          className="lds-proc-dismiss"
          onClick={() => Processes.dismiss(proc.id)}
          title={isRunning ? "Hide (process keeps running)" : "Dismiss"}
        >
          <Icon name="x" size={11} />
        </button>
      </div>

      {isRunning && (
        <ProgressBar
          value={proc.indeterminate ? null : proc.progress}
          accent={meta.accent}
          height={2}
        />
      )}
      {(isSuccess || isError) && <div className="lds-proc-finalbar" />}

      {isError && proc.retry && (
        <div className="lds-proc-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            onClick={() => {
              const retry = proc.retry;
              Processes.dismiss(proc.id);
              retry?.();
            }}
          >
            Retry
          </Button>
          <button className="lds-proc-link" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide log" : "See log"}
          </button>
        </div>
      )}

      {showExpander ? (
        <button
          className="lds-proc-expander text-mono"
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={10} />
          {expanded ? "collapse log" : `${proc.log.length} steps`}
        </button>
      ) : null}

      {expanded && (
        <div className="lds-proc-log">
          {proc.log.slice(-8).map((entry, i) => (
            <div key={i} className="lds-proc-log-line text-mono">
              <span className="lds-proc-log-ts">
                {fmtSinceStart(entry.ts - proc.startedAt)}
              </span>
              <span className="lds-proc-log-body">{entry.body}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
