import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { invoke } from "@/mocks/tauriCore";
import { SCENE_FLAGS, KNOWN_NO_FIDELITY_ROW, type SceneFlagName } from "@/mocks/scenes";

// ─── Table-driven scene-flag fidelity ──────────────────────────────────────
//
// For every declared flag in `SCENE_FLAGS` (and every value of an enumerated
// flag), a row drives the REAL mock dispatch (`invoke`, the same bridge the
// app and every journey use) once without the flag and once with it, and
// proves the response actually differs — or, for a `hang` row, that the
// promise does not settle within a short race, or for a `fail` row, that the
// call rejects or reports failure. A declared flag with neither a row here
// nor a `KNOWN_NO_FIDELITY_ROW` reason fails at the bottom of this file.
// (`KNOWN_UNUSED`, the sibling map in `scenes.ts`, excuses
// `sceneRegistry.test.ts` rule 2 instead — it does NOT excuse a row here;
// every one of its seventeen flags has a real row below.)
//
// Wall-clock time is FROZEN for every test in this file (`beforeEach`
// below fakes `Date` only — `setTimeout` stays real, so `hang` races and
// the mocks' own delays still run). Several mocks stamp a response with
// `new Date().toISOString()` (e.g. `invocationMock`'s `observed_at`), so
// with a live clock a baseline and a flagged call made a millisecond apart
// would differ on the timestamp alone, and a `diff` row would pass even if
// the flag did nothing. A frozen clock means a timestamp can never be the
// only difference.
//
// A `diff`-mode row needs a baseline (unflagged) call and a flagged call to
// disagree FOR THE RIGHT REASON. If the command being called mutates shared
// mock state (archives/renames/deletes something, writes a setting), the
// baseline call can itself change what the flagged call sees, so the two
// responses differ even if the flag does nothing at all — a false-negative
// proof. Every row below either calls a read-only command, calls a
// mutating command in `fail`/`hang` mode (no baseline needed), or sets
// `fresh: true` (`syncFails`, `docLinkConflict`, `invocationPartial`,
// `enableFails`, `worktreeAccessFails`, `machineConflict`) so baseline and flagged each get
// their own `freshTauriCore()` instance and never share mutated state.
//
// The five existing `*MockFidelity.test.ts`/`usageAnalyticsFidelity.test.ts`
// files never set a scene flag — this file is the first to drive
// `window.location.search` itself, through `setSearch`/`afterEach` below.

const ORIGIN = "http://localhost/";

function setSearch(qs: string): void {
  const url = new URL(ORIGIN);
  url.search = qs;
  url.hash = window.location.hash || "#/";
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

const FROZEN_NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  setSearch("");
  vi.useRealTimers();
});

/** Races `p` against a short timer; resolves `"settled"` or `"pending"`. */
async function raceSettled(p: Promise<unknown>, ms = 40): Promise<"settled" | "pending"> {
  const sentinel = Symbol("pending");
  const result = await Promise.race([
    p.then(() => "settled" as const, () => "settled" as const),
    new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), ms)),
  ]);
  return result === sentinel ? "pending" : "settled";
}

