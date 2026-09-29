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

  // ONE log affordance (the full-width expander strip), and only when there is
  // something behind it. A log holding nothing but the breadcrumb the card was
  // seeded with is not content — offering a control for it is the exact defect
  // this replaced. So: real command output, or more than one phase step.
  // Success stays quiet — a card that lingers 3.4s should not grow chrome.
  const logCount = proc.log.length;
  // Counted separately from `logCount`: the disclosure advertises how many lines
  // the COMMAND produced, so the app's own breadcrumb never inflates the number.
  const cliCount = proc.log.filter((e) => e.source === "cli").length;
  const canOpenLog = isError
    ? cliCount > 0 || logCount > 1
    : isRunning && logCount > 1;
  // `|| expanded` keeps an open log from snapping shut when a running process
  // settles underneath the user.
  const showExpander = canOpenLog || (expanded && logCount > 0);
  const showLog = expanded && logCount > 0;
  // Running cards tail the last few steps; a failure shows the whole output
  // (the pane scrolls) because that IS the thing the user opened it for.
  const logEntries = isRunning ? proc.log.slice(-8) : proc.log;

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
          {/* The face is one line by design (CSS ellipsis), so `title` carries
              the body VERBATIM — that recovers what the ellipsis ate at narrow
              widths. It is not the full command output: the headline is already
              length-capped upstream, and the whole output lives in the log. */}
          <div className="lds-proc-body text-mono" title={proc.body || undefined}>
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
        </div>
      )}

      {showExpander ? (
        <button
          className="lds-proc-expander text-mono"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={10} />
          {expanded
            ? "collapse log"
            : isError
              ? cliCount > 0
                ? `see log · ${cliCount} ${cliCount === 1 ? "line" : "lines"}`
                : "see log"
              : `${logCount} steps`}
        </button>
      ) : null}

      {showLog && (
        <div className="lds-proc-log">
          {logEntries.map((entry, i) => {
            const fromCli = entry.source === "cli";
            return (
              <div
                key={i}
                className="lds-proc-log-line text-mono"
                data-source={entry.source ?? "app"}
              >
                <span className="lds-proc-log-ts">
                  {/* Command output arrives in one buffer at exit — stamping
                      every line with the same elapsed would be a fiction. */}
                  {fromCli ? "" : fmtSinceStart(entry.ts - proc.startedAt)}
                </span>
                <span className="lds-proc-log-body">{entry.body}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
