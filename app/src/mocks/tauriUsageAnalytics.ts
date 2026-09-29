/**
 * The stateless mock backend for the five `hub usage <verb> --json`
 * ledger reads/mutations (usage drill-downs, wave 2, design D14.4). Cut into
 * its own file — like `tauriSubagents.ts` — so
 * `tauriCore.ts` stays a shell that delegates rather than growing a second
 * feature's fixtures inline. Reads `sceneFlag` from `tauriCore` at call time
 * only, so the import cycle between the two files is safe (live bindings,
 * nothing evaluated at module load).
 *
 * The four checked-in wave-1 fixtures under `tests/fixtures/usage/*.json`
 * are imported directly (the same pattern `src/lib/mcpContract.ts` already
 * uses for `tests/fixtures/mcp_secret_corpus.json`) rather than hand-copied,
 * so drift is impossible: a fixture regeneration in a later wave-1 fix round
 * is picked up here for free. `scan-sessions.json` is the fifth.
 */
import type { HubResult } from "@/lib/hubCmd";
import type {
  UsageFindingsPayload,
  UsageFootprintPayload,
  UsageProjectPayload,
  UsageScanResult,
  UsageSessionPayload,
  UsageSessionSummary,
  UsageLoadoutsPayload,
  UsageTimelinePayload,
} from "@/features/usage/usageAnalyticsTypes";
import { registry } from "./tauriCore";
import { sceneFlag } from "./scenes";
import { formatProspectiveSkillLine } from "@/lib/usageGuidance";

import projectFixtureJson from "../../../tests/fixtures/usage/project.json";
import sessionFixtureJson from "../../../tests/fixtures/usage/session.json";
import footprintFixtureJson from "../../../tests/fixtures/usage/footprint.json";
import findingsFixtureJson from "../../../tests/fixtures/usage/findings.json";
import scanSessionsFixtureJson from "../../../tests/fixtures/usage/scan-sessions.json";
import timelineFixtureJson from "../../../tests/fixtures/usage/timeline.json";
import usageInspectionFixtureJson from "../../../tests/fixtures/usage/inspection-session.json";

export const usageLoadoutsFixture: UsageLoadoutsPayload = {
  ok: true,
  project: "moon-base",
  rows: [
    { at: "2026-09-05T08:00:00Z", harness: "claude-code", hash: "rich-initial", skill_count: 2, mcp_count: 1, kind: "initial" },
    { at: "2026-09-06T08:00:00Z", harness: "claude-code", hash: "rich-changed", skill_count: 3, mcp_count: 1, kind: "changed" },
  ],
};

/** The raw, UNREWRITTEN `project.json` fixture. Exported so
 *  `usageAnalyticsFidelity.test.ts` can compare the mock's actual `invoke`
 *  response against something loaded independently from disk, never
 *  against this same in-memory value (that would be `fixture === fixture`,
 *  design D14.3/G10). */
export const usageProjectFixture = projectFixtureJson as unknown as UsageProjectPayload;
const usageSessionFixture = sessionFixtureJson as unknown as UsageSessionPayload;
const usageFootprintFixture = footprintFixtureJson as unknown as UsageFootprintPayload;
const usageFindingsFixture = findingsFixtureJson as unknown as UsageFindingsPayload;
const usageScanFixture = scanSessionsFixtureJson as unknown as UsageScanResult;
let recoveryScanCount = 0;
export const usageTimelineFixture = timelineFixtureJson as unknown as UsageTimelinePayload;
export const INSPECTION_SESSION = usageInspectionFixtureJson.captured_contract["claude-code"].session_id;
export const CODEX_INSPECTION_SESSION = usageInspectionFixtureJson.captured_contract.codex.session_id;
const CODEX_ANALYSED_KEY = "codex:019fd809-2012-7ef2-8cfb-91696cccd6f4";
/** The visual scan's Claude sessions that the mock ledger counts as analysed
 *  (their uuids are `visualUsageScan()`'s `period` values in tauriCore.ts).
 *  `c30a87fd…` (Project A) is left out on purpose so the default dashboard
 *  keeps one truthful `Not analysed yet` Claude row beside the analysed ones. */
