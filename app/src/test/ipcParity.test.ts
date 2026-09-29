import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ─── Frontend ↔ Rust ↔ mock command parity ────────────────────────────────
//
// A source-scan test (node `fs` reads, no rendering — same style as
// `ipcImportGuard.test.ts`) that pins the shape of the Tauri command surface
// across three independent sources of truth that otherwise drift silently:
//
//   R = every `#[tauri::command]` fn in the Rust backend
//   H = every name registered in `tauri::generate_handler![...]`
//   F = every command name the frontend actually calls (via `invoke`)
//   M = every command name the visual/e2e mock (`tauriCore.ts` + `tauriSubagents.ts`) can answer
//
// Invariants:
//   H == R           — every command fn is registered, every registration
//                       points at a real fn (a stale/misspelled entry either
//                       way fails to build, but this catches it in ~10ms).
//   F ⊆ R             — the frontend never calls a command that doesn't exist.
//   F ⊆ M             — every command the frontend actually calls has a mock
//                       arm, so no e2e journey / visual scene / component test
//                       silently renders against `undefined`.
//   R \ F ⊆ KNOWN_UNWIRED — anything with no live frontend caller must be an
//                       explicit, reasoned allowlist entry, not silence.
//   R \ T ⊆ KNOWN_UNTESTED ∪ KNOWN_UNWIRED — a command no vitest test file
//                       names by its literal string must be an explicit,
//                       reasoned allowlist entry too (an unwired command is
//                       untested for the same reason it is unwired).
//   F ⊆ S             — every command the frontend calls has a `case` arm
//                       (or the shared default) in `src/test/setup.ts`.
//                       This proves an arm is PRESENT, not that it returns
//                       a meaningful shape: many arms deliberately fall
//                       through to the same `undefined` the default branch
//                       already returns (a component test that starts to
//                       care about one moves it to its own case).
//   union ⊆ R, and each dispatch-union member is dispatched at its declared
//                       call site — a `runHub`-style wrapper's literal union
//                       type actually matches live commands, and the file
//                       that claims to dispatch them really does.

const APP_ROOT = process.cwd(); // vitest runs from `app/`
const SRC = join(APP_ROOT, "src");
const COMMANDS_DIR = join(APP_ROOT, "src-tauri", "src", "commands");
const LIB_RS = join(APP_ROOT, "src-tauri", "src", "lib.rs");
// Scan the dispatcher and each delegated mock module.
const MOCK_FILES = [
  join(SRC, "mocks", "tauriCore.ts"),
  join(SRC, "mocks", "tauriSubagents.ts"),
  join(SRC, "mocks", "tauriUsageAnalytics.ts"),
];

// ─── RUST: every `#[tauri::command]` fn ──────────────────────────────────────

const COMMAND_ATTR_RE = /^\s*#\[tauri::command\]\s*$/;
const FN_AFTER_ATTR_RE = /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/;

function scanRustCommands(): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(COMMANDS_DIR)) {
    if (!entry.endsWith(".rs")) continue;
    const lines = readFileSync(join(COMMANDS_DIR, entry), "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!COMMAND_ATTR_RE.test(lines[i])) continue;
      const m = FN_AFTER_ATTR_RE.exec(lines[i + 1] ?? "");
      if (m) names.add(m[1]);
    }
  }
  return names;
}

// ─── HANDLER: names registered in tauri::generate_handler![...] ─────────────

function scanHandlerRegistrations(): Set<string> {
  const content = readFileSync(LIB_RS, "utf-8");
  const block = /tauri::generate_handler!\[([\s\S]*?)\]/.exec(content);
  if (!block) throw new Error("Could not find tauri::generate_handler![...] in lib.rs");
  const names = new Set<string>();
  const re = /commands::\w+::([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]))) names.add(m[1]);
  return names;
}

