import { useEffect, useState } from "react";
import { useAppStore } from "@/store";

/** Wait this long before showing the indicator, so instant reads never flicker. */
const DEBOUNCE_MS = 300;
/** After this long the indicator gains a calm "still working" hint. */
const LONG_MS = 5000;

export interface GlobalBusy {
  /** True once ANY command has been in flight for > `DEBOUNCE_MS`. */
  busy: boolean;
  /** True once the in-flight work has been pending for > `LONG_MS`. */
  longRunning: boolean;
}

/** Debounced read of the store's global in-flight counter. Instant commands
 *  (resolve inside the debounce window) never flip `busy`, so the StatusBar
 *  doesn't flicker on every quick read. */
export function useGlobalBusy(): GlobalBusy {
  const active = useAppStore((s) => s.inFlight > 0);
  const [busy, setBusy] = useState(false);
  const [longRunning, setLongRunning] = useState(false);

  useEffect(() => {
    if (!active) {
      setBusy(false);
      setLongRunning(false);
      return;
    }
    const showT = setTimeout(() => setBusy(true), DEBOUNCE_MS);
    const longT = setTimeout(() => setLongRunning(true), LONG_MS);
    return () => {
      clearTimeout(showT);
      clearTimeout(longT);
    };
  }, [active]);

  return { busy, longRunning };
}

/** Subtle StatusBar segment shown while global IPC work is pending and no
 *  richer named process is running. Uses the status-chip grammar — a neutral
 *  pulsing dot (motion + fill, never a new hue). */
export function StatusBarBusy({ longRunning }: { longRunning: boolean }) {
  return (
    <span
      className="status-segment ipc-busy"
      role="status"
      aria-live="polite"
      title="Working…"
    >
      <span className="sync-dot" data-state="syncing" />
      <span className="ipc-busy-label">
        working…
        {longRunning && (
          <span className="text-dim"> still working — this can take a while</span>
        )}
      </span>
    </span>
  );
}
