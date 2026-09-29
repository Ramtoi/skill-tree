import type { InspectionIndexSession } from "./usageInspectionTypes";

export type UsageScanSource = {
  command: string;
  args: string[];
  resolved_from: string;
};

export type UsageScan = {
  scanned_at: number;
  source: UsageScanSource;
  raw?: string;
  parsed: unknown;
  /** `Some(msg)` (Rust `Option<String>`, so `string | null | undefined` here)
   *  when `hub usage record --from-cache` did not update the durable usage
   *  ledger for this scan — never fatal to the scan itself. The on-disk
   *  cache redactor always strips this back to `null`/absent, so it is only
   *  ever meaningful on the scan a LIVE `usage_scan_ccusage` call just
   *  returned, never on a cached one. */
  ledger_note?: string | null;
};

export type UsageTokenCounts = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
};

export type UsageCostEstimate = {
  usd: number;
  label: "Estimated API-equivalent cost";
};

export type UsageModelBreakdown = {
  modelName: string;
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
  /** `false` only for a ledger row explicitly marked unknown (a backfilled
   *  day's stats-cache-only import — see `UsageHistoryModelRow`). Absent
   *  (not just `true`) everywhere else — a session's own breakdown and a
   *  live scan's day/agent rows are always real, never 0-filled, so those
   *  construction sites never set this field at all. `isUnpriced` (REVIEW-W1
   *  #1) treats absent the same as `true`: only an explicit `false` means
   *  "this $0.00 is a placeholder, not a real price of zero". */
  costKnown?: boolean;
};

export type UsageHarnessStatus = "detected" | "no_usage";

export type UsageHarnessSummary = {
  id: string;
  name: string;
  status: UsageHarnessStatus;
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
  sessions: number;
  days: number;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
  models: string[];
  modelBreakdown: UsageModelBreakdown[];
};

export type UsageDetectedSource = {
  id: string;
  name: string;
  status: UsageHarnessStatus;
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
};

/** Which "grade" of the durable usage ledger a day/agent's row carries —
 *  computed in Python (it owns the freeze horizon): `"scanned"` when the day
 *  is inside the mutable window, `"frozen"` when it is outside the window but
 *  still ccusage-sourced, `"backfilled"` when it holds no `ccusage` row at
 *  all (a `claude-stats-cache` import only). A history-derived
 *  `UsageDailyPoint`/harness entry always carries this; a scan-derived one
 *  fills it in as `"scanned"` so both sources produce structurally identical
 *  points (see `normalizeCcusageScan`). */
export type UsageDayProvenance = "scanned" | "frozen" | "backfilled";

/** Whether a day/agent/model row's cost and token-split fields are real
 *  numbers or 0-filled placeholders. `costUsd` and the token split are
 *  ALWAYS plain numbers, never `null` — trust them only when the sibling
 *  flag here is `true`. A backfilled (stats-cache-only) row has both false;
 *  a ccusage-sourced (scanned/frozen) row has both true. */
export type UsageDayCoverage = { costKnown: boolean; splitKnown: boolean };

export type UsageDailyPoint = {
  date: string;
  /** Additive history metadata; absent means the session count is unknown. */
  sessions?: number;
  sessionsKnown?: boolean;
  /** Day-grain provenance. Absent on a point built before this feature
   *  shipped (never produced by either normalizer now) — readers treat a
   *  missing value as `"scanned"`. */
  provenance?: UsageDayProvenance;
  costKnown?: boolean;
  splitKnown?: boolean;
  harnesses: Array<{
    id: string;
    name: string;
    tokens: UsageTokenCounts;
    estimatedCost: UsageCostEstimate;
    sessions?: number;
    sessionsKnown?: boolean;
    /** Agent-grain coverage — can differ from the day-grain flags above
     *  when only one of several agents active that day is backfilled. */
    costKnown?: boolean;
    splitKnown?: boolean;
    /** Real per-model token/cost breakdown for this harness on this day —
     *  present on a history-derived point (from the ledger row's own model
     *  split) and filled in on a scan-derived point from the day row's own
     *  `modelBreakdowns`, so both sources feed the Top Models card from the
     *  same shape. */
    models?: UsageModelBreakdown[];
  }>;
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
};