async function ranToFailure(p: Promise<unknown>): Promise<boolean> {
  try {
    const r = await p;
    if (r && typeof r === "object") {
      const obj = r as Record<string, unknown>;
      if (obj.success === false) return true;
      if (obj.ok === false) return true;
      if (typeof obj.output === "string") {
        try {
          const parsed = JSON.parse(obj.output) as Record<string, unknown>;
          if (parsed.ok === false || parsed.success === false) return true;
        } catch {
          /* not JSON — success:true string output is not itself a failure */
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

type Row =
  // `fresh: true` — the command mutates shared mock state (a registry
  // write, a stored flag). The baseline and flagged calls each get their
  // OWN `freshTauriCore()` instance, so neither call's mutation can be
  // what the other call's response differs by.
  | { flag: SceneFlagName; value?: string; mode?: "diff"; call: Call; fresh?: boolean }
  | { flag: SceneFlagName; value?: string; mode: "hang"; call: Call; raceMs?: number }
  | { flag: SceneFlagName; value?: string; mode: "fail"; call: Call };

// ── shell / sync ────────────────────────────────────────────────────────
const SYNC_REPORT: Call = { cmd: "sync_report" };
const READ_REGISTRY: Call = { cmd: "read_registry" };

// ── mcp probe / catalog helper ──
const MCP_PROBE: Call = { cmd: "hub_cmd", args: { args: ["mcp", "check", "context7", "--json"] } };
const MCP_CATALOG: Call = { cmd: "hub_cmd", args: { args: ["mcp", "catalog", "context7", "--json"] } };

const ROWS: Row[] = [
  // ── dispatch timing ───────────────────────────────────────────────────
  // `ipcDelay` changes no response shape, only WHEN `invoke()` resolves, so
  // it is proven as a hang: with a 100s delay a query cannot settle inside
  // the race window, while an unflagged `read_registry` resolves at once.
  { flag: "ipcDelay", value: "100000", mode: "hang", call: READ_REGISTRY },

  // ── shell / sync ──────────────────────────────────────────────────────
  { flag: "attentionQueue", call: SYNC_REPORT },
  { flag: "bootstrap", call: { cmd: "bootstrap_check" } },
  { flag: "screenError", mode: "fail", call: { cmd: "bootstrap_check" } },
  { flag: "elsewhereAttention", call: SYNC_REPORT },
  { flag: "mcpBlocked", call: SYNC_REPORT },
  { flag: "missingSkills", call: SYNC_REPORT },
  { flag: "remotesSkipped", call: SYNC_REPORT },
  { flag: "staleReport", call: SYNC_REPORT },
  { flag: "syncError", call: SYNC_REPORT },
  { flag: "syncErrorLong", call: SYNC_REPORT },
  { flag: "syncFails", value: "1", fresh: true, call: { cmd: "hub_cmd", args: { args: ["sync", "--json"] } } },
  { flag: "syncFails", value: "stdout", fresh: true, call: { cmd: "hub_cmd", args: { args: ["sync", "--json"] } } },
  { flag: "syncHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["sync", "--json"] } } },

  // ── library / registry ───────────────────────────────────────────────
  { flag: "docLinkConflict", fresh: true, call: { cmd: "hub_cmd", args: { args: ["harness", "doc", "link", "codex", "--to", "claude-code", "--json"] } } },
  { flag: "guardrailsAttention", call: { cmd: "permissions_show", args: { scope: { kind: "global" }, personal: false } } },
  { flag: "navSearch", call: READ_REGISTRY },
  { flag: "noScan", call: { cmd: "hub_cmd", args: { args: ["usage", "project", "example-app", "--json"] } } },
  { flag: "pendingBundleAdd", mode: "hang", raceMs: 40, call: { cmd: "hub_cmd", args: { args: ["bundle", "update", "android", "--skills", "brainstorm", "--json"] } } },
  { flag: "permDivergence", call: { cmd: "permissions_show", args: { scope: { kind: "global" }, personal: false } } },
  { flag: "pickerMany", call: READ_REGISTRY },
  // projectOverview, projectOverviewDense, bundlePlaybook, classification and
  // classOverflow all share a fixture with a module-level "applied once"
  // guard (`playbookSeeded`/`classificationFixturesApplied`) that a sibling
  // flag's own row would otherwise permanently consume — see the dedicated
  // fresh-module block below.
  { flag: "projectSessions", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usedByMany", call: READ_REGISTRY },

  // ── mcp / agents ─────────────────────────────────────────────────────
  { flag: "adoptFails", mode: "fail", call: { cmd: "mcp_add_json", args: { args: ["mcp", "add", "new-server"], body: "{}" } } },
  { flag: "agentDocMarkerError", call: { cmd: "read_agent_doc", args: { relativePath: "CLAUDE.md" } } },
  { flag: "agentsAttention", call: { cmd: "subagent_list", args: { scope: "user", project: null } } },
  { flag: "companionsAbsent", call: { cmd: "subagent_list", args: { scope: "user", project: null } } },
  { flag: "companionsPending", call: SYNC_REPORT },
  { flag: "companionsProvisioned", call: { cmd: "permissions_show", args: { scope: { kind: "project", name: "moon-base" }, personal: false } } },
  { flag: "hookCapsVaried", call: { cmd: "hook_capabilities" } },
  { flag: "hookDoctorFindings", call: { cmd: "hook_doctor" } },
  { flag: "hookScriptMissing", call: { cmd: "hook_script_show", args: { name: "format-on-write" } } },
  { flag: "hooksEmpty", call: { cmd: "hook_list" } },
  { flag: "invocationHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["set-meta", "brainstorm", "--invocation", "user-only"] } } },
  { flag: "invocationNative", value: "all", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "codex", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "opencode-command", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "opencode-shared", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "opencode-unknown", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "yaml-failure", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationNative", value: "none", call: { cmd: "hub_cmd", args: { args: ["skill", "invocation", "brainstorm", "--json"] } } },
  { flag: "invocationPartial", fresh: true, call: { cmd: "hub_cmd", args: { args: ["set-meta", "brainstorm", "--invocation", "user-only"] } } },
  { flag: "mcpCandidates", call: { cmd: "hub_cmd", args: { args: ["mcp", "reconcile", "--json"] } } },
  { flag: "mcpCatalogEmpty", call: MCP_CATALOG },
  { flag: "mcpCatalogErrors", call: MCP_CATALOG },
  { flag: "mcpCatalogMissing", call: MCP_CATALOG },
  { flag: "mcpCatalogUnreadable", call: MCP_CATALOG },
  { flag: "mcpConflict", call: { cmd: "hub_cmd", args: { args: ["mcp", "reconcile", "--json"] } } },
  { flag: "mcpLiteral", call: { cmd: "hub_cmd", args: { args: ["mcp", "reconcile", "--json"] } } },
  { flag: "mcpProbeFails", mode: "diff", call: MCP_PROBE },
  { flag: "mcpProbeHangs", mode: "hang", call: MCP_PROBE },
  { flag: "mcpSetFails", mode: "fail", call: { cmd: "mcp_set_json", args: { args: ["mcp", "set", "context7"], body: '{"transport":"http"}' } } },
  { flag: "subagentsEmpty", call: { cmd: "subagent_list", args: { scope: "user", project: null } } },

  // ── permissions / hooks / archive ────────────────────────────────────
  // archiveFails and renameFails both call a MUTATING command (archive
  // deletes the skill; rename with --rewrite-refs renames it). A "diff"
  // row's baseline (unflagged) call would perform the real mutation, so the
  // flagged call fails anyway on retry ("unknown skill(s): brainstorm")
  // even if the mock ignored the flag entirely — a false-negative proof.
  // "fail" mode makes one call, not two, and never mutates.
  { flag: "archiveFails", mode: "fail", call: { cmd: "hub_cmd", args: { args: ["archive", "brainstorm", "--json"] } } },
  { flag: "archiveHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["archive", "brainstorm", "--json"] } } },
  { flag: "enableFails", fresh: true, call: { cmd: "hub_cmd", args: { args: ["enable", "brainstorm", "--json"] } } },
  { flag: "equipHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["enable", "brainstorm", "--json"] } } },
  { flag: "renameFails", mode: "fail", call: { cmd: "hub_cmd", args: { args: ["rename", "brainstorm", "brainstorm-v2", "--rewrite-refs", "--json"] } } },
  { flag: "renameHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["rename", "brainstorm", "brainstorm-v2", "--rewrite-refs", "--json"] } } },
  { flag: "worktreeAccessFails", fresh: true, call: { cmd: "permissions_set", args: { scope: { kind: "project", name: "example-app" }, personal: false, payload: {} } } },

  // ── remotes / sources / backup ───────────────────────────────────────
  { flag: "backupNoCredential", call: { cmd: "backup_auth_status" } },
  { flag: "backupNoGh", call: { cmd: "backup_auth_status" } },
  { flag: "backupNoKeyring", call: { cmd: "backup_auth_status" } },
  { flag: "backupNoSnapshot", call: { cmd: "backup_status" } },
  { flag: "backupPending", call: { cmd: "backup_status" } },
  { flag: "backupStale", call: { cmd: "backup_status" } },
  { flag: "backupUnconfigured", call: { cmd: "backup_status" } },
  { flag: "backupUninitialized", call: { cmd: "backup_status" } },
  { flag: "machineConflict", fresh: true, call: { cmd: "hub_cmd", args: { args: ["remote", "machine", "list", "--json"] } } },
  { flag: "machineBlocked", fresh: true, call: { cmd: "hub_cmd", args: { args: ["remote", "machine", "list", "--json"] } } },
  { flag: "remoteDoctor", call: { cmd: "remote_doctor" } },
  { flag: "restoreConnectionFailed", call: { cmd: "restore_preview", args: { source: "git@github.com:me/skill-tree-backup.git", mode: "replace" } } },
  { flag: "restoreTampered", call: { cmd: "restore_preview", args: { source: "git@github.com:me/skill-tree-backup.git", mode: "replace" } } },
  { flag: "restoreUnverified", call: { cmd: "restore_preview", args: { source: "git@github.com:me/skill-tree-backup.git", mode: "replace" } } },
  { flag: "scanFails", call: { cmd: "hub_cmd", args: { args: ["usage", "scan-sessions", "--json"] } } },
  { flag: "scanHangs", mode: "hang", call: { cmd: "hub_cmd", args: { args: ["usage", "scan-sessions", "--json"] } } },
  { flag: "scanRecoveryHeaderBusy", mode: "hang", raceMs: 60, call: { cmd: "usage_scan_ccusage" } },
  { flag: "scanReplan", call: { cmd: "hub_cmd", args: { args: ["usage", "scan-sessions", "--json"] } } },
  { flag: "sessionMissing", call: { cmd: "hub_cmd", args: { args: ["usage", "session", "some-session", "--json"] } } },
  { flag: "settingsPickFolder", call: { cmd: "pick_directory" } },
  { flag: "settingsReadFails", mode: "fail", call: { cmd: "agent_docs_strategy_get", args: { projectName: null } } },
  { flag: "settingsWriteFails", mode: "fail", call: { cmd: "harness_set_global", args: { id: "opencode", enabled: true } } },
  { flag: "snippetScanHangs", mode: "hang", call: { cmd: "snippet_status", args: {} } },
  { flag: "snippetsEmpty", call: { cmd: "snippets_list", args: { tag: null, query: null, noUsage: true } } },
  { flag: "snippetUpdateHangs", mode: "hang", call: { cmd: "snippet_update", args: { all: true } } },
  // agentSaveFails and sourceAgentSaveFails are OR'd together in the mock
  // (the same save-agent failure), so a "diff" row for one would poison the
  // other's baseline the moment either succeeds and bumps the stored hash —
  // "fail" mode sidesteps that: both just need `ok:false` in the response.
  { flag: "agentSaveFails", mode: "fail", call: {
      cmd: "hub_cmd",
      args: { args: ["skill", "companions", "save-agent", "orchestrate-advanced", "--agent", "orch-implementer", "--json-body", JSON.stringify({ expected_hash: "mock-orch-implementer-v1", description: "x", body: "y" })] },
    } },
  { flag: "sourceAgentSaveFails", mode: "fail", call: {
      cmd: "hub_cmd",
      args: { args: ["skill", "companions", "save-agent", "orchestrate-advanced", "--agent", "orch-implementer", "--json-body", JSON.stringify({ expected_hash: "mock-orch-implementer-v1", description: "x", body: "y" })] },
    } },

  // ── usage ─────────────────────────────────────────────────────────────
  { flag: "codexFamilies", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "codexNotAnalysed", call: { cmd: "hub_cmd", args: { args: ["usage", "findings", "--json"] } } },
  // raceMs 1000, not 40: the UNFLAGGED transport already waits 350ms
  // before it resolves, so a shorter race could never tell "sending"
  // (60s) apart from the default and the row could not fail.
  { flag: "feedback", value: "sending", mode: "hang", raceMs: 1000, call: { cmd: "feedbackTransport" } },
  { flag: "feedback", value: "blocked", call: { cmd: "feedbackTransport" } },
  { flag: "feedback", value: "uncertain", call: { cmd: "feedbackTransport" } },
  { flag: "feedback", value: "limited", call: { cmd: "feedbackTransport" } },
  { flag: "feedbackLoading", mode: "hang", call: { cmd: "runtime_preflight" } },
  { flag: "inspection", call: { cmd: "usage_load_latest_ccusage" } },
  // longSessionTitles only takes effect inside codexFamiliesUsageScan — see
  // the dedicated companion-flag test below.
  { flag: "pruned", call: { cmd: "hub_cmd", args: { args: ["usage", "session", "cccccccc-4444-4444-8444-444444444444", "--json"] } } },
  { flag: "pythonError", call: { cmd: "check_python" } },
  { flag: "usageAccessError", mode: "fail", call: { cmd: "usage_scan_ccusage" } },
  { flag: "usageBackfilled", call: { cmd: "hub_cmd", args: { args: ["usage", "history", "--json"] } } },
  { flag: "usageBig", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageDrilldown", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageEmpty", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageFailure", mode: "fail", call: { cmd: "usage_scan_ccusage" } },
  { flag: "usageIdle", call: { cmd: "hub_cmd", args: { args: ["usage", "footprint", "example-app", "--json"] } } },
  { flag: "usageLong", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageModelMix", call: { cmd: "hub_cmd", args: { args: ["usage", "history", "--json"] } } },
  { flag: "usageNative", value: "observed", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect-index", "--json"] } } },
  { flag: "usageNative", value: "partial", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect-index", "--json"] } } },
  { flag: "usageNative", value: "unavailable", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect-index", "--json"] } } },
  { flag: "usageNoUsage", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageRecent", call: { cmd: "hub_cmd", args: { args: ["usage", "timeline", "--json"] } } },
  { flag: "usageRich", call: { cmd: "hub_cmd", args: { args: ["usage", "footprint", "example-app", "--json"] } } },
  { flag: "usagePruned", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect", "eeeeeeee-6666-4666-8666-666666666666", "--harness", "claude-code", "--view", "tools", "--json"] } } },
  { flag: "timelineEmpty", call: { cmd: "hub_cmd", args: { args: ["usage", "timeline", "--json"] } } },
  { flag: "usageTimelineEmpty", call: { cmd: "hub_cmd", args: { args: ["usage", "timeline", "--json"] } } },
  { flag: "usageTokens", value: "complete", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect-index", "--json"] } } },
  { flag: "usageTokens", value: "partial", call: { cmd: "hub_cmd", args: { args: ["usage", "inspect-index", "--json"] } } },
  { flag: "usageUnpriced", call: { cmd: "usage_load_latest_ccusage" } },
  { flag: "usageUnregistered", call: { cmd: "usage_load_latest_ccusage" } },

  // ── window / misc primitives ─────────────────────────────────────────
  { flag: "fullscreen", call: { cmd: "getCurrentWindow.isFullscreen" } },
];

/**
 * Flags proven by a dedicated `it()` below rather than a `ROWS` entry —
 * each needs a fresh module per call (an "apply once" fixture guard, a
 * module-init read, or a stateful counter) that the generic table runner
 * cannot give it. Declared statically, alongside `ROWS`, so coverage below
 * reflects what the table DECLARES, not what happened to execute — a
 * `vitest run -t <name>` filter that skips every other test still reports
 * accurate coverage instead of false failures.
 *
 * A name in this array is only a CLAIM. `VERIFIED_DEDICATED_FLAGS` below
 * checks the claim against this file's own text: deleting the dedicated
 * `it()` for a flag (rather than deleting it from this array) must also
 * drop that flag out of coverage, not leave it silently green.
 */
const DEDICATED_FLAGS: SceneFlagName[] = [
  "restoreRecovery",
  "restoreRecoveryDense",
  "libraryEmpty",
  "hooksAttention",
  "contextAttention",
  "classification",
  "classOverflow",
  "bundlePlaybook",
  "projectOverview",
  "projectOverviewDense",
  "longSessionTitles",
  "scanRecoveryDelayed",
  "scanRecoveryTransport",
];

// This file's own source, read fresh off disk (not the transpiled output,
// not a cached import) — `it(`/`test(` titles are plain text in it
// regardless of how vitest later transforms the module.
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf-8");

/** Every string title passed to a top-level `it(...)`/`test(...)` call in
 *  this file. A template-literal title (the `ROWS` loop's generated ones)
 *  is captured too, but its `${...}` placeholders never literally contain
 *  a flag name, so it can't produce a false match here. */
const IT_TITLES: string[] = (() => {
  const titles: string[] = [];
  const re = /\b(?:it|test)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(OWN_SOURCE))) titles.push(m[2]);
  return titles;
})();

/** A title counts for `flag` only when the flag is its LEADING token
 *  (`flag=`, `flag ` or the whole title) — a sibling test that merely
 *  mentions it, e.g. `classOverflow=1 (needs classification=1 too)`, must
 *  not keep `classification` covered after its own test is deleted. The
 *  lookahead also stops `restoreRecovery` matching `restoreRecoveryDense=1`. */
function hasDedicatedTest(flag: SceneFlagName): boolean {
  const leading = new RegExp(`^${flag}(?![A-Za-z0-9_])`);
  return IT_TITLES.some((title) => leading.test(title));
}

const VERIFIED_DEDICATED_FLAGS = DEDICATED_FLAGS.filter(hasDedicatedTest);

const COVERED = new Set<SceneFlagName>([...ROWS.map((row) => row.flag), ...VERIFIED_DEDICATED_FLAGS]);

describe("sceneFidelity: table-driven rows", () => {
  for (const row of ROWS) {
    const label = row.value ? `${row.flag}=${row.value}` : row.flag;
    const mode = row.mode ?? "diff";

    it(`${label} (${mode}) changes ${row.call.cmd}'s response`, async () => {
      const value = row.value ?? "1";

      if (row.mode === "hang") {
        setSearch(`?${row.flag}=${value}`);
        const settled = await raceSettled(invokeCall(row.call), row.raceMs ?? 40);
        expect(settled, `${label} was expected to leave ${row.call.cmd} in flight`).toBe("pending");
        return;
      }

      if (row.mode === "fail") {
        setSearch(`?${row.flag}=${value}`);
        const failed = await ranToFailure(invokeCall(row.call));
        expect(failed, `${label} was expected to make ${row.call.cmd} reject or report failure`).toBe(true);
        return;
      }

      if (row.fresh) {
        // The command mutates shared mock state — give baseline and
        // flagged their own module instance so neither call's mutation
        // can be mistaken for the flag's effect.
        setSearch("");
        let mod = await freshTauriCore();
        const baseline = await mod.invoke(row.call.cmd, row.call.args).catch((e: unknown) => ({ __rejected: String(e) }));
        setSearch(`?${row.flag}=${value}`);
        mod = await freshTauriCore();
        const flagged = await mod.invoke(row.call.cmd, row.call.args).catch((e: unknown) => ({ __rejected: String(e) }));
        expect(flagged, `${label} did not change ${row.call.cmd}'s response`).not.toEqual(baseline);
        return;
      }

      setSearch("");
      const baseline = await invokeCall(row.call).catch((e: unknown) => ({ __rejected: String(e) }));
      setSearch(`?${row.flag}=${value}`);
      const flagged = await invokeCall(row.call).catch((e: unknown) => ({ __rejected: String(e) }));
      expect(flagged, `${label} did not change ${row.call.cmd}'s response`).not.toEqual(baseline);
    });
  }
});

// `async` on purpose: `invoke()` can throw SYNCHRONOUSLY (a `mcpSetFails`-
// style mock throws directly, not via a rejected promise) when the dispatch
// has no artificial delay. Marking this function `async` converts that
// synchronous throw into a rejected promise like every other path here, so
// `.catch()`/`await`/`raceSettled` all see one consistent shape.
async function invokeCall(call: Call): Promise<unknown> {
  if (call.cmd === "feedbackTransport") {
    // The feedback mock is a plain async function, not an `invoke` command.
    // It never reads the payload (only the scene flag), so any well-typed
    // stand-in works.
    return import("@/mocks/feedbackTransport").then((m) =>
      m.feedbackTransport({ message: "x", screen: "test", tab: "test", appVersion: "0", os: "test" }),
    );
  }
  if (call.cmd === "getCurrentWindow.isFullscreen") {
    return import("@/mocks/tauriWindow").then((m) => m.getCurrentWindow().isFullscreen());
  }
  return invoke(call.cmd, call.args);
}

// ── scanRecoveryDelayed / scanRecoveryTransport ──────────────────────────
//
// Both share `usageScanMock`'s module-level `recoveryScanCount` counter
// (`app/src/mocks/tauriUsageAnalytics.ts`) with `scanRecoveryHeaderBusy`'s
// `hub usage scan-sessions` arm: the FIRST call after either flag is set
// always replans (a real state-machine step, not a random one). Each test
// below gets its OWN fresh module (`freshTauriCore()`), so the counter
// always starts at 0 there — neither test depends on the other, or on
// anything else in this file, having run first or at all. A `vitest run -t
// scanRecoveryTransport` filter that skips every other test still passes.
describe("sceneFidelity: scanRecoveryDelayed / scanRecoveryTransport (own fresh module each)", () => {
  afterEach(() => setSearch(""));

  it("scanRecoveryDelayed=1 (diff) replans hub usage scan-sessions's first call", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke<{ success: boolean; output: string }>("hub_cmd", { args: ["usage", "scan-sessions", "--json"] });
    setSearch("?scanRecoveryDelayed=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke<{ success: boolean; output: string }>("hub_cmd", { args: ["usage", "scan-sessions", "--json"] });
    expect(flagged).not.toEqual(baseline);
    expect(JSON.parse(flagged.output)).toMatchObject({ state: "replan_required" });
  });

  it("scanRecoveryTransport=1 (fail) rejects hub usage scan-sessions's second call", async () => {
    setSearch("?scanRecoveryTransport=1");
    const mod = await freshTauriCore();
    const call = () => mod.invoke<{ success: boolean; output: string }>("hub_cmd", { args: ["usage", "scan-sessions", "--json"] });
    // Fresh module: the counter starts at 0. The first call always replans
    // (count 1, the same state-machine step `scanRecoveryDelayed` proves
    // above); the second call lands on count 2, exactly where
    // `scanRecoveryTransport` rejects.
    await call();
    const failed = await ranToFailure(call());
    expect(failed).toBe(true);
  });
});

// ── Flags that mutate shared module state at IMPORT time ────────────────
//
// `libraryEmpty` (marks the tips-tour done in a `tauriCore.ts` module-init
// block), `restoreRecoveryDense` (picks `recovery.ts`'s `STORAGE_KEY` const
// at import time) and `hooksAttention` (pushes an extra hook into
// `tauriCore.ts`'s module-level `hooksStore` at import time) all read their
// flag ONCE, when the module first evaluates — not on every call, the way
// every other flag above does. A statically-imported module has already
// made that decision by the time this file's other tests run, so each of
// these three needs its own fresh module instance: `vi.resetModules()` plus
// a dynamic re-import, with the flag set BEFORE the import runs.
describe("sceneFidelity: module-init flags (fresh module per flag)", () => {
  afterEach(() => setSearch(""));

  it("libraryEmpty=1 marks the tips-tour done before the module's registry import (diff via local_skill_candidates)", async () => {
    window.localStorage.removeItem("st:tips:done");
    setSearch("");
    let mod = await freshTauriCore();
    // Module init must NOT mark the tour done without the flag.
    expect(window.localStorage.getItem("st:tips:done")).toBeNull();
    const baseline = await mod.invoke("local_skill_candidates");
    window.localStorage.removeItem("st:tips:done");
    setSearch("?libraryEmpty=1");
    mod = await freshTauriCore();
    // …and must mark it done, at import time, with the flag.
    expect(window.localStorage.getItem("st:tips:done")).toBe("1");
    const flagged = await mod.invoke("local_skill_candidates");
    expect(flagged).not.toEqual(baseline);
    expect(flagged).toEqual([]);
    window.localStorage.removeItem("st:tips:done");
  });

  it("restoreRecovery=1 seeds the F1-F4 incident without a start call (diff via recovery_command)", async () => {
    // `state.seeded` persists in sessionStorage across a module reload
    // (that IS the flag's point — a reload resumes the same journey), so
    // each half of this test needs its own clean bucket.
    window.sessionStorage.clear();
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("recovery_command", { args: ["status", "--json"] });
    window.sessionStorage.clear();
    setSearch("?restoreRecovery=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("recovery_command", { args: ["status", "--json"] });
    expect(flagged).not.toEqual(baseline);
  });

  it("restoreRecoveryDense=1 seeds 15 projects instead of the small default set (diff via recovery_command)", async () => {
    window.sessionStorage.clear();
    setSearch("?restoreRecovery=1");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("recovery_command", { args: ["status", "--json"] });
    window.sessionStorage.clear();
    setSearch("?restoreRecoveryDense=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("recovery_command", { args: ["status", "--json"] });
    expect(flagged).not.toEqual(baseline);
  });

  it("hooksAttention=1 pushes an extra hook into hook_list's module-init store (diff)", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("hook_list");
    setSearch("?hooksAttention=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("hook_list");
    expect(flagged).not.toEqual(baseline);
  });

  it("contextAttention=1 marks orphaned-note outdated (diff via snippets_list, fresh module to avoid the idempotent-apply guard)", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    // `noUsage: false` — the flag's only effect is on the `usage` field
    // `dropUsage` would otherwise strip.
    const baseline = await mod.invoke("snippets_list", { tag: null, query: null, noUsage: false });
    setSearch("?contextAttention=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("snippets_list", { tag: null, query: null, noUsage: false });
    expect(flagged).not.toEqual(baseline);
  });
});

// ── Flags gated behind an "applied once per module" fixture guard ───────
//
// `ensureClassificationFixtures` (`classificationFixturesApplied`) and
// `ensurePlaybookFixtures` (`playbookSeeded`) each gate a family of flags
// behind ONE module-level boolean, set the first time any flag in the
// family fires and never cleared. A sibling flag's own row in the generic
// table above would silently consume that boolean and leave nothing for
// the next row to prove — each of these gets its own fresh module instead,
// with the companion flag it depends on set explicitly.
describe("sceneFidelity: once-per-module fixture families (fresh module per flag)", () => {
  afterEach(() => setSearch(""));

  it("classification=1 seeds rt-android-expert's classification (diff via read_registry)", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("read_registry");
    setSearch("?classification=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("read_registry");
    expect(flagged).not.toEqual(baseline);
  });

  it("classOverflow=1 (needs classification=1 too) widens rt-android-expert's classes (diff via read_registry)", async () => {
    setSearch("?classification=1");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("read_registry");
    setSearch("?classification=1&classOverflow=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("read_registry");
    expect(flagged).not.toEqual(baseline);
  });

  it("bundlePlaybook=1 seeds the android bundle's playbook (diff via read_registry)", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("read_registry");
    setSearch("?bundlePlaybook=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("read_registry");
    expect(flagged).not.toEqual(baseline);
  });

  it("projectOverview=1 seeds a fuller project-overview bundle shape (diff via read_registry)", async () => {
    setSearch("");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("read_registry");
    setSearch("?projectOverview=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("read_registry");
    expect(flagged).not.toEqual(baseline);
  });

  it("projectOverviewDense=1 (needs projectOverview=1 too) adds 200 extra skills (diff via read_registry)", async () => {
    setSearch("?projectOverview=1");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("read_registry");
    setSearch("?projectOverview=1&projectOverviewDense=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("read_registry");
    expect(flagged).not.toEqual(baseline);
  });

  it("longSessionTitles=1 (needs codexFamilies=1 too) lengthens the Codex inspection session's title (diff via hub usage scan)", async () => {
    setSearch("?codexFamilies=1");
    let mod = await freshTauriCore();
    const baseline = await mod.invoke("usage_load_latest_ccusage");
    setSearch("?codexFamilies=1&longSessionTitles=1");
    mod = await freshTauriCore();
    const flagged = await mod.invoke("usage_load_latest_ccusage");
    expect(flagged).not.toEqual(baseline);
  });
});

/** Resets the module registry, then re-imports `tauriCore.ts`, so a
 *  module-init read (`libraryEmpty`, `restoreRecoveryDense`,
 *  `hooksAttention`) picks up whatever `window.location.search` the caller
 *  set immediately before calling this. */
async function freshTauriCore(): Promise<typeof import("@/mocks/tauriCore")> {
  vi.resetModules();
  return import("@/mocks/tauriCore");
}

// ─── Every DEDICATED_FLAGS entry names a real test ────────────────────────
//
// `DEDICATED_FLAGS` is a hand-written claim, not something the file checks
// on its own — deleting a dedicated `it()` without also deleting its entry
// here would otherwise leave that flag silently "covered" forever. This
// re-derives the claim from the file's own text (`IT_TITLES`, above) so a
// deleted `it()` fails loudly, by name, instead of vanishing quietly.
describe("sceneFidelity: every DEDICATED_FLAGS entry names a real it()/test() in this file", () => {
  it.each(DEDICATED_FLAGS)("%s", (flag) => {
    expect(
      hasDedicatedTest(flag),
      `DEDICATED_FLAGS claims "${flag}" has a dedicated test, but no it()/test() title in this file mentions it`,
    ).toBe(true);
  });
});

// ─── Coverage: every declared flag has a row or an honest reason ─────────
//
// `COVERED` is computed once, above, from `ROWS` and
// `VERIFIED_DEDICATED_FLAGS` — both plain arrays evaluated at module load,
// before any `it()` runs. A `-t` filter that runs only one test below
// still sees the FULL table, so coverage never depends on which tests
// actually executed. `VERIFIED_DEDICATED_FLAGS` in turn depends on
// `IT_TITLES` actually naming the flag (see above), so deleting a
// dedicated `it()` fails THIS check too, not just the one above.

describe("sceneFidelity: every declared flag has a row or a KNOWN_NO_FIDELITY_ROW reason", () => {
  const flagNames = Object.keys(SCENE_FLAGS) as SceneFlagName[];

  it.each(flagNames)("%s", (name) => {
    const hasRow = COVERED.has(name);
    const excused = typeof KNOWN_NO_FIDELITY_ROW[name] === "string" && KNOWN_NO_FIDELITY_ROW[name].trim().length > 0;
    expect(hasRow || excused, `"${name}" has no fidelity row and no KNOWN_NO_FIDELITY_ROW reason`).toBe(true);
  });

  // Every value of every `oneOf` flag needs its own row, and a row's
  // `value` must be one the flag declares — otherwise a new variant could
  // ship unproven, or a row could "prove" a value no mock recognises.
  const oneOfFlags = flagNames.flatMap((name) => {
    const def: { kind: string; values?: readonly string[] } = SCENE_FLAGS[name];
    return def.kind === "oneOf" && def.values ? [{ name, values: def.values }] : [];
  });

  it.each(oneOfFlags.flatMap(({ name, values }) => values.map((value) => [name, value] as const)))(
    "oneOf %s=%s has a row",
    (name, value) => {
      const hasRow = ROWS.some((row) => row.flag === name && row.value === value);
      expect(hasRow, `oneOf flag "${name}" declares value "${value}" but no ROWS entry sets it`).toBe(true);
    },
  );

  it("every row for a oneOf flag names a declared value", () => {
    const bad = ROWS.flatMap((row) => {
      const def = oneOfFlags.find((f) => f.name === row.flag);
      if (!def) return [];
      return row.value !== undefined && def.values.includes(row.value) ? [] : [`${row.flag}=${row.value ?? "(none)"}`];
    });
    expect(bad, `rows set values their oneOf flag does not declare: ${bad.join(", ")}`).toEqual([]);
  });

  it("every KNOWN_NO_FIDELITY_ROW key names a declared flag", () => {
    const declared = new Set(flagNames);
    const unknown = Object.keys(KNOWN_NO_FIDELITY_ROW).filter((k) => !declared.has(k as SceneFlagName));
    expect(unknown, `KNOWN_NO_FIDELITY_ROW names undeclared flags: ${unknown.join(", ")}`).toEqual([]);
  });
});