const CLAUDE_ANALYSED_KEYS = [
  "claude-code:591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f",
  "claude-code:f6e53a79-e8fa-4e45-9c71-1d4d37556f39",
  "claude-code:1dae0a69-6f00-4109-ab1c-873861269996",
  "claude-code:b7a1c2d3-9e4f-4a5b-8c6d-7e8f9a0b1c2d",
  "claude-code:019dc116-ce45-75b8-9b8f-5c111698ec77",
];

const ZERO_ACTIVITY = {
  read: 0,
  edit: 0,
  verify: 0,
  operate: 0,
  delegate: 0,
  skill: 0,
  external: 0,
} as const;

const ZERO_SUMMARY: UsageSessionSummary = {
  tokens_total: 0,
  cache_hit_ratio: 0,
  steering_count: 0,
  duration_minutes: 0,
  activity: { ...ZERO_ACTIVITY },
  thinking_text_share: 0,
  subagent_token_share: 0,
  loadout_assumed: false,
  compactions: 2,
};

function argAfter(cmdArgs: readonly string[], flag: string): string | undefined {
  const idx = cmdArgs.indexOf(flag);
  return idx >= 0 ? cmdArgs[idx + 1] : undefined;
}

const RICH_SCAN_AT = "2026-09-06T12:00:00.000Z";
const RICH_SKILLS = [
  "code-review",
  "deep-research",
  "codex-only",
  "rt-android-expert",
  "android-compose-ui",
  "android-jetpack-compose-material3-theming-helper",
  "git-committer-mcp",
  "openspec-apply",
  "brainstorm",
] as const;

function richUsageEnabled(): boolean {
  return sceneFlag("usageRich") || sceneFlag("usageIdle");
}

function richTrail(seed: number): number[] {
  return Array.from({ length: 30 }, (_, index) => (index + seed) % 7 === 0 ? seed + 1 : 0);
}

const RICH_SESSIONS = Array.from({ length: 6 }, (_, index) => ({
  session_id: `rich-session-${index + 1}`,
  // Every third session is a Codex one, so the shelf's Harness filter has
  // two real options in the rich scene.
  harness: index % 3 === 2 ? "codex" : "claude-code",
  started_at: `2026-09-0${index + 1}T10:00:00.000Z`,
  tokens_total: 1200 + index * 180,
  cache_hit_ratio: 0.8,
  steering_count: 2 + index,
  loadout_assumed: false,
  analysed: true,
}));

const RICH_UTILIZATION: UsageProjectPayload["utilization"] = RICH_SKILLS.map((key, index) => ({
  key,
  count: key === "deep-research" ? 0 : index + 1,
  you: key === "openspec-apply" ? 0 : index % 2,
  model: key === "openspec-apply" ? 0 : index + 1,
  script: key === "openspec-apply" ? 3 : 0,
  last_used_at: key === "deep-research" ? null : RICH_SCAN_AT,
  trail: key === "deep-research" ? Array.from({ length: 30 }, () => 0) : richTrail(index + 1),
  footprint_bytes: 120 + index * 37,
  harnesses: ["claude-code"],
  sessions_with_skill: 6,
  idle: key === "deep-research",
}));

const RICH_AGENT_DOCS = `# Project instructions\n\nThis seeded project document represents the local agent guidance used by the visual mock.\n\nUse the project registry as the source of truth. Keep changes focused, explain decisions in plain language, and verify reads before writes.\n\n## Working agreements\n\nReview the active loadout before changing a skill. Prefer the smallest reversible action, preserve user-authored files, and record any deferred observation that cannot be proven in the local environment.\n\n## Delivery\n\nThe project uses a stable set of harness instructions and shared component contracts. A usage read reports observed prompt composition and does not start a transcript scan.\n`.repeat(8);

const RICH_SKILL_LINES = RICH_SKILLS.map((key, index) => {
  const text = `${key}: seeded project skill description ${index + 1}`;
  return { key, text, bytes: text.length };
});

