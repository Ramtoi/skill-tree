import { describe, it, expect } from "vitest";
import {
  cliLines,
  cliOutputLines,
  errorDetail,
  errorHeadline,
  stripAnsi,
} from "@/lib/cliOutput";
import { HubCommandError } from "@/lib/hubCmd";

// Built from char codes so the control bytes survive any source transform —
// same construction the mock's failing-sync fixture uses.
const E = String.fromCharCode(27);
const YEL = `${E}[33m`;
const RED = `${E}[31m`;
const BOLD = `${E}[1m`;
const OFF = `${E}[0m`;

/** Verbatim bytes of the real failure that motivated this work: coloured
 *  advisory warnings on stdout, the actual error block on stderr. */
const SYNC_STDOUT = [
  `${YEL}!${OFF} design-an-interface: missing SKILL.md at ~/.skill-hub/skills/design-an-interface/SKILL.md`,
  `${YEL}!${OFF} legacy-notes: missing SKILL.md at ~/.skill-hub/skills/legacy-notes/SKILL.md`,
  "",
].join("\n");

const SYNC_STDERR = [
  `${BOLD}${RED}Skill registry validation failed:${OFF}`,
  "  - qa-2: frontmatter name is 'qa' in ~/.skill-hub/skills/qa-2/SKILL.md; must match registry key to avoid collisions",
  "  - duplicate skill name 'qa' declared by both 'qa' and 'qa-2'",
  "",
  "Fix the duplicate/mismatched skill definitions in ~/.skill-hub before running sync.",
  "",
].join("\n");

const GRN = `${E}[32m`;

/** `hub.py`'s DOMINANT failure shape: `fail()` prints to stdout (222 call
 *  sites) and every `cmd_sync` line — banner, per-project ticks, advisories,
 *  and the terminal "✗ sync completed with danger findings" — is stdout with
 *  stderr EMPTY. Reading this top-down headlines the banner. */
const SYNC_STDOUT_ONLY = [
  `${BOLD}Syncing registry → agent folders${OFF}`,
  "",
  `  ${GRN}✓${OFF} example-app: 6 skills → .claude/skills`,
  `  ${GRN}✓${OFF} moon-base: 3 skills → .agents/skills`,
  `  ${YEL}!${OFF} moon-base: 'qa' reaches no installed harness — skipped`,
  "",
  `${BOLD}Permissions${OFF}`,
  `  ${GRN}✓${OFF} global → ~/.claude/settings.json`,
  `  ${RED}danger${OFF} example-app: Bash(rm -rf:*) allowed without confirmation`,
  "",
  `${BOLD}${RED}✗ sync completed with danger findings${OFF}`,
  "",
].join("\n");

/** `cmd_enable` prints its green tick BEFORE calling `_auto_sync()` (hub.py
 *  7292 → 7294), so a failing auto-sync leaves stdout OPENING with a success
 *  line. This is the case that made the old logic report "✓ enabled …" as the
 *  error the user must act on. */
const ENABLE_STDOUT_ONLY = [
  `${GRN}✓${OFF} enabled 'design-an-interface' for 'example-app'.`,
  `${BOLD}Syncing registry → agent folders${OFF}`,
  `  ${YEL}!${OFF} example-app: legacy-notes has no SKILL.md — skipped`,
  "no such project: 'ghost-app' referenced by bundle 'android'",
  "",
].join("\n");

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi(`${YEL}!${OFF} warning`)).toBe("! warning");
    expect(stripAnsi(`${BOLD}${RED}boom${OFF}`)).toBe("boom");
  });

  it("removes OSC sequences", () => {
    const BELCH = String.fromCharCode(7);
    expect(stripAnsi(`${E}]0;title${BELCH}hello`)).toBe("hello");
  });

  it("does not swallow the text between two OSC-8 hyperlinks", () => {
    const BELCH = String.fromCharCode(7);
    const link = (url: string, label: string) =>
      `${E}]8;;${url}${BELCH}${label}${E}]8;;${BELCH}`;
    // A greedy OSC body would eat everything from the first ESC] to the LAST
    // BEL, deleting "keep me" along with both links' labels.
    expect(stripAnsi(`${link("http://a", "A")} keep me ${link("http://b", "B")}`)).toBe(
      "A keep me B",
    );
  });

  it("is a no-op on clean text", () => {
    expect(stripAnsi("plain [33m not-an-escape")).toBe(
      "plain [33m not-an-escape",
    );
  });

  it("leaves no escape byte behind on real hub output", () => {
    expect(stripAnsi(SYNC_STDOUT + SYNC_STDERR)).not.toContain(E);
  });
});

