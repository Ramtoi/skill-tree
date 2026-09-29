import { invoke } from "@/lib/ipc";
import { cliOutputLines, errorHeadline, type CliStreams } from "./cliOutput";

/** Shape returned by the Rust `hub_cmd` command. `output` is the legacy
 *  stdout+stderr concatenation every JSON-parsing call site still reads;
 *  `stdout`/`stderr` are the same bytes kept apart so failure surfaces can tell
 *  a stdout warning from the stderr error. Both are optional so older mocks
 *  (and any caller that only fills `output`) keep working. */
export interface HubResult extends CliStreams {
  success: boolean;
  output: string;
}

/** Split streams for a result, falling back to `output` when the bridge did not
 *  provide them (test doubles, legacy payloads). */
export function hubStreams(result: HubResult): { stdout: string; stderr: string } {
  const hasSplit = result.stdout != null || result.stderr != null;
  return {
    stdout: hasSplit ? result.stdout ?? "" : result.output ?? "",
    stderr: hasSplit ? result.stderr ?? "" : "",
  };
}

/**
 * A non-zero `hub.py` exit, carried as a JS error that already knows how to
 * present itself: `headline` is the one legible "what failed" line and
 * `logLines` is the full ANSI-stripped output for a log surface. `trackProcess`
 * reads both via `errorDetail`; plain `catch` blocks still get a sane
 * `.message`.
 */
export class HubCommandError extends Error {
  readonly headline: string;
  readonly logLines: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly args: string[];

  constructor(result: HubResult, args: string[] = []) {
    const streams = hubStreams(result);
    // A silent non-zero exit must not be mistaken for a line the command
    // actually printed (`hub sync` reads as a headline; "hub sync exited
    // non-zero (no output)" reads as the diagnosis it is). Naming the command
    // also tells the user exactly what to re-run in a terminal.
    const command = args.length > 0 ? `hub ${args.join(" ")}` : null;
    const headline = errorHeadline(
      streams,
      command
        ? `${command} exited non-zero (no output)`
        : "Command exited non-zero (no output)",
    );
    super(headline);
    this.name = "HubCommandError";
    this.headline = headline;
    this.logLines = cliOutputLines(streams);
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.args = args;
  }
}

/**
 * Run `hub <args>` and hand back the full result, non-zero exit included.
 *
 * The ONE place the frontend spawns a hub command. Callers that must inspect a
 * failure themselves — `runRegistryWrite` reads the JSON payload a failing
 * write still prints — use this; everything else uses `runHubCmd`. Going
 * through here (rather than `invoke` with a narrow `{success, output}` type) is
 * what keeps the stdout/stderr split available to the error surface.
 */
export async function hubCmd(args: string[]): Promise<HubResult> {
  return invoke<HubResult>("hub_cmd", { args });
}

/** Run `hub <args>` and throw a `HubCommandError` on a non-zero exit. Use this
 *  wherever a failure just has to be shown to a human. */
export async function runHubCmd(args: string[]): Promise<HubResult> {
  const result = await hubCmd(args);
  if (!result.success) throw new HubCommandError(result, args);
  return result;
}