function richFootprint(project: string): UsageFootprintPayload {
	const projectRecord = registry.projects[project];
	const liveLines = projectRecord
		? [...new Set([
			...(projectRecord.enabled ?? []),
        ...(sceneFlag("projectOverview") ? Object.values(registry.bundles).filter(bundle => bundle.scope === "global").flatMap(bundle => bundle.skills) : []),
			...(projectRecord.bundles ?? []).flatMap((bundle) => registry.bundles[bundle]?.skills ?? []),
		])]
			.filter((name) => registry.skills[name] && (!sceneFlag("projectOverview") || registry.skills[name].type !== "mcp-server"))
			.map((name) => {
				const skill = registry.skills[name];
				const text = formatProspectiveSkillLine({
					name,
					description: skill.description,
					projectSkillsDir: ".claude/skills",
				});
				return { key: name, text, bytes: text.length };
			})
		: RICH_SKILL_LINES;
	const skillLines = projectRecord ? liveLines : RICH_SKILL_LINES;
  const skillsText = skillLines.map((line) => line.text).join("\n");
  const docs = [
    { rel: "docs/PROJECT.md", text: RICH_AGENT_DOCS.slice(0, 1800) },
    { rel: "docs/WORKFLOW.md", text: RICH_AGENT_DOCS.slice(1800, 3600) },
  ].map((doc) => ({ ...doc, bytes: doc.text.length }));
  const parts = [
    { part: "skills", label: `Skill descriptions (${skillLines.length})`, text: skillsText, bytes: skillsText.length },
    { part: "agent_docs", label: "CLAUDE.md + 2 imports", text: RICH_AGENT_DOCS, bytes: RICH_AGENT_DOCS.length },
    ...(!sceneFlag("projectOverview") ? [{ part: "mcp_schemas", label: "MCP tool schemas (0 servers)", text: "", bytes: 0 }] : []),
  ];
  return {
    ...usageFootprintFixture,
    project: "moon-base",
    last_scan_at: RICH_SCAN_AT,
    harnesses: {
      "claude-code": {
        parts,
        unknown: sceneFlag("projectOverview") ? [{ part: "mcp_schemas", label: "MCP tool schemas", reason: "No stored schema text in this preview", hint: "Stored capability counts do not establish prompt size." }] : [],
        bytes_total: parts.reduce((total, part) => total + part.bytes, 0),
        approx_tokens: Math.ceil(parts.reduce((total, part) => total + part.bytes, 0) / 4),
        skill_lines: skillLines,
        discoverable: docs,
        discoverable_bytes: docs.reduce((total, doc) => total + doc.bytes, 0),
        discoverable_truncated: false,
      },
    },
  };
}

function richProject(name: string, window: number): UsageProjectPayload {
  const base = usageProjectFixture.findings.filter((finding) => finding.kind !== "idle");
  return {
    ...usageProjectFixture,
    project: name,
    window,
    last_scan_at: RICH_SCAN_AT,
    harnesses: ["claude-code", "codex"],
    sessions: RICH_SESSIONS,
    utilization: RICH_UTILIZATION,
    outcomes: { ...usageProjectFixture.outcomes, sessions: 6 },
    findings: [
      ...base.map((finding) => ({ ...finding, project: name, review: { ...finding.review, project: name } })),
      {
        id: `idle:${name}:deep-research`,
        kind: "idle",
        project: name,
        observation: "deep-research was equipped in all six sessions but was not invoked.",
        numbers: { skills: ["deep-research"], sessions: 6 },
        moves: [
          { label: "Unequip", kind: "unequip", targets: ["deep-research"] },
          { label: "Set user-only", kind: "invocation", targets: ["deep-research"] },
        ],
        review: { area: "loadout", project: name, highlight: ["deep-research"] },
      },
    ],
  };
}

/**
 * `hub usage project <name> --window <w> --json`. The checked-in fixture
 * names whatever project wave 1's synthetic tree produced ("alpha"), which
 * the app's own VISUAL_MOCK registry does not know — so this rewrites
 * `project`, every `findings[].project` and every `findings[].review.project`
 * to the requested `<name>` (design D14.4), and `window` to the requested
 * window so the payload agrees with the caller's own request. The scan
 * timestamp is normalized to the scan fixture so scenes do not depend on
 * which fixture happened to be generated with a cursor timestamp.
 */