describe("cliLines", () => {
  it("strips ANSI, drops blank lines, keeps order and indentation", () => {
    expect(cliLines(SYNC_STDERR)).toEqual([
      "Skill registry validation failed:",
      "  - qa-2: frontmatter name is 'qa' in ~/.skill-hub/skills/qa-2/SKILL.md; must match registry key to avoid collisions",
      "  - duplicate skill name 'qa' declared by both 'qa' and 'qa-2'",
      "Fix the duplicate/mismatched skill definitions in ~/.skill-hub before running sync.",
    ]);
  });

  it("returns an empty array for empty/whitespace/nullish input", () => {
    expect(cliLines("")).toEqual([]);
    expect(cliLines("   \n\n  \n")).toEqual([]);
    expect(cliLines(undefined)).toEqual([]);
    expect(cliLines(null)).toEqual([]);
  });

  it("handles CRLF", () => {
    expect(cliLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("cliOutputLines", () => {
  it("concatenates stdout then stderr in order", () => {
    const lines = cliOutputLines({ stdout: SYNC_STDOUT, stderr: SYNC_STDERR });
    expect(lines[0]).toBe(
      "! design-an-interface: missing SKILL.md at ~/.skill-hub/skills/design-an-interface/SKILL.md",
    );
    expect(lines[2]).toBe("Skill registry validation failed:");
    expect(lines).toHaveLength(6);
  });

  it("is empty when neither stream produced anything", () => {
    expect(cliOutputLines({ stdout: "", stderr: "" })).toEqual([]);
  });
});

describe("errorHeadline", () => {
  it("headlines the stderr ERROR, not the leading stdout warning", () => {
    const headline = errorHeadline({
      stdout: SYNC_STDOUT,
      stderr: SYNC_STDERR,
    });
    expect(headline).toContain("Skill registry validation failed:");
    expect(headline).toContain("qa-2");
    expect(headline).not.toContain("design-an-interface");
  });

  it("carries no ANSI escapes", () => {
    const headline = errorHeadline({
      stdout: SYNC_STDOUT,
      stderr: SYNC_STDERR,
    });
    expect(headline).not.toContain(E);
    expect(headline).not.toContain("[33m");
  });

  it("folds the first detail line into a bare header and unbullets it", () => {
    expect(
      errorHeadline({ stderr: "Validation failed:\n  - alpha broke\n  - beta" }),
    ).toBe("Validation failed: alpha broke");
  });

  it("keeps a self-contained stderr line as-is", () => {
    expect(errorHeadline({ stderr: "project 'ghost' is not registered" })).toBe(
      "project 'ghost' is not registered",
    );
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(errorHeadline({ stdout: "no such bundle: nope", stderr: "" })).toBe(
      "no such bundle: nope",
    );
  });

  it("reads a Python traceback bottom-up for the exception", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "/hub/hub.py", line 12, in <module>',
      "    main()",
      "KeyError: 'projects'",
    ].join("\n");
    expect(errorHeadline({ stderr: tb })).toBe("KeyError: 'projects'");
  });

  it("finds a traceback behind leading stderr advisories", () => {
    // hub.py writes `!` warnings to stderr too (2185, 2410), and Python emits
    // its own warnings there — so the banner is NOT always line 0.
    const out = [
      `${YEL}!${OFF} source 'starter': enabled must be true or false — treating as enabled`,
      "/hub/hub.py:12: DeprecationWarning: SKILL_HUB_DIR is deprecated",
      "Traceback (most recent call last):",
      '  File "/hub/hub.py", line 88, in cmd_sync',
      "    resolve()",
      "RuntimeError: registry lock is held by pid 4242",
    ].join("\n");
    expect(errorHeadline({ stderr: out })).toBe(
      "RuntimeError: registry lock is held by pid 4242",
    );
  });

  it("takes the LAST traceback when an earlier one was handled and logged", () => {
    const out = [
      "Traceback (most recent call last):",
      '  File "/hub/hub.py", line 10, in probe',
      "FileNotFoundError: codex",
      "! probe failed, continuing",
      "Traceback (most recent call last):",
      '  File "/hub/hub.py", line 90, in cmd_sync',
      "PermissionError: [Errno 13] ~/.claude/settings.json",
    ].join("\n");
    expect(errorHeadline({ stderr: out })).toBe(
      "PermissionError: [Errno 13] ~/.claude/settings.json",
    );
  });

  // ── stdout-only failures: hub.py's dominant shape ──────────────────────────
  it("headlines the ✗ tick of a stdout-only sync failure, not the banner", () => {
    expect(errorHeadline({ stdout: SYNC_STDOUT_ONLY, stderr: "" })).toBe(
      "✗ sync completed with danger findings",
    );
  });

  it("never reports a green ✓ success tick as the error", () => {
    const headline = errorHeadline({ stdout: ENABLE_STDOUT_ONLY, stderr: "" });
    expect(headline).not.toContain("✓");
    expect(headline).not.toContain("enabled 'design-an-interface'");
    expect(headline).toBe(
      "no such project: 'ghost-app' referenced by bundle 'android'",
    );
  });

  it("skips ! advisories when picking from stdout", () => {
    const out = [
      "! legacy-notes: missing SKILL.md — skipped",
      "no such bundle: nope",
      "! another advisory",
    ].join("\n");
    expect(errorHeadline({ stdout: out })).toBe("no such bundle: nope");
  });

  it("falls back to the last line when stdout has no marker at all", () => {
    // `fail()` messages are plain prints; the actionable line is the last one.
    const out = ["Resolving projects…", "project 'ghost' is not registered"].join(
      "\n",
    );
    expect(errorHeadline({ stdout: out })).toBe(
      "project 'ghost' is not registered",
    );
  });

  it("echoes something rather than nothing when stdout is all success ticks", () => {
    const out = ["✓ enabled 'a' for 'b'.", "✓ synced"].join("\n");
    expect(errorHeadline({ stdout: out }, "fallback")).toBe("✓ synced");
  });

  it("truncates within the cap, on a word boundary, with an ellipsis", () => {
    const long = `boom ${"detail ".repeat(60)}`;
    const headline = errorHeadline({ stderr: long }, "Command failed", 40);
    // The cap is a real cap — the ellipsis is INCLUDED, not appended past it.
    expect(headline.length).toBeLessThanOrEqual(40);
    expect(headline.endsWith("…")).toBe(true);
  });

  it("still caps a single unbroken token", () => {
    const headline = errorHeadline({ stderr: "x".repeat(500) }, "f", 20);
    expect(headline.length).toBeLessThanOrEqual(20);
  });

  it("uses the fallback when both streams are silent", () => {
    expect(
      errorHeadline({ stdout: "", stderr: "" }, "hub sync exited non-zero"),
    ).toBe("hub sync exited non-zero");
  });
});

describe("errorDetail", () => {
  it("splits a HubCommandError into headline + full log", () => {
    const err = new HubCommandError(
      {
        success: false,
        output: SYNC_STDOUT + SYNC_STDERR,
        stdout: SYNC_STDOUT,
        stderr: SYNC_STDERR,
      },
      ["sync"],
    );
    const { headline, logLines } = errorDetail(err);
    expect(headline).toContain("Skill registry validation failed:");
    // The log keeps EVERYTHING, warnings included — that's the point of a log.
    expect(logLines).toHaveLength(6);
    expect(logLines[0]).toContain("design-an-interface");
    expect(logLines.join("\n")).not.toContain(E);
  });

  it("degrades a plain Error to its message with no log lines", () => {
    expect(errorDetail(new Error("bridge died"))).toEqual({
      headline: "bridge died",
      logLines: [],
    });
  });

  it("strips ANSI from a plain Error message too", () => {
    expect(errorDetail(new Error(`${RED}nope${OFF}`)).headline).toBe("nope");
  });

  it("degrades a non-Error throw", () => {
    expect(errorDetail("just a string")).toEqual({
      headline: "just a string",
      logLines: [],
    });
  });
});

describe("HubCommandError", () => {
  it("uses the headline as its message so plain catch blocks read well", () => {
    const err = new HubCommandError(
      { success: false, output: "", stdout: "", stderr: "boom: bad thing" },
      ["sync"],
    );
    expect(err.message).toBe("boom: bad thing");
    expect(String(err)).toContain("boom: bad thing");
  });

  it("falls back to the legacy `output` when the bridge sent no split streams", () => {
    const err = new HubCommandError(
      { success: false, output: "legacy only failure" },
      ["enable", "x"],
    );
    expect(err.headline).toBe("legacy only failure");
    expect(err.logLines).toEqual(["legacy only failure"]);
  });

  it("says a silent non-zero exit was silent, and names the command", () => {
    const err = new HubCommandError(
      { success: false, output: "", stdout: "", stderr: "" },
      ["sync"],
    );
    // Must not read like a line the command printed (the bare "hub sync" it
    // used to show was indistinguishable from real output).
    expect(err.headline).toBe("hub sync exited non-zero (no output)");
    expect(err.logLines).toEqual([]);
  });

  it("still says so when even the argv is unknown", () => {
    const err = new HubCommandError({
      success: false,
      output: "",
      stdout: "",
      stderr: "",
    });
    expect(err.headline).toBe("Command exited non-zero (no output)");
  });

  it("headlines the ✗ tick for a stdout-only failure end to end", () => {
    const err = new HubCommandError(
      {
        success: false,
        output: SYNC_STDOUT_ONLY,
        stdout: SYNC_STDOUT_ONLY,
        stderr: "",
      },
      ["sync"],
    );
    expect(err.headline).toBe("✗ sync completed with danger findings");
    // The whole narration is still available in the log, ANSI-free.
    expect(err.logLines).toContain("Syncing registry → agent folders");
    expect(err.logLines.join("\n")).not.toContain(E);
  });
});

describe("errorDetail — malformed carriers", () => {
  it("filters non-string entries out of a hand-rolled logLines carrier", () => {
    const carrier = Object.assign(new Error("boom"), {
      headline: "boom",
      logLines: ["good", 42, null, undefined, { a: 1 }, "also good"],
    });
    expect(errorDetail(carrier)).toEqual({
      headline: "boom",
      logLines: ["good", "also good"],
    });
  });

  it("ignores a carrier whose logLines is not an array", () => {
    const carrier = Object.assign(new Error("boom"), {
      headline: "nope",
      logLines: "not an array",
    });
    expect(errorDetail(carrier)).toEqual({ headline: "boom", logLines: [] });
  });

  it("ignores a carrier whose headline is not a string", () => {
    const carrier = Object.assign(new Error("boom"), {
      headline: 42,
      logLines: ["a"],
    });
    expect(errorDetail(carrier)).toEqual({ headline: "boom", logLines: [] });
  });

  it("survives null and undefined throws", () => {
    expect(errorDetail(null).headline).toBe("null");
    expect(errorDetail(undefined).headline).toBe("undefined");
  });
});