export type UsageProjectRef = {
  label: string;
  anonymized: true;
  redactedPath?: string;
  fullPath?: string;
};

/** One tool name's call count within a session's `toolBreakdown`. Sorted by
 *  `count` descending, then `name` ascending — the order `normalizeCcusageScan`
 *  produces and the order the detail panel renders in. */
export type UsageToolBreakdownEntry = {
  name: string;
  count: number;
};

export type UsageSessionRow = {
  id: string;
  period: string;
  startedAt?: string;
  lastActivity?: string;
  harnessId: string;
  harnessName: string;
  project?: UsageProjectRef;
  models: string[];
  /** Real per-model token/cost breakdown for THIS session, straight from
   *  ccusage's own `modelBreakdowns` — `[]` when ccusage reported none (a
   *  session using a single model, or an older cache). The normalizer always
   *  sets it; it is optional only so a row built elsewhere (a test fixture,
   *  another screen's helper) need not carry it — readers use `?? []`. */
  modelBreakdown?: UsageModelBreakdown[];
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
  /** Durable captured transcript projection. Daily/session ccusage fields
   *  above remain the established analytics contract. */
  inspection?: InspectionIndexSession;
  title?: string;
  titleSource?: "custom" | "ai" | "native";
  parentSessionId?: string;
  agentRole?: string;
  agentNickname?: string;
  agentPath?: string;
  branch?: string;
  pr?: { number: number; url: string };
  toolCalls?: number;
  /** Per-tool-name call counts mined from the session transcript (Rust
   *  `usage_enrich.rs`). Omitted when the enrichment pass found no named
   *  call — never an empty array. */
  toolBreakdown?: UsageToolBreakdownEntry[];
  linesAdded?: number;
  linesRemoved?: number;
  durationMs?: number;
  hubProject?: string;
  /** Codex-only: reasoning tokens ccusage reports directly on the session row
   *  (`metadata.reasoningOutputTokens`) — not something this app's Rust
   *  enrichment writes. */
  reasoningOutputTokens?: number;
};

export type LocalAgentUsageOverview = {
  totalTokens: number;
  estimatedCost: UsageCostEstimate;
  sessions: number;
  topHarness?: string;
  harnessesDetected: number;
  tokens: UsageTokenCounts;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
  cacheHitRate: number;
  linesAdded: number;
  linesAddedKnown?: boolean;
  linesRemoved: number;
  linesRemovedKnown?: boolean;
};

export type UsageProjectSummary = {
  key: string;
  label: string;
  sessions: number;
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
  toolCalls: number;
  toolCallsKnown?: boolean;
  toolCallsUnknownSessions?: number;
};

export type LocalAgentUsageSnapshot = {
  scannedAt: string;
  runner: UsageScanSource;
  overview: LocalAgentUsageOverview;
  harnesses: UsageHarnessSummary[];
  detectedSources: UsageDetectedSource[];
  daily: UsageDailyPoint[];
  sessions: UsageSessionRow[];
  models: UsageModelBreakdown[];
  projects: UsageProjectSummary[];
  privacy: {
    runsLocally: true;
    rawPromptsDisplayed: false;
    fullPathsHiddenByDefault: true;
    costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage.";
  };
};

export type NormalizeUsageOptions = {
  includeFullPaths?: boolean;
};

/** Structured error kinds emitted by the Rust `usage` command layer.
 *  Mirrors `UsageErrorKind` (serde `rename_all = "snake_case"`). */
export type UsageErrorKind =
  "no_usage" | "access" | "process_failure" | "timeout" | "parse_failure";