export function usageProjectMock(cmdArgs: readonly string[]): UsageProjectPayload {
  const name = cmdArgs[2] ?? usageProjectFixture.project;
  const windowArg = argAfter(cmdArgs, "--window");
  const window = windowArg !== undefined ? Number(windowArg) : usageProjectFixture.window;
  const rewritten: UsageProjectPayload = {
    ...usageProjectFixture,
    project: name,
    window,
    findings: usageProjectFixture.findings.map((f) => ({
      ...f,
      project: name,
      review: { ...f.review, project: name },
    })),
  };
  if (sceneFlag("noScan")) {
    return { ...rewritten, last_scan_at: null, utilization: [], findings: [], sessions: [] };
  }
  if (sceneFlag("projectSessions")) return {
    ...richProject(name, window),
    sessions: [
      { ...RICH_SESSIONS[0], session_id: "591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f", last_activity_at: "2026-09-10T10:00:00Z", loadout_assumed: true },
      { ...RICH_SESSIONS[2], session_id: "019fd809-2012-7ef2-8cfb-91696cccd6f4", last_activity_at: "2026-09-14T18:00:00Z" },
      { ...RICH_SESSIONS[1], session_id: "33333333-3333-4333-8333-333333333333", last_activity_at: null },
    ],
  };
  if (richUsageEnabled()) return richProject(name, window);
  return { ...rewritten, last_scan_at: usageScanFixture.last_scan_at };
}

/**
 * `hub usage session <id> [--harness <h>] --json`. Rewrites `session_id`
 * (and `harness`, when the caller passed one) to the requested values, per
 * design D14.4's mock-is-route-agnostic rule.
 */
export function usageSessionMock(cmdArgs: readonly string[]): UsageSessionPayload {
  const id = sceneFlag("inspection") ? INSPECTION_SESSION : (cmdArgs[2] ?? usageSessionFixture.session_id);
  const harness = argAfter(cmdArgs, "--harness") ?? usageSessionFixture.harness;

  if (sceneFlag("sessionMissing")) {
    return {
      ok: false,
      reason: "not_found",
      session_id: id,
      harness,
      project: null,
      window: null,
      last_scan_at: null,
      transcript_present: false,
      summary: { ...ZERO_SUMMARY },
      intent_excerpt: "",
      events: [],
      subagents: [],
    };
  }

  // Codex fixture rows carry scanner analysis; the analysed rollout key has
  // no parent, while the second existing Codex fixture id exercises one.
  const codexParentId = "019fc2a1-77b0-7c11-9a10-2b6e3f0d81aa";
  const summary = harness === "codex"
    ? {
        ...(usageSessionFixture.summary ?? ZERO_SUMMARY),
        compactions: 2,
        ...(id === codexParentId
          ? { parent_session_id: "11111111-2222-4333-8444-555555555555" }
          : {}),
      }
    : usageSessionFixture.summary;
  const rewritten: UsageSessionPayload = { ...usageSessionFixture, session_id: id, harness, summary };

  if (sceneFlag("noScan")) {
    return { ...rewritten, last_scan_at: null, events: [], subagents: [] };
  }
  if (sceneFlag("pruned")) {
    return {
      ...rewritten,
      transcript_present: false,
      intent_excerpt: "",
      events: (rewritten.events ?? []).map((event) => ({ ...event, excerpt: "" })),
    };
  }
  return rewritten;
}

/** `hub usage footprint <name> --json` — wave 3's drill-down; wired here so
 *  the arm exists and the mock file inventory is complete for `ipcParity`. */
export function usageFootprintMock(cmdArgs: readonly string[]): UsageFootprintPayload {
  const name = cmdArgs[2] ?? usageFootprintFixture.project;
  const rewritten: UsageFootprintPayload = { ...usageFootprintFixture, project: name };
  if (sceneFlag("noScan")) {
    return { ...rewritten, last_scan_at: null };
  }
  if (richUsageEnabled()) return richFootprint(name);
  return { ...rewritten, last_scan_at: usageScanFixture.last_scan_at };
}

