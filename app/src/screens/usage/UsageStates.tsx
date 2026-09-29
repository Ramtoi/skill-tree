import { Button } from "@/components/Button";
import { Spinner } from "@/components/loading/Spinner";

export type UsageErrorKindUi = "permission" | "no_usage" | "ccusage";

export function UsageLoadingState() {
  return (
    <div className="usage-state usage-state-loading" role="status">
      <Spinner size={22} stroke={2} />
      <div>
        <h3>Loading latest cached scan…</h3>
        <p>The dashboard opens from the local cache first, then you can refresh with a new ccusage scan.</p>
      </div>
    </div>
  );
}

export interface UsageErrorStateProps {
  kind: UsageErrorKindUi;
  diagnostic: string;
  onRetry: () => void;
  onCopyDiagnostic: (text: string) => void;
}

const ERROR_COPY: Record<UsageErrorKindUi, { title: string; body: string }> = {
  permission: {
    title: "Skill Tree cannot access local usage logs",
    body: "This looks like a permission or sandbox access issue. The scan runs locally, so Skill Tree needs access to the harness log locations on this machine.",
  },
  no_usage: {
    title: "No usage found",
    body: "ccusage ran locally but did not find supported harness usage yet. Use a coding harness, then retry the scan.",
  },
  ccusage: {
    title: "ccusage could not finish the scan",
    body: "The bundled ccusage runner returned a failure. Copy the diagnostic if you need to troubleshoot the local machine setup.",
  },
};

/** Full-screen state for a failed scan with no prior cached snapshot to fall
 *  back to. */
export function UsageErrorState({ kind, diagnostic, onRetry, onCopyDiagnostic }: UsageErrorStateProps) {
  const copy = ERROR_COPY[kind];
  return (
    <div className="usage-state usage-state-error" role="alert">
      <span className="usage-kicker">Local scan issue</span>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <div className="usage-error-actions">
        <Button variant="soft" icon="rescan" onClick={onRetry}>
          Retry scan
        </Button>
        <Button variant="ghost" onClick={() => onCopyDiagnostic(diagnostic)}>
          Copy diagnostic
        </Button>
      </div>
    </div>
  );
}

export function UsageFirstRunEmpty({ busy, onScan }: { busy: boolean; onScan: () => void }) {
  return (
    <div className="usage-state usage-empty">
      <span className="usage-kicker">First run</span>
      <h3>No cached usage scan yet</h3>
      <p>
        Scan local usage to summarize token and estimated API-equivalent cost from coding harness logs
        ccusage can detect on this machine.
      </p>
      <Button variant="primary" icon="rescan" busy={busy} onClick={onScan}>
        Scan local usage
      </Button>
    </div>
  );
}

export function UsageNoUsageState({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  return (
    <div className="usage-state usage-empty" role="status">
      <span className="usage-kicker">No usage found</span>
      <h3>No local harness usage was detected yet</h3>
      <p>
        ccusage ran locally, but did not find supported harness logs with usage data. Try again after
        using Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Qwen, Kimi, Goose, Hermes, or another
        supported harness.
      </p>
      <Button variant="soft" icon="rescan" busy={busy} onClick={onRetry}>
        Retry scan
      </Button>
    </div>
  );
}
