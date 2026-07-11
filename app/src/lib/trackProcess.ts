import { Processes, type StartProcessInput } from "@/store/processes";

interface TrackOptions<T> {
  /** Final body line on success. */
  successBody?: string | ((result: T) => string);
  /** Retry handler shown on the error card. */
  retry?: () => void;
}

/** Wraps an async operation in a process card. Stays indeterminate for the
 *  duration (we don't fabricate progress for ops the backend can't report on),
 *  flips to success/error on settle. Returns the operation's result so callers
 *  can keep their own post-processing. Rethrows so existing catch blocks run. */
export async function trackProcess<T>(
  input: StartProcessInput,
  fn: () => Promise<T>,
  opts: TrackOptions<T> = {},
): Promise<T> {
  const id = Processes.start({ indeterminate: true, ...input });
  try {
    const result = await fn();
    const body =
      typeof opts.successBody === "function"
        ? opts.successBody(result)
        : opts.successBody;
    Processes.succeed(id, body);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Processes.fail(id, message, { retry: opts.retry });
    throw err;
  }
}