/** `hub usage findings [--project <name>] --json`. */
export function usageFindingsMock(cmdArgs: readonly string[]): UsageFindingsPayload {
  const project = argAfter(cmdArgs, "--project");
  const rewritten: UsageFindingsPayload = project
    ? {
        ...usageFindingsFixture,
        findings: usageFindingsFixture.findings.map((f) => ({
          ...f,
          project,
          review: { ...f.review, project },
        })),
      }
    : usageFindingsFixture;
  if (sceneFlag("noScan")) {
    return { ...rewritten, last_scan_at: null, findings: [] };
  }
  const existing = rewritten.analysed_sessions ?? [];
  const analysed_sessions = sceneFlag("codexNotAnalysed")
    ? [...existing, ...CLAUDE_ANALYSED_KEYS].filter((key) => !key.startsWith("codex:"))
    : Array.from(new Set([...existing, ...CLAUDE_ANALYSED_KEYS, CODEX_ANALYSED_KEY]));
  return { ...rewritten, analysed_sessions, last_scan_at: usageScanFixture.last_scan_at };
}

/** `hub usage loadouts <project> --json`. */
export function usageLoadoutsMock(cmdArgs: readonly string[]): UsageLoadoutsPayload {
  return { ...usageLoadoutsFixture, project: cmdArgs[2] ?? usageLoadoutsFixture.project };
}

