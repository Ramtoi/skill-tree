/**
 * Payload types for the five `hub usage <verb> --json` reads/mutations that
 * back the usage drill-downs (wave 2, design D14.3). This is a SEPARATE
 * family from `./usageTypes.ts`: that file is the ccusage / Rust-scan shape
 * family (`UsageSessionRow`, `UsageProjectSummary`, …); this one is the
 * Python-ledger family (`hub usage project|session|footprint|findings|
 * scan-sessions`). The two collide by name on several concepts
 * ("project", "session") that mean different things in each producer, so
 * they stay in separate files rather than merging into one.
 *
 * Every one of the five reads exits 0 and carries its verdict in the
 * payload — an `{"ok": false, "reason": …}` response is DATA, not a query
 * error (see `hooks/useUsageAnalytics.ts`). Fields mirror wave 1's checked-in
 * fixtures at `tests/fixtures/usage/*.json` field for field; a "success"
 * field is typed optional wherever an `ok: false` response would plausibly
 * omit it (the checked-in fixtures are all `ok: true`, so this is the
 * conservative reading, not a proven one — see `usageAnalyticsFidelity.test.ts`
 * and the unit-E report's Deviations for what is and isn't fixture-proven).
 */

// ─── Shared vocabulary ──────────────────────────────────────────────────────

export type UsageWindow = 7 | 30 | 90;

export interface UsageTimelineDay {
  date: string;
  skills: Record<string, number>;
  tools: Record<string, number>;
}

export interface UsageTimelinePayload {
  schema_version: number;
  since: string | null;
  until: string | null;
  days: UsageTimelineDay[];
  peaks: { unit: "tokens"; grid: number[][] };
  harnesses: Array<{ id: string; name: string }>;
  project?: string | null;
}

export type UsageInvoker = "you" | "model" | "script";

export type UsageEventKind = "human_turn" | "slash_command" | "skill" | "script" | "subagent" | "tool" | "compaction";

export type UsageActivityClass =
  | "read"
  | "edit"
  | "verify"
  | "operate"
  | "delegate"
  | "skill"
  | "external";

export type UsageActivityCounts = Record<UsageActivityClass, number>;
export type UsageActivityCountsNullable = Record<UsageActivityClass, number | null>;

/** The TypeScript twin of `usage_scan.SCANNED_HARNESSES`. A hub harness id
 *  outside this list has no transcript scanner, so its rows wear
 *  `not analysed yet`. Typed `readonly string[]`, not a literal tuple:
 *  `ccusageToHubHarness` returns `string | undefined`, and `.includes()` on a
 *  literal tuple rejects that argument (design D14.3, G17). Pinned against
 *  the checked-in payload fixture by `usageAnalyticsFidelity.test.ts`, so the
 *  two cannot drift silently. */
export const SCANNED_HARNESSES: readonly string[] = ["claude-code", "codex"];

// ─── Session event skeleton (`hub usage session`) ──────────────────────────

