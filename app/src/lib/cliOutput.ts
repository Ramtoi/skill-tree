// ─── CLI output normalisation ────────────────────────────────────────────────
// `hub.py` is a terminal program: it paints warnings/errors with ANSI colour
// codes, splits its own output across stdout (progress + warnings) and stderr
// (the actual failure), and assumes a scrollback buffer. The app has none of
// that, so every byte we surface has to be normalised here first.
//
// Two jobs:
//   1. `stripAnsi` / `cliLines` — turn raw bytes into readable, ordered lines.
//   2. `errorHeadline` — pick the ONE line that answers "what failed?" so a
//      failure card/toast is legible at a glance; the rest goes to the log.
//
// Used by `lib/hubCmd.ts` (which raises a `HubCommandError` carrying both) and
// by `lib/trackProcess.ts` (which splits it across a process card's body+log).

// Built from char codes rather than escape literals so the control bytes cannot
// be mangled by a source transform, and no `no-control-regex` suppression is
// needed.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** CSI (`ESC [ … final`) + OSC (`ESC ] … BEL|ST`) escape sequences. Covers the
 *  SGR colour codes `hub.py` emits — `ESC[33m`, `ESC[1m`, `ESC[0m` — plus the
 *  OSC title/hyperlink sequences some tools wrap their output in. */
// The OSC body is LAZY: a greedy `[^BEL]*` run would swallow everything between
// two OSC-8 hyperlinks, deleting the visible text that sits between them.
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`,
  "g",
);

/** Remove terminal colour/control sequences. Safe on already-clean text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** ANSI-stripped, trimmed, blank-dropped lines — the readable form of one
 *  stream's raw output. Returns `[]` for empty/whitespace-only input, which is
 *  what lets callers suppress log chrome entirely when there is nothing to show. */
export function cliLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "");
}

export interface CliStreams {
  stdout?: string | null;
  stderr?: string | null;
}

/** Both streams as one ordered, ANSI-stripped line list — stdout first, then
 *  stderr, mirroring how the process actually wrote them (we get the two
 *  buffers at exit, not interleaved, so this is the honest reconstruction). */
export function cliOutputLines({ stdout, stderr }: CliStreams): string[] {
  return [...cliLines(stdout), ...cliLines(stderr)];
}

/** Bullet/indent noise a CLI puts in front of detail lines. */
function unbullet(line: string): string {
  return line.trim().replace(/^[-*•]\s+/, "");
}

/** Result is at most `max` characters INCLUDING the ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Prefer a word boundary so the tail isn't cut mid-token. `max - 1` leaves
  // room for the ellipsis so the cap is a real cap.
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/\s+$/, "")}…`;
}

/** Lines that are NOT the failure: `!`/`⚠` advisories and `✓` success ticks.
 *  `hub.py` mixes all three into the same stream — `cmd_enable` prints its green
 *  "✓ enabled 'x' for 'y'." and only THEN runs the auto-sync that can fail, so
 *  a naive first-line (or even last-line) pick can headline a success. */
const NOISE_RE = /^(?:[!⚠]\s|[✓✔])/;

/** Explicit failure markers `hub.py` uses: the red `✗` tick (`✗ sync completed
 *  with danger findings`) and conventional `error:` / `fatal:` prefixes. */
const ERROR_MARK_RE = /^(?:[✗✖×]|error:|fatal:)/i;

const TRACEBACK_RE = /^Traceback \(most recent call last\)/;

/** Index of the line that best answers "what failed", or -1. `bottomUp` picks
 *  the LAST candidate (a stream that narrates forward, so the failure is at the
 *  end); otherwise the FIRST (a purpose-written error block, whose header leads). */
function pickFailureIndex(lines: string[], bottomUp: boolean): number {
  const candidates = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !NOISE_RE.test(line.trim()));
  // An explicitly marked failure wins over position in EITHER direction, and the
  // last one wins — later failures supersede earlier ones.
  const marked = candidates.filter(({ line }) => ERROR_MARK_RE.test(line.trim()));
  if (marked.length > 0) return marked[marked.length - 1].i;
  if (candidates.length > 0) {
    return bottomUp ? candidates[candidates.length - 1].i : candidates[0].i;
  }
  // Everything was noise — better to echo something than to say nothing.
  return lines.length > 0 ? (bottomUp ? lines.length - 1 : 0) : -1;
}

/**
 * The one line that says WHAT failed.
 *
 * Stream choice: stderr wins when it has content (it is a purpose-written error
 * channel), otherwise stdout. But stdout is NOT a fallback for exotic cases —
 * it is `hub.py`'s dominant failure channel: `fail()` prints to stdout (222
 * call sites) and every `cmd_sync` line, including the terminal
 * "✗ sync completed with danger findings", is stdout with stderr empty.
 *
 *  - stdout is read BOTTOM-UP: it narrates forward, so the failure is at the
 *    end. Reading it top-down headlined `hub enable`'s green success tick when
 *    the auto-sync behind it failed.
 *  - stderr is read TOP-DOWN: its first line is the error header.
 *  - Advisory (`!`) and success (`✓`) lines are never chosen in either mode.
 *  - Python tracebacks read bottom-up from the LAST `Traceback` banner — hub.py
 *    also writes `!` advisories to stderr, so the banner is not always line 0.
 *  - A header ending in `:` ("Skill registry validation failed:") is meaningless
 *    alone, so the next line is folded in after it.
 *  - The result is ANSI-stripped and truncated; the full output lives in the log.
 */
export function errorHeadline(
  streams: CliStreams,
  fallback = "Command failed",
  maxLength = 160,
): string {
  const err = cliLines(streams.stderr);
  const out = cliLines(streams.stdout);
  const fromStderr = err.length > 0;
  const lines = fromStderr ? err : out;
  if (lines.length === 0) return fallback;

  // Tracebacks: the exception on the final line is the answer, not the banner —
  // and the banner can sit anywhere, behind advisories or an earlier traceback.
  let tb = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TRACEBACK_RE.test(lines[i])) {
      tb = i;
      break;
    }
  }
  if (tb >= 0 && tb < lines.length - 1) {
    return truncate(unbullet(lines[lines.length - 1]), maxLength) || fallback;
  }

  const idx = pickFailureIndex(lines, !fromStderr);
  if (idx < 0) return fallback;

  let headline = unbullet(lines[idx]);
  const next = lines[idx + 1];
  if (headline.endsWith(":") && next !== undefined && !NOISE_RE.test(next.trim())) {
    headline = `${headline} ${unbullet(next)}`;
  }
  return truncate(headline, maxLength) || fallback;
}

/** What a failure contributes to a process card: one legible body line plus the
 *  full output for the log. Errors that carry no CLI output (a thrown JS error,
 *  a rejected IPC call) degrade to their message with an empty log — which the
 *  card reads as "render no log chrome". */
export interface ErrorDetail {
  headline: string;
  logLines: string[];
}

interface DetailCarrier {
  headline?: unknown;
  logLines?: unknown;
}

export function errorDetail(err: unknown): ErrorDetail {
  const carrier = err as DetailCarrier | null;
  if (
    carrier &&
    typeof carrier.headline === "string" &&
    Array.isArray(carrier.logLines)
  ) {
    return {
      headline: carrier.headline,
      logLines: carrier.logLines.filter(
        (l): l is string => typeof l === "string",
      ),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { headline: stripAnsi(message), logLines: [] };
}