/** Structured error returned (rejected) by the Rust `usage_*` Tauri commands.
 *  Mirrors the `UsageDiagnostic` struct; `Option<T>` fields serialize to `null`
 *  when absent, so optional fields are typed `?: T | null`. */
export type UsageDiagnostic = {
  kind: UsageErrorKind;
  message: string;
  detail?: string | null;
  source?: UsageScanSource | null;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
};

// ─── Durable usage history (`hub usage history --json`) ───────────────────

/** One model's token/cost row within a `UsageHistoryAgent`. `model: null` is
 *  the remainder row (§1 of the design: ccusage's agent total above the sum
 *  of its own `modelBreakdowns`). `costUsd` is 0-filled when unknown — trust
 *  it only when `costKnown` is true. */
export type UsageHistoryModelRow = {
  model: string | null;
  tokens: UsageTokenCounts;
  costUsd: number;
  costKnown: boolean;
};

export type UsageHistoryAgent = UsageDayCoverage & {
  agent: string;
  name: string;
  provenance: UsageDayProvenance;
  source: string;
  tokens: UsageTokenCounts;
  costUsd: number;
  models: UsageHistoryModelRow[];
  sessions?: number | null;
  sessionsKnown?: boolean;
};

export type UsageHistoryDay = UsageDayCoverage & {
  date: string;
  provenance: UsageDayProvenance;
  tokens: UsageTokenCounts;
  costUsd: number;
  agents: UsageHistoryAgent[];
  sessions?: number | null;
  sessionsKnown?: boolean;
};

/** The one-time `stats-cache.json` import's probe — computed by the exact
 *  same guard `import-claude-stats` uses, so this count and a subsequent
 *  real import's inserted-day count can never drift apart. `path` is the
 *  literal `"~/.claude/stats-cache.json"` string (never the expanded real
 *  `$HOME`) unless the caller passed an override. */
export type UsageClaudeStatsProbe = {
  available: boolean;
  path: string;
  importable_days: number;
  last_computed: string | null;
};

export type UsageHistoryPayload = {
  schema_version: number;
  generated_at: string;
  horizon: string;
  since: string | null;
  until: string | null;
  days: UsageHistoryDay[];
  counts: {
    days: number;
    rows: number;
    backfilled_days: number;
    frozen_days: number;
    scanned_days: number;
  };
  claude_stats: UsageClaudeStatsProbe;
  /** `read_rows`' drop warnings — a malformed ledger line was dropped rather
   *  than raising. Empty in the normal case; a non-empty list is a real,
   *  user-visible signal the screen surfaces alongside the "history
   *  unavailable" banner (review W6). */
  warnings: string[];
};

/** `hub usage import-claude-stats --json` result. A real run carries
 *  `inserted`; `--dry-run` carries `would_insert` instead — never both. */
export type UsageImportClaudeStatsResult = {
  path: string;
  skipped_existing: number;
  skipped_ccusage_days: number;
  dry_run: boolean;
  inserted?: number;
  would_insert?: number;
  /** Non-fatal import-time notices (a duplicate stats-cache date, a
   *  malformed `tokensByModel` value) — always present, empty in the normal
   *  case (review W4). */
  warnings: string[];
};

// ─── Price transparency (`usage_pricing_info`, Plan A Addendum A2) ────────

/** One `ccusage-pricing.json` override row — USD per token, so a real
 *  $/MTok rate is this × 1e6. An absent field on the Rust side is 0.0. */
export type UsagePriceOverride = {
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
};

/** The price-transparency source `usage_pricing_info` reads: which ccusage
 *  ran, whether the last scan fetched a live price list or stayed offline,
 *  and any local override file. `ccusage_version` is `null` only when the
 *  version probe itself failed (a 2s timeout) — never when it's merely
 *  unknown. `overrides_path` is `null` when no override file exists;
 *  `overrides` is then always `[]`. */
export type UsagePricingInfo = {
  ccusage_version: string | null;
  offline: boolean;
  overrides_path: string | null;
  overrides: UsagePriceOverride[];
};