// ─── FRONTEND: every string literal passed as the first arg of `invoke` ─────
//
// Excludes `src/test/**` (test assertions aren't live calls), `src/mocks/**`
// (the mock harness itself), and `lib/ipc.ts` (the wrapper's own doc comment
// contains a literal `invoke("cmd")` example that would otherwise be misread
// as a call to a command named "cmd").

const EXCLUDE_DIRS = new Set(["test", "mocks"]);
const EXCLUDE_FILES = new Set([join("lib", "ipc.ts")]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      out.push(...walkTsFiles(p));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      if (EXCLUDE_FILES.has(relative(SRC, p))) continue;
      out.push(p);
    }
  }
  return out;
}

// Plain literal first arg: invoke("name", …) / invoke<T>("name", …), allowing
// the string to sit on the next line (common with a wide generic return type)
// and generics to nest (e.g. `invoke<Record<string, unknown>>(...)`).
const INVOKE_LITERAL_RE = /\binvoke\b\s*(?:<[^(]*)?\(\s*(["'`])([A-Za-z0-9_]+)\1/g;

// A same-shaped ternary first arg: invoke(cond ? "a" : "b", …) — covers
// `useBackup.ts`'s `invoke(enabled ? "backup_enable" : "backup_disable")`.
const INVOKE_TERNARY_RE =
  /\binvoke\b\s*(?:<[^(]*)?\(\s*[A-Za-z0-9_.]+\s*\?\s*(["'`])([A-Za-z0-9_]+)\1\s*:\s*(["'`])([A-Za-z0-9_]+)\3/g;

function scanFrontendCalls(): Set<string> {
  const names = new Set<string>();
  for (const file of walkTsFiles(SRC)) {
    const content = readFileSync(file, "utf-8");
    let m: RegExpExecArray | null;
    INVOKE_LITERAL_RE.lastIndex = 0;
    while ((m = INVOKE_LITERAL_RE.exec(content))) names.add(m[2]);
    INVOKE_TERNARY_RE.lastIndex = 0;
    while ((m = INVOKE_TERNARY_RE.exec(content))) {
      names.add(m[2]);
      names.add(m[4]);
    }
  }
  return names;
}

// ─── MOCK: every `case "<name>":` in the mock files ───────────────────────────

const MOCK_CASE_RE = /^\s*case\s+(["'`])([A-Za-z0-9_]+)\1\s*:/gm;

function scanMockArms(): Set<string> {
  const names = new Set<string>();
  for (const file of MOCK_FILES) {
    const content = readFileSync(file, "utf-8");
    let m: RegExpExecArray | null;
    MOCK_CASE_RE.lastIndex = 0;
    while ((m = MOCK_CASE_RE.exec(content))) names.add(m[2]);
  }
  return names;
}

// ─── R \ F allowlist ──────────────────────────────────────────────────────
//
// Every Rust command with no live frontend caller MUST be listed here with a
// one-line reason. Anything unwired that isn't listed fails the test with a
// message telling you to add a caller, delete the command, or allowlist it.

const KNOWN_UNWIRED: Record<string, string> = {
  // Genuinely no caller anywhere in the frontend (confirmed via full-repo
  // grep, not just this scan) — CLI/backend-only today.
  permissions_migrate_scope: "no frontend caller; CLI-only (`hub permissions migrate-scope`)",
  // ImportMergeDialog moved onto the unified reconcile pair
  // (permissions-divergence-fixes); the legacy import commands stay for
  // CLI/back-compat but no frontend caller remains.
  permissions_import_apply: "superseded by permissions_reconcile_apply (ImportMergeDialog)",
  permissions_import_candidates: "superseded by permissions_reconcile_candidates (ImportMergeDialog)",
  read_skill_content: "no frontend caller; superseded by read_skill_document",
  write_skill_content: "no frontend caller; superseded by save_skill_full",
  check_python: "superseded by runtime_preflight; no live caller remains (only comments/legacy tests reference it)",
  remote_set_secret: "no frontend caller; secret management not yet wired into the Remotes UI",
  remote_has_secret: "no frontend caller; secret management not yet wired into the Remotes UI",
  remote_delete_secret: "no frontend caller; secret management not yet wired into the Remotes UI",
  // remote_clear / remote_disable / remote_enable / remote_import_skill /
  // remote_remove / remote_resolve used to sit here too: they are called
  // only through RemoteDetail.tsx's local `runHub(cmd, args, …)` helper,
  // whose `cmd` was a runtime `string`, not a literal passed directly to
  // `invoke`. Now that `runHub`'s `cmd` is typed `RemoteDetailCommand`
  // (`lib/remoteCommands.ts`), `scanDispatchUnions()` below folds that
  // union's literals into F directly, so these six have a real caller again
  // and belong back in R \ F's normal (empty) case, not this allowlist.
};

// ─── DISPATCH UNIONS: a `cmd: string` param narrowed to a literal union ────
//
// A wrapper like `RemoteDetail.tsx`'s `runHub(cmd: RemoteDetailCommand, …)`
// dispatches by a runtime variable, so `scanFrontendCalls()`'s literal-first-
// -arg regex cannot see any of its call sites. Each entry below names the lib
// file whose `export type … = "a" | "b" | …;` block enumerates that wrapper's
// live command set, and the call-site file where the wrapper itself lives.
// `scanDispatchUnions()` extracts the union's string literals and folds them
// into F; a later test checks each member is a real command AND is actually
// dispatched (as `fn`'s first argument, or a ternary branch of it) in the
// named call-site file, so a stale union member — one nobody dispatches any
// more — still fails loudly instead of quietly inflating F.

const DISPATCH_UNIONS: { file: string; callSite: string; fn: string }[] = [
  { file: "lib/remoteCommands.ts", callSite: "components/remotes/RemoteDetail.tsx", fn: "runHub" },
];

const UNION_LITERAL_RE = /(["'`])([A-Za-z0-9_]+)\1/g;

function scanDispatchUnions(): Set<string> {
  const names = new Set<string>();
  for (const { file } of DISPATCH_UNIONS) {
    const content = readFileSync(join(SRC, file), "utf-8");
    const block = /export type\s+\w+\s*=([\s\S]*?);/.exec(content);
    if (!block) throw new Error(`Could not find "export type … =" in ${file}`);
    let m: RegExpExecArray | null;
    UNION_LITERAL_RE.lastIndex = 0;
    while ((m = UNION_LITERAL_RE.exec(block[1]))) names.add(m[2]);
  }
  return names;
}

// ─── T: command names quoted anywhere in a vitest test file's own text ─────
//
// A deliberately rough, generous scan: any quoted `[A-Za-z0-9_]+` token in a
// `*.test.{ts,tsx}` file counts, whether or not that token names a live Tauri
// command, or names one this particular file actually exercises. The
// invariant below only reads R \ T — the real commands that never appear
// ANYWHERE in ANY test file's text — so a stray unrelated quoted token being
// swept into T costs nothing; it can only ever hide a command that some test
// happens to mention without testing (rare, and still caught by review).
// Excludes this file itself (ipcParity.test.ts's own command-name literals —
// KNOWN_UNWIRED's keys, the allowlists below — are not a test of behavior).

const IPC_PARITY_TEST_FILE = join(SRC, "test", "ipcParity.test.ts");
const QUOTED_TOKEN_RE = /(["'`])([A-Za-z0-9_]+)\1/g;

function walkTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walkTestFiles(p));
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function scanTestedCommandMentions(): Set<string> {
  const names = new Set<string>();
  for (const file of walkTestFiles(SRC)) {
    if (file === IPC_PARITY_TEST_FILE) continue;
    const content = readFileSync(file, "utf-8");
    let m: RegExpExecArray | null;
    QUOTED_TOKEN_RE.lastIndex = 0;
    while ((m = QUOTED_TOKEN_RE.exec(content))) names.add(m[2]);
  }
  return names;
}

// ─── S: every `case "x":` arm in the shared vitest `invoke` mock ──────────

function scanSetupArms(): Set<string> {
  const content = readFileSync(join(SRC, "test", "setup.ts"), "utf-8");
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  MOCK_CASE_RE.lastIndex = 0;
  while ((m = MOCK_CASE_RE.exec(content))) names.add(m[2]);
  return names;
}

// ─── R \ T allowlist ────────────────────────────────────────────────────────
//
// Every Rust command no vitest test file names (quoted) anywhere MUST be
// listed here (or in KNOWN_UNWIRED, for a command that is untested for the
// same reason it has no caller) with a one-line reason. Each of these has a
// live frontend caller and a mock arm — R \ F and F ⊆ M both hold — so this
// is specifically "wired but its literal command string appears in no vitest
// test", which usually means the button/flow that triggers it is untested,
// or is covered only at the journey layer.

const KNOWN_UNTESTED: Record<string, string> = {
  agent_docs_root_status: "AgentDocsView.test.tsx renders agent-docs tree fixtures directly; no test drives the root-status fetch that calls this command",
  backup_auth_login_pat: "BackupScreen.test.tsx asserts the auth-ladder UI from a pre-set auth fixture; no test drives the PAT login mutation that calls this command",
  backup_auth_logout: "BackupScreen.test.tsx asserts the auth-ladder UI from a pre-set auth fixture; no test drives the logout mutation that calls this command",
  permissions_disable: "DisableDialog has no dedicated vitest file, and GlobalPermissions's tests do not open it",
  pick_file: "SkillLibrary's local-skill file picker has no vitest test; covered at the journey layer by app/e2e/skill-share.journey.spec.ts",
  remote_equip: "EquipPicker's vitest tests exercise the local-skill equip path; no test drives a remote skill through the picker",
  save_file_dialog: "SkillEditorReadOnly asserts the Export button's presence and order, not a click that opens the save dialog",
};

describe("IPC command parity: frontend ↔ Rust ↔ mock", () => {
  const R = scanRustCommands();
  const H = scanHandlerRegistrations();
  const F = new Set([...scanFrontendCalls(), ...scanDispatchUnions()]);
  const M = scanMockArms();
  const T = scanTestedCommandMentions();
  const S = scanSetupArms();

  it("every #[tauri::command] fn is registered in generate_handler![...]", () => {
    const unregistered = [...R].filter((n) => !H.has(n)).sort();
    expect(unregistered, `commands defined but not registered: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("every generate_handler![...] entry points at a real #[tauri::command] fn", () => {
    const dangling = [...H].filter((n) => !R.has(n)).sort();
    expect(dangling, `registered but no matching fn: ${dangling.join(", ")}`).toEqual([]);
  });

  it("the frontend never calls a command that doesn't exist on the Rust side", () => {
    const bogus = [...F].filter((n) => !R.has(n)).sort();
    expect(bogus, `frontend calls with no matching Rust command: ${bogus.join(", ")}`).toEqual([]);
  });

  it("every command the frontend calls has a mock arm in the mock files", () => {
    const missing = [...F].filter((n) => !M.has(n)).sort();
    expect(
      missing,
      `frontend calls with no mock arm (e2e/visual/component tests would see ` +
        `\`undefined\`): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every command with no live frontend caller is an explicit, reasoned allowlist entry", () => {
    const dead = [...R].filter((n) => !F.has(n)).sort();
    const unexplained = dead.filter((n) => !(n in KNOWN_UNWIRED));
    expect(
      unexplained,
      `unwired command(s) not in KNOWN_UNWIRED: ${unexplained.join(", ")}. ` +
        `Add a frontend caller, delete the command, or allowlist it with a reason.`,
    ).toEqual([]);

    // Catch the allowlist going stale in the other direction too: an entry
    // that no longer applies (the command was wired up, or deleted) should be
    // removed rather than silently kept around.
    const staleAllowlist = Object.keys(KNOWN_UNWIRED).filter((n) => !dead.includes(n));
    expect(
      staleAllowlist,
      `KNOWN_UNWIRED entries that no longer apply (command now has a caller, ` +
        `or no longer exists): ${staleAllowlist.join(", ")}`,
    ).toEqual([]);
  });

  it("every Tauri command is named in a vitest test or is a reasoned KNOWN_UNTESTED entry", () => {
    const untested = [...R].filter((n) => !T.has(n)).sort();
    const unexplained = untested.filter((n) => !(n in KNOWN_UNTESTED) && !(n in KNOWN_UNWIRED));
    expect(
      unexplained,
      `command(s) no vitest test names, not in KNOWN_UNTESTED or KNOWN_UNWIRED: ` +
        `${unexplained.join(", ")}. Add a test that names the command, or allowlist it with a reason.`,
    ).toEqual([]);

    // Stale in either direction: an entry that IS now named in a test (or
    // whose command no longer exists) should be removed, not kept around.
    const staleUntested = Object.keys(KNOWN_UNTESTED).filter((n) => !untested.includes(n));
    expect(
      staleUntested,
      `KNOWN_UNTESTED entries that no longer apply (a test now names the ` +
        `command, or it no longer exists): ${staleUntested.join(", ")}`,
    ).toEqual([]);
  });

  it("every command the frontend calls has a case arm present in setup.ts (presence only, not a response shape)", () => {
    const missing = [...F].filter((n) => !S.has(n)).sort();
    expect(
      missing,
      `frontend calls with no case arm in src/test/setup.ts (add one, even a ` +
        `fall-through to \`return undefined;\`): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every dispatch-union member is a real command and is dispatched at its call site", () => {
    for (const { file, callSite, fn } of DISPATCH_UNIONS) {
      const content = readFileSync(join(SRC, file), "utf-8");
      const block = /export type\s+\w+\s*=([\s\S]*?);/.exec(content);
      if (!block) throw new Error(`Could not find "export type … =" in ${file}`);
      const members = new Set<string>();
      let m: RegExpExecArray | null;
      UNION_LITERAL_RE.lastIndex = 0;
      while ((m = UNION_LITERAL_RE.exec(block[1]))) members.add(m[2]);

      const unreal = [...members].filter((n) => !R.has(n)).sort();
      expect(unreal, `${file}: union member(s) with no matching Rust command: ${unreal.join(", ")}`).toEqual([]);

      const callSiteContent = readFileSync(join(SRC, callSite), "utf-8");
      const fnRe = new RegExp(`\\b${fn}\\s*\\(\\s*(["'\`])([A-Za-z0-9_]+)\\1`, "g");
      // The condition before `?` can be an arbitrary expression (e.g.
      // `c === "remove" ? "remote_remove" : "remote_clear"`), not just a bare
      // identifier, so match non-greedily up to the first `? "x" : "y"` shape
      // rather than constraining the condition's own character set.
      const ternaryRe = new RegExp(
        `\\b${fn}\\s*\\([\\s\\S]*?\\?\\s*(["'\`])([A-Za-z0-9_]+)\\1\\s*:\\s*(["'\`])([A-Za-z0-9_]+)\\3`,
        "g",
      );
      const dispatched = new Set<string>();
      let fm: RegExpExecArray | null;
      while ((fm = fnRe.exec(callSiteContent))) dispatched.add(fm[2]);
      while ((fm = ternaryRe.exec(callSiteContent))) {
        dispatched.add(fm[2]);
        dispatched.add(fm[4]);
      }

      const undispatched = [...members].filter((n) => !dispatched.has(n)).sort();
      expect(
        undispatched,
        `${file}: union member(s) never dispatched as ${fn}(...)'s first argument in ${callSite}: ` +
          `${undispatched.join(", ")}`,
      ).toEqual([]);
    }
  });
});