function visualTimelineDates(): string[] {
  if (sceneFlag("usageRecent")) {
    return Array.from({ length: 450 }, (_, index) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - index);
      return index % 7 < 2 ? null : date.toISOString().slice(0, 10);
    }).filter((date): date is string => date !== null).sort();
  }
  const weekly = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 11, 1 + index * 7));
    if (index % 9 === 0 || date > new Date("2026-09-04T00:00:00Z")) return null;
    return date.toISOString().slice(0, 10);
  }).filter((date): date is string => date !== null);
  const july = Array.from({ length: 14 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
  return [...new Set([...weekly, ...july])].sort();
}

function visualTimelinePayload(cmdArgs: readonly string[]): UsageTimelinePayload {
  const since = argAfter(cmdArgs, "--since") ?? null;
  const until = argAfter(cmdArgs, "--until") ?? null;
  const dates = visualTimelineDates().filter((date) => (!since || date >= since) && (!until || date <= until));
  const skills = ["orchestrate", "deliver-it", "grill-it", "brainstorm", "skill-tree-git-ci"];
  const tools = ["touchpoint", "sanity", "built-in"];
  const days = dates.map((date, index) => ({
    date,
    skills: Object.fromEntries(skills.map((skill, skillIndex) => [skill, (index * 3 + skillIndex * 2) % 9 + (skillIndex === 0 ? 3 : 0)])),
    tools: Object.fromEntries(tools.map((tool, toolIndex) => [tool, (index + toolIndex * 2) % 7 + (toolIndex === 0 ? 2 : 0)])),
  }));
  const grid = Array.from({ length: 7 }, (_, weekday) => Array.from({ length: 24 }, (_, hour) => {
    if (hour < 8 || hour > 18) return weekday === 2 && hour === 21 ? 180 : 0;
    return (weekday < 5 ? (weekday + 1) * (hour - 7) * 120 : weekday === 5 ? 80 : 20);
  }));
  return { ...usageTimelineFixture, since, until, days, peaks: { unit: "tokens", grid } };
}

export function usageTimelineMock(cmdArgs: readonly string[] = []): UsageTimelinePayload {
  const project = argAfter(cmdArgs, "--project");
  if (project && !registry.projects[project]) {
    return {
      ...usageTimelineFixture,
      since: argAfter(cmdArgs, "--since") ?? null,
      until: argAfter(cmdArgs, "--until") ?? null,
      days: [],
      peaks: { ...usageTimelineFixture.peaks, grid: Array.from({ length: 7 }, () => Array(24).fill(0)) },
    };
  }
  return sceneFlag("timelineEmpty") || sceneFlag("usageTimelineEmpty") ? { ...usageTimelineFixture, since: argAfter(cmdArgs, "--since") ?? null, until: argAfter(cmdArgs, "--until") ?? null, days: [] } : visualTimelinePayload(cmdArgs);
}

/**
 * `hub usage scan-sessions --json`. Unlike the four reads above, this
 * returns the FULL wrapped `HubResult` (or a never-resolving `Promise`),
 * not a bare payload — `?scanHangs=1` must hang the whole `hub_cmd` call,
 * not merely the JSON it would have returned, and `?scanFails=1` still
 * reports `success: true` because `hub usage scan-sessions` exits 0 even
 * when its own `ok` field is `false` (design D14.2/D14.4).
 */
export function usageScanMock(): HubResult | Promise<HubResult> {
  if (sceneFlag("scanHangs")) {
    return new Promise<never>(() => {});
  }
  if (sceneFlag("scanFails")) {
    const failed: UsageScanResult = {
      ok: false,
      rows_written: 12,
      rows_frozen: 0,
      frozen_appended: 0,
      files_scanned: usageScanFixture.files_scanned,
      files_skipped: usageScanFixture.files_skipped + 1,
      bytes_read: usageScanFixture.bytes_read,
      sessions_unregistered: 0,
      stopped_on: "2026-09-05.jsonl",
      errors: [{ file: "2026-09-05.jsonl", kind: "parse_error" }],
      malformed_rows_dropped: 0,
      last_scan_at: usageScanFixture.last_scan_at,
      harnesses: {
        "claude-code": { files_scanned: 0, files_new: 0, files_appended: 0, files_replaced: 0, rows_written: 0, frozen_appended: 0, errors: 0 },
        codex: { files_scanned: 0, files_new: 0, files_appended: 0, files_replaced: 0, rows_written: 0, frozen_appended: 0, errors: 0 },
      },
    };
    return { success: true, output: JSON.stringify(failed) };
  }
  if (sceneFlag("scanReplan")) {
    const replan: UsageScanResult = {
      ok: false,
      state: "replan_required",
      partial: true,
      scan_id: "scan-2026-09-06-replan",
      reason: "reader_unavailable",
      rows_written: usageScanFixture.rows_written,
      rows_frozen: usageScanFixture.rows_frozen,
      frozen_appended: usageScanFixture.frozen_appended,
      files_scanned: usageScanFixture.files_scanned,
      files_skipped: usageScanFixture.files_skipped,
      bytes_read: usageScanFixture.bytes_read,
      sessions_unregistered: usageScanFixture.sessions_unregistered,
      stopped_on: null,
      errors: [{ kind: "reader_unavailable", file: "/private/reader-cache/transcript.jsonl" }],
      malformed_rows_dropped: usageScanFixture.malformed_rows_dropped,
      last_scan_at: usageScanFixture.last_scan_at,
      harnesses: usageScanFixture.harnesses,
    };
    return { success: true, output: JSON.stringify(replan) };
  }
  if (sceneFlag("scanRecoveryDelayed") || sceneFlag("scanRecoveryTransport") || sceneFlag("scanRecoveryHeaderBusy")) {
    recoveryScanCount += 1;
    if (recoveryScanCount === 1) {
      const replan: UsageScanResult = {
        ok: false,
        state: "replan_required",
        partial: true,
        scan_id: "scan-recovery-replan",
        reason: "reader_unavailable",
        rows_written: usageScanFixture.rows_written,
        rows_frozen: usageScanFixture.rows_frozen,
        frozen_appended: usageScanFixture.frozen_appended,
        files_scanned: usageScanFixture.files_scanned,
        files_skipped: usageScanFixture.files_skipped,
        bytes_read: usageScanFixture.bytes_read,
        sessions_unregistered: usageScanFixture.sessions_unregistered,
        stopped_on: null,
        errors: [{ kind: "reader_unavailable", file: "/private/reader-cache/transcript.jsonl" }],
        malformed_rows_dropped: usageScanFixture.malformed_rows_dropped,
        last_scan_at: usageScanFixture.last_scan_at,
        harnesses: usageScanFixture.harnesses,
      };
      return { success: true, output: JSON.stringify(replan) };
    }
    if (sceneFlag("scanRecoveryTransport")) {
      return Promise.reject(new Error("Transcript scan transport failed."));
    }
    if (recoveryScanCount === 2) {
      return new Promise<HubResult>((resolve) => {
        setTimeout(() => resolve({ success: true, output: JSON.stringify(usageScanFixture) }), 650);
      });
    }
  }
  return { success: true, output: JSON.stringify(usageScanFixture) };
}
