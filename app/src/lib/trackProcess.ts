import { Processes, type ProcessPatch, type StartProcessInput } from "@/store/processes";
import { errorDetail } from "./cliOutput";

/**
 * Handle a tracked operation can use to report its own progress. Without it
 * the card stays indeterminate for the whole call — `ctl.update({ step, body })`
 * is how a multi-step op advances the card's `step`/`steps` counter and swaps
 * its breadcrumb `body` honestly as it moves through its phases. Forwards
 * straight to `Processes.update(id, patch)`.
 */
export interface TrackControl {
  update: (patch: ProcessPatch) => void;
}

interface TrackOptions<T> {
  /** Final body line on success. */
  successBody?: string | ((result: T) => string);
  /** Retry handler shown on the error card. */
  retry?: () => void;
  /**
   * Classify a RESOLVED result as a failure. Some commands report a soft
   * failure in their payload rather than by exiting non-zero (a backup whose
   * push was refused, say). Return the one-line headline to fail the card with,
   * or `null` to let it succeed. The promise still resolves either way — this
   * only decides what the banner says, never what the caller receives.
   */
  failWhen?: (result: T) => string | null;
}

/** Wraps an async operation in a process card. Stays indeterminate for the
 *  duration (we don't fabricate progress for ops the backend can't report on),
 *  flips to success/error on settle. Returns the operation's result so callers
 *  can keep their own post-processing. Rethrows so existing catch blocks run. */
export async function trackProcess<T>(
  input: StartProcessInput,
  fn: (ctl: TrackControl) => Promise<T>,
  opts: TrackOptions<T> = {},
): Promise<T> {
  const id = Processes.start({ indeterminate: true, ...input });
  const ctl: TrackControl = { update: (patch) => Processes.update(id, patch) };
  try {
    const result = await fn(ctl);
    const softFailure = opts.failWhen?.(result) ?? null;
    if (softFailure) {
      Processes.fail(id, softFailure, { retry: opts.retry });
      return result;
    }
    const body =
      typeof opts.successBody === "function"
        ? opts.successBody(result)
        : opts.successBody;
    Processes.succeed(id, body);
    return result;
  } catch (err) {
    // Split the failure: the headline answers "what broke" on the card face,
    // the full ANSI-stripped output goes to the log. Errors that carry no
    // command output contribute no log lines, so the card shows no log chrome.
    const { headline, logLines } = errorDetail(err);
    Processes.fail(id, headline, { retry: opts.retry, log: logLines });
    throw err;
  }
}