/** Deduped assistant usage since the previous event (wave 1, G2). */
export interface UsageEventTokens {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export interface UsageEvent {
  kind: UsageEventKind;
  at: string;
  token_delta: number;
  tokens: UsageEventTokens;
  thinking_len: number;
  output_text_len: number;
  name: string | null;
  model: string | null;
  invoker: UsageInvoker | null;
  excerpt?: string;
  activity: UsageActivityCounts;
  edited_without_verify: boolean;
}

export interface UsageSessionSummary {
  tokens_total: number;
  cache_hit_ratio: number;
  steering_count: number;
  duration_minutes: number;
  activity: UsageActivityCounts;
  thinking_text_share: number;
  subagent_token_share: number;
  loadout_assumed: boolean;
  compactions?: number;
  parent_session_id?: string;
}

/** One sub-agent row on a session payload. Shape is a minimal, defensible
 *  read of design D14.7's "type, model, tokens" description — both checked-in
 *  fixtures carry an empty `subagents: []`, so no field here is
 *  fixture-proven. Treat as provisional until a populated fixture exists. */
export interface UsageSubagentRow {
  type?: string;
  model?: string | null;
  tokens?: number;
}

export interface UsageSessionPayload {
  ok: boolean;
  /** Present on a failure — `"not_found"` (unscanned or unknown id) and
   *  `"ambiguous"` (id shared by two harnesses) are the two named states
   *  design D14.7 gives a rendered treatment. */
  reason?: string;
  session_id: string;
  harness?: string;
  project?: string | null;
  /** A session is one session — always `null` (design D14.6). */
  window: null;
  last_scan_at?: string | null;
  transcript_present?: boolean;
  summary?: UsageSessionSummary;
  intent_excerpt?: string;
  events?: UsageEvent[];
  subagents?: UsageSubagentRow[];
}

// ─── Project payload (`hub usage project`) ─────────────────────────────────

export interface UsageFootprintPart {
  part: string;
  label: string;
  text: string;
  bytes: number;
}

/** One prompt contributor that hub could not size. */
export interface UsageFootprintUnknownEntry {
  part: string;
  label: string;
  reason: string;
  hint: string;
}

export interface UsageSkillLine {
  key: string;
  text: string;
  bytes: number;
}

export interface UsageDiscoverableDoc {
  rel: string;
  text: string;
  bytes: number;
}

export interface UsageFootprintHarness {
  /** The real, observed prompt size — or `null`/absent when this harness has
   *  not been analysed. The standalone `footprint.json` fixture omits this
   *  key entirely on its per-harness entry while `project.json`'s embedded
   *  footprint carries it as a number; optional here so both fixtures type-
   *  check (see the unit-E report's Deviations). */
  observed?: number | null;
  parts: UsageFootprintPart[];
  unknown: UsageFootprintUnknownEntry[];
  bytes_total: number;
  approx_tokens: number;
  skill_lines?: UsageSkillLine[];
  discoverable?: UsageDiscoverableDoc[];
  discoverable_bytes?: number;
  discoverable_truncated?: boolean;
}

export interface UsageUtilizationRow {
  key: string;
  count: number;
  you: number;
  model: number;
  script: number;
  last_used_at: string | null;
  trail: number[];
  footprint_bytes: number;
  harnesses: string[];
  sessions_with_skill: number;
  idle: boolean;
}

export interface UsageOutcomes {
  sessions: number;
  tokens_per_session?: number | null;
  cache_hit_ratio: number | null;
  steering_per_session: number | null;
  subagent_token_share: number | null;
  activity: UsageActivityCountsNullable;
  thinking_text_share: number | null;
  files_read_median: number | null;
  files_edited_median: number | null;
  verified_edit_session_ratio: number | null;
  editing_sessions: number;
  unverified_editing_sessions: number;
  tracked_files: number | null;
  median_all_projects: { activity: UsageActivityCountsNullable };
}

export interface UsageFindingMove {
  label: string;
  kind: string;
  targets: string[];
}

export interface UsageFindingReview {
  area: string;
  project: string;
  highlight: string[];
  also?: string[];
}

export interface UsageLoadoutRow {
  at: string;
  harness: string;
  hash: string;
  skill_count: number;
  mcp_count: number;
  kind: "initial" | "changed";
}

export interface UsageLoadoutsPayload {
  ok: boolean;
  project: string;
  rows: UsageLoadoutRow[];
}

export interface UsageFinding {
  id: string;
  kind: string;
  project: string;
  observation: string;
  /** Varies by finding `kind` — a loose bag of numeric/string facts the
   *  observation sentence was built from. */
  numbers: Record<string, unknown>;
  moves: UsageFindingMove[];
  review: UsageFindingReview;
}

export function idleSkillsOf(finding: UsageFinding): string[] {
  const skills = finding.numbers.skills;
  return Array.isArray(skills) && skills.every((skill): skill is string => typeof skill === "string")
    ? skills
    : [];
}

/** One row of `project.json`'s own `sessions[]` — distinct from the ccusage
 *  family's `UsageSessionRow` (`./usageTypes.ts`), which this is not. */
export interface UsageProjectSessionRow {
  session_id: string;
  parent_session_id?: string | null;
  harness: string;
  started_at?: string | null;
  last_activity_at?: string | null;
  tokens_total: number;
  cache_hit_ratio: number;
  steering_count: number;
  loadout_assumed: boolean;
  analysed: boolean;
}

/** A harness this project has activity on but no transcript scanner reaches
 *  (design D14.6's Sessions-band footer line). Both checked-in fixtures carry
 *  an empty `not_analysed: []`, so only `.harness` is fixture-provable — the
 *  guarded pin in `usageAnalyticsFidelity.test.ts` (G11) says so explicitly
 *  rather than asserting past what the fixture can prove. */
export interface UsageNotAnalysedRow {
  harness: string;
}

export interface UsageProjectPayload {
  ok: boolean;
  reason?: string;
  project: string;
  window: number;
  findings_window: number;
  last_scan_at: string | null;
  harnesses: string[];
  footprint: Record<string, UsageFootprintHarness>;
  utilization: UsageUtilizationRow[];
  subagents: unknown[];
  outcomes: UsageOutcomes;
  findings: UsageFinding[];
  sessions: UsageProjectSessionRow[];
  not_analysed: UsageNotAnalysedRow[];
}

// ─── Footprint payload (`hub usage footprint`) ─────────────────────────────

export interface UsageFootprintPayload {
  ok: boolean;
  reason?: string;
  project: string;
  harnesses: Record<string, UsageFootprintHarness>;
  window: number | null;
  last_scan_at: string | null;
}

// ─── Findings payload (`hub usage findings`) ───────────────────────────────

export interface UsageFindingsPayload {
  ok: boolean;
  reason?: string;
  window: number;
  findings_window: number;
  last_scan_at: string | null;
  findings: UsageFinding[];
  analysed_sessions?: string[];
}

// ─── Scan mutation (`hub usage scan-sessions`) ─────────────────────────────

export interface UsageScanErrorEntry {
  file?: string;
  kind: string;
  reason?: string;
  state?: string;
  partial?: boolean;
  scan_id?: string;
}

export interface UsageScanResult {
  ok: boolean;
  rows_written: number;
  rows_frozen: number;
  frozen_appended: number;
  files_scanned: number;
  files_skipped: number;
  bytes_read: number;
  sessions_unregistered: number;
  stopped_on: string | null;
  errors: UsageScanErrorEntry[];
  /** A pass-level verdict for recoverable scan outcomes. */
  state?: string;
  partial?: boolean;
  scan_id?: string;
  reason?: string;
  /** Present in the checked-in fixture though not enumerated by design
   *  D14.3's field list — included here so the fixture's full key set is
   *  represented (see the unit-E report's Deviations). */
  malformed_rows_dropped: number;
  last_scan_at: string | null;
  harnesses?: Record<string, {
    files_scanned: number;
    files_new: number;
    files_appended: number;
    files_replaced: number;
    rows_written: number;
    frozen_appended: number;
    errors: number;
  }>;
}
