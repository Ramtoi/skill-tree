import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Spinner } from "@/components/loading/Spinner";
import { REPLAN_REQUIRED_COPY, isReplanRequired, useLastScanResult, useRunTranscriptScan, useScanBusy } from "./UsageScanAction";

function focusHeaderScan(): HTMLButtonElement | null {
  const scan = Array.from(document.querySelectorAll<HTMLButtonElement>(".main-header-right button")).find((button) =>
    !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
      (/scan/i.test(button.textContent ?? "") || /scan/i.test(button.title)),
  );
  return scan ?? null;
}

/** One route-shared recovery notice for a saved transcript pass that cannot
 * continue. It reads the settled mutation cache, so retained route content
 * and the notice survive navigation while a fresh pass is running. */
export interface UsageScanRecoveryProps {
  /** The overview header also waits for its ccusage pass. Its owner passes
   * that combined busy state so focus restoration follows the actual header
   * readiness rather than guessing from the transcript process alone. */
  headerBusy?: boolean;
}

export function UsageScanRecovery({ headerBusy }: UsageScanRecoveryProps = {}) {
  const result = useLastScanResult();
  const runTranscriptScan = useRunTranscriptScan();
  const busy = useScanBusy();
  const noticeRef = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const restoringFocus = useRef(false);
  const [restorePending, setRestorePending] = useState(false);
  const visible = isReplanRequired(result);
  const resolvedHeaderBusy = headerBusy ?? busy;

  useLayoutEffect(() => {
    if (visible) {
      if (noticeRef.current?.contains(document.activeElement)) hadFocus.current = true;
      return;
    }
    if (!restorePending && hadFocus.current) {
      hadFocus.current = false;
      setRestorePending(true);
    }
  }, [restorePending, visible]);

  useLayoutEffect(() => {
    if (!restorePending) return;

    const cancelForUserFocus = () => {
      if (!restoringFocus.current) setRestorePending(false);
    };
    document.addEventListener("focusin", cancelForUserFocus);
    return () => document.removeEventListener("focusin", cancelForUserFocus);
  }, [restorePending]);

  useLayoutEffect(() => {
    if (!restorePending || resolvedHeaderBusy) return;
    const active = document.activeElement;
    const focusMovedElsewhere = active && active !== document.body && active !== document.documentElement &&
      (!(active instanceof HTMLElement) || active.isConnected);
    if (focusMovedElsewhere) {
      setRestorePending(false);
      return;
    }
    const scan = focusHeaderScan();
    if (!scan) return;
    restoringFocus.current = true;
    setRestorePending(false);
    scan.focus();
    restoringFocus.current = false;
  }, [resolvedHeaderBusy, restorePending]);

  if (!visible) return null;

  const startNewScan = () => {
    // Pointer activation does not prove that this control owned focus. The
    // focus/blur capture handlers record actual ownership for restoration.
    if (noticeRef.current?.contains(document.activeElement)) hadFocus.current = true;
    void runTranscriptScan();
  };

  return (
    <div
      ref={noticeRef}
      className="info-banner usage-project-scan-failed-banner usage-scan-recovery"
      role="alert"
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        const target = event.relatedTarget;
        if (!(target instanceof Node) || !noticeRef.current?.contains(target)) hadFocus.current = false;
      }}
    >
      <Icon name="warning" size={14} tone="red" className="info-banner-icon" />
      <span>
        <strong>This saved scan cannot continue</strong>. {REPLAN_REQUIRED_COPY}
      </span>
      <span aria-busy={busy || undefined}>
        <Button
          variant="soft"
          disabled={busy}
          disabledReason="A new scan is already running."
          className={busy ? "is-loading" : undefined}
          leading={busy ? <Spinner size={13} color="currentColor" /> : undefined}
          onClick={startNewScan}
        >
          Start new scan
        </Button>
      </span>
    </div>
  );
}
