import type { ReactNode } from "react";
import { useCallback } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Button, type ButtonVariant } from "@/components/Button";
import type { UsageScanResult } from "@/features/usage/usageAnalyticsTypes";
import { SCAN_MUTATION_KEY, useScanSessions } from "@/hooks/useUsageAnalytics";
import { trackProcess } from "@/lib/trackProcess";
import { plural } from "@/lib/plural";
import { qk } from "@/lib/queryKeys";
import { Processes, useProcesses } from "@/store/processes";

/**
 * The transcript-scan action (`hub usage scan-sessions`, design D14.5) — a
 * separate transcript action that can follow the ccusage scan on the Usage
 * header. `ScanButton` renders in several places (the
 * Overview header's `secondary`, both drill-down routes' `primary`, and the
 * empty state's CTA), so both its BUSY state and its last RESULT come from
 * shared sources, named here once, rather than from three independent
 * `useMutation` instances that could disagree.
 */

/** Process-store target for this scan — distinct from the ccusage scan's own
 *  `USAGE_SCAN_TARGET = "usage:scan"` (`features/usage/useLocalAgentUsage.ts:44`)
 *  so the two unrelated processes never share one StatusBar slot. */
export const USAGE_SESSION_SCAN_TARGET = "usage:scan-sessions";

export const REPLAN_REQUIRED_COPY =
  "A reader required by this scan is unavailable or incompatible. Previously captured results are still available.";

/** Classify only the backend's explicit pass-level verdict. Ordinary file
 * errors do not imply that a saved scan needs a fresh pass. */
export function isReplanRequired(result: Pick<UsageScanResult, "state"> | null | undefined): boolean {
  return result?.state === "replan_required";
}

export function scanFailureCopy(result: UsageScanResult): string {
  if (isReplanRequired(result)) return `This saved scan cannot continue. ${REPLAN_REQUIRED_COPY}`;
  return `Scan stopped on ${result.stopped_on ?? "a transcript"}`;
}

/** Re-exported from `hooks/useUsageAnalytics.ts` (the single source of the
 *  literal array) rather than redeclared here — every OTHER consumer of the
 *  key imports it from this file. */
export { SCAN_MUTATION_KEY };

/** Busy state from the process store — every rendered `ScanButton` reads the
 *  SAME entry, so two instances (a route header and the Overview) always
 *  agree about whether a scan is running (design D14.5, G5). */
export function useScanBusy(): boolean {
  // The process tray keeps settled cards briefly and may contain several
  // entries for this target. Read the active entry rather than the first
  // historical one, or a stale error/success card can leave sibling Scan
  // buttons enabled during a later transcript capture.
  return useProcesses().some((process) => process.target === USAGE_SESSION_SCAN_TARGET && process.status === "running");
}

/** The latest settled result, read from one bounded query-cache entry rather
 *  than mutation history, so a scan started in a route header still renders
 *  its banner in a different subtree (design D14.5, G5). Resolved soft
 *  failures and successes both replace that one entry; transport errors leave
 *  the previous result available for recovery. */
export function useLastScanResult(): UsageScanResult | undefined {
  const query = useQuery<UsageScanResult>({
    queryKey: qk.usageScanRecovery(),
    queryFn: skipToken,
    gcTime: Infinity,
  });
  return query.data;
}

export interface ScanButtonProps {
  variant?: ButtonVariant;
  children?: ReactNode;
  before?: () => Promise<void>;
  /** Optional complete workflow owned by the caller. Used by the Usage
   *  overview so its header shares the same ccusage + transcript singleflight
   *  guard as the breakdown and first-run controls. */
  onRun?: () => Promise<void>;
  busy?: boolean;
  title?: string;
}

/**
 * Runs `hub usage scan-sessions` wrapped in an indeterminate process card
 * (design D14.5, G14) — the command is one blocking `hub_cmd` with no
 * progress stream, so `trackProcess` never fabricates a determinate bar.
 * `failWhen` turns a `{ok: false}` result (the command still exits 0) into a
 * failed card naming the file the scan stopped on, without throwing — every
 * row the scan already wrote stays visible (story 67).
 */
export function useRunTranscriptScan(): () => Promise<void> {
  const scan = useScanSessions();
  const run = useCallback(async () => {
    // `trackProcess` starts synchronously. Check its shared store before
    // entering it so two sibling buttons clicked in the same event turn can
    // never create two transcript commands before React renders `busy`.
    if (Processes.list().some((process) => process.target === USAGE_SESSION_SCAN_TARGET && process.status === "running")) return;

    const options: {
      failWhen: (result: UsageScanResult) => string | null;
      retry?: () => void;
    } = {
      failWhen: (result) => {
        if (isReplanRequired(result)) {
          // trackProcess reads retry only after failWhen resolves. Clearing the
          // local option therefore suppresses the misleading continuation
          // retry while preserving ordinary failure retry behavior.
          options.retry = undefined;
          return scanFailureCopy(result);
        }
        return result.ok ? null : scanFailureCopy(result);
      },
      retry: () => {
        void run();
      },
    };
    try {
      await trackProcess<UsageScanResult>(
        {
          title: "Scanning transcripts",
          body: "reading every transcript once — later scans read only new bytes",
          kind: "local",
          target: USAGE_SESSION_SCAN_TARGET,
        },
        async (ctl) => {
          const result = await scan.mutateAsync();
          const harnessCounts = result.harnesses;
          const harnessText = harnessCounts
            ? ` (claude ${harnessCounts["claude-code"]?.rows_written ?? 0}, codex ${harnessCounts.codex?.rows_written ?? 0} rows)`
            : "";
          ctl.update({
            body: `${result.rows_written} ${plural(result.rows_written, "session")} written, ${result.rows_frozen} frozen${harnessText}`,
          });
          return result;
        },
        options,
      );
    } catch {
      /* The process card carries the failure; nothing further to say here. */
    }
  }, [scan]);
  return run;
}

export function ScanButton({ variant = "primary", children, before, onRun, busy = false, title }: ScanButtonProps) {
  const runTranscriptScan = useRunTranscriptScan();
  const transcriptBusy = useScanBusy();

  const run = async () => {
    if (onRun) {
      await onRun();
      return;
    }
    if (before) {
      try {
        await before();
      } catch {
        /* A failed preceding scan is already represented by its own state. */
      }
    }
    await runTranscriptScan();
  };

  return (
    <Button variant={variant} icon="rescan" busy={busy || transcriptBusy} title={title} onClick={() => void run()}>
      {children ?? "Scan"}
    </Button>
  );
}
