import type {
  LocalAgentUsageSnapshot,
  NormalizeUsageOptions,
  UsageCostEstimate,
  UsageDailyPoint,
  UsageDayProvenance,
  UsageDetectedSource,
  UsageHarnessSummary,
  UsageHistoryPayload,
  UsageModelBreakdown,
  UsageProjectRef,
  UsageProjectSummary,
  UsageScan,
  UsageScanSource,
  UsageSessionRow,
  UsageTokenCounts,
  UsageToolBreakdownEntry,
} from "./usageTypes";

import { codexRolloutId } from "./sessionIdentity";

const COST_LABEL = "Estimated API-equivalent cost" as const;

const KNOWN_HARNESSES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes Agent",
  pi: "pi-agent",
  goose: "Goose",
  openclaw: "OpenClaw",
  kilo: "Kilo",
  kimi: "Kimi",
  qwen: "Qwen",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
};

type RecordValue = Record<string, unknown>;

type CcusageRow = RecordValue & {
  agent?: unknown;
  agents?: unknown;
  period?: unknown;
  metadata?: unknown;
  modelBreakdowns?: unknown;
  modelsUsed?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
};

type ModelAccumulator = { tokens: UsageTokenCounts; estimatedCostUsd: number };

type HarnessAccumulator = {
  id: string;
  name: string;
  tokens: UsageTokenCounts;
  estimatedCostUsd: number;
  sessions: number;
  days: Set<string>;
  models: Map<string, ModelAccumulator>;
  toolCalls: number;
};

type ProjectAccumulator = {
  key: string;
  label: string;
  sessions: number;
  tokens: UsageTokenCounts;
  estimatedCostUsd: number;
  toolCalls: number;
};

export function normalizeCcusageScan(
  scan: UsageScan,
  options: NormalizeUsageOptions = {},
): LocalAgentUsageSnapshot {
  const parsed = asRecord(scan.parsed);
  const dailyRows = arrayOfRecords(parsed.daily);
  const sessionRows = arrayOfRecords(parsed.session);
  const totalsRow = asRecord(parsed.totals);
  const projectAnonymizer = createProjectAnonymizer(options.includeFullPaths === true);
  const harnesses = new Map<string, HarnessAccumulator>();
  const projects = new Map<string, ProjectAccumulator>();

  const daily: UsageDailyPoint[] = dailyRows.map((row) => {
    const nested = normalizeNestedAgentRows(row);
    const points = nested.map((agentRow) => {
      const id = harnessId(agentRow.agent);
      const acc = ensureHarness(harnesses, id);
      const tokens = readTokens(agentRow);
      const estimatedCost = readCost(agentRow);
      // NOTE: row.period is the OUTER daily row's calendar date (e.g.
      // "2026-07-10"), not agentRow's. session[].period is never a calendar
      // date (it's a session UUID for claude, or a compound
      // "yyyy/mm/dd/rollout-...-uuid" path for codex) — so `days` has no
      // session-side source and MUST stay fed from `daily`.
      if (typeof row.period === "string") {
        acc.days.add(row.period);
      }
      // tokens/estimatedCost stay LOCAL — used only for this returned chart
      // point, never written into `acc`. The daily and session ccusage
      // sections are independent complete views of identical usage; the
      // session loop is the sole writer of acc.tokens/estimatedCostUsd/models
      // (see A1) so we don't double-count here.
      return {
        id,
        name: acc.name,
        tokens,
        estimatedCost,
        // A live ccusage scan always reports a real cost and a real
        // input/output/cache split — never a placeholder — so both flags are
        // unconditionally true here. This is what lets a scan-derived point
        // stand in for a history-derived one on the fallback path: the two
        // shapes are structurally identical.
        costKnown: true,
        splitKnown: true,
        models: readModelBreakdowns(agentRow.modelBreakdowns),
      };
    });

    const rawDate = stringOr(row.period, "Unknown date");
    return {
      // Guard the daily bucket's date field the same way the sessions mapping
      // guards `period`: a path-shaped value must never be shown as a date.
      date: isLikelyProjectPath(rawDate) ? "Unknown date" : rawDate,
      // A ccusage scan only ever reports what it just measured — there is no
      // "frozen"/"backfilled" concept on this path, so every scan-derived
      // point is unconditionally "scanned" with both coverage flags true.
      // `usageChartColumns.ts`'s bucket roll-up keys off this literal value,
      // so it must be set explicitly rather than left `undefined`.
      provenance: "scanned",
      costKnown: true,
      splitKnown: true,
      harnesses: points,
      tokens: readTokens(row),
      estimatedCost: readCost(row),
    };
  });

  const sessions: UsageSessionRow[] = sessionRows.map((row, index) => {
    const id = harnessId(row.agent);
    const acc = ensureHarness(harnesses, id);
    const tokens = readTokens(row);
    const cost = readCost(row);
    addTokens(acc.tokens, tokens);
    acc.estimatedCostUsd += cost.usd;
    acc.sessions += 1;
    addModelUsage(acc, row);

    const metadata = asRecord(row.metadata);
    const project = projectAnonymizer.projectFor(row, metadata);
    const period = stringOr(row.period, `Session ${index + 1}`);

    const toolCalls = countMetric(metadata.toolCalls);
    const toolBreakdown = readToolBreakdown(metadata);
    const linesAdded = countMetric(metadata.linesAdded);
    const linesRemoved = countMetric(metadata.linesRemoved);
    const durationMs = nonNegativeNumber(metadata.durationMs);
    // Codex-only, and reported by ccusage directly on the row — never
    // written by this app's Rust enrichment.
    const reasoningOutputTokens = countMetric(metadata.reasoningOutputTokens);
    const title = readTitle(metadata);
    const titleSource =
      title && (metadata.titleSource === "custom" || metadata.titleSource === "ai" || metadata.titleSource === "native")
        ? metadata.titleSource
        : undefined;
    const branch = readBranch(metadata);
    const pr = readPrLink(metadata);
    const hubProject = readHubProject(metadata);

    acc.toolCalls += toolCalls ?? 0;

    const projectKey = hubProject ?? project?.label ?? "unknown";
    const projectLabelStr = hubProject ?? project?.label ?? "No project";
    const projectAcc = ensureProject(projects, projectKey, projectLabelStr);
    projectAcc.sessions += 1;
    addTokens(projectAcc.tokens, tokens);
    projectAcc.estimatedCostUsd += cost.usd;
    projectAcc.toolCalls += toolCalls ?? 0;

    const rolloutUuid = codexRolloutId(period);
    return {
      id: id === "codex" && rolloutUuid ? rolloutUuid : sessionId(row, index, project),
      period: isLikelyProjectPath(period) ? `${project?.label ?? "Local project"} session` : period,
      startedAt: firstString(row.startedAt, row.startTime, metadata.startedAt, metadata.startTime),
      lastActivity: firstString(row.lastActivity, metadata.lastActivity, metadata.updatedAt),
      harnessId: id,
      harnessName: acc.name,
      project,
      models: readModels(row),
      modelBreakdown: readModelBreakdowns(row.modelBreakdowns),
      tokens,
      estimatedCost: cost,
      ...(title ? { title } : {}),
      ...(titleSource ? { titleSource } : {}),
      ...(id === "codex" ? {
        parentSessionId: firstString(metadata.parentSessionId),
        agentRole: firstString(metadata.agentRole),
        agentNickname: firstString(metadata.agentNickname),
        agentPath: firstString(metadata.agentPath),
      } : {}),
      ...(branch ? { branch } : {}),
      ...(pr ? { pr } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toolBreakdown ? { toolBreakdown } : {}),
      ...(linesAdded !== undefined ? { linesAdded } : {}),
      ...(linesRemoved !== undefined ? { linesRemoved } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(hubProject ? { hubProject } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    };
  });

  const detectedSources = buildDetectedSources(harnesses);
  const harnessSummaries = buildHarnessSummaries(harnesses);
  const overviewTokens = readTokens(totalsRow);
  const overviewCost = readCost(totalsRow);
  const topHarness = harnessSummaries.find((harness) => harness.status === "detected")?.name;
  const overviewTokensResolved =
    overviewTokens.total > 0 ? overviewTokens : sumTokenCounts(harnessSummaries.map((h) => h.tokens));
  const cacheDenominator =
    overviewTokensResolved.input + overviewTokensResolved.cacheRead + overviewTokensResolved.cacheCreation;

  return {
    scannedAt: new Date(numberOr(scan.scanned_at, 0) * 1000).toISOString(),
    runner: sanitizeSource(scan.source),
    overview: {
      totalTokens: overviewTokens.total || sum(harnessSummaries.map((h) => h.tokens.total)),
      estimatedCost:
        overviewCost.usd > 0
          ? overviewCost
          : estimatedCost(sum(harnessSummaries.map((h) => h.estimatedCost.usd))),
      sessions: sessions.length,
      topHarness,
      harnessesDetected: harnessSummaries.filter((harness) => harness.status === "detected").length,
      tokens: overviewTokensResolved,
      toolCalls: sum(harnessSummaries.map((h) => h.toolCalls)),
      cacheHitRate: cacheDenominator > 0 ? overviewTokensResolved.cacheRead / cacheDenominator : 0,
      linesAdded: sum(sessions.map((s) => s.linesAdded ?? 0)),
      linesRemoved: sum(sessions.map((s) => s.linesRemoved ?? 0)),
    },
    harnesses: harnessSummaries,
    detectedSources,
    daily,
    sessions: sessions.sort((a, b) => b.tokens.total - a.tokens.total),
    models: mergeAllModels(harnesses),
    projects: buildProjectSummaries(projects),
    privacy: {
      runsLocally: true,
      rawPromptsDisplayed: false,
      fullPathsHiddenByDefault: true,
      costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage.",
    },
  };
}

const DAY_PROVENANCE_VALUES = new Set<UsageDayProvenance>(["scanned", "frozen", "backfilled"]);

function isDayProvenance(value: unknown): value is UsageDayProvenance {
  return typeof value === "string" && DAY_PROVENANCE_VALUES.has(value as UsageDayProvenance);
}

/** `UsageHistoryDay.tokens` / `UsageHistoryAgent.tokens` / a model row's
 *  `tokens` — already `UsageTokenCounts`-shaped camelCase JSON from
 *  `hub usage history --json`, unlike the raw ccusage envelope `readTokens`
 *  above reads. Still coerced defensively (a present-but-wrong-typed field
 *  falls back to 0) since this is process output parsed off stdout, not a
 *  typed value. */
function coerceTokens(value: unknown): UsageTokenCounts {
  const row = asRecord(value);
  return {
    input: numberOr(row.input, 0),
    output: numberOr(row.output, 0),
    cacheCreation: numberOr(row.cacheCreation, 0),
    cacheRead: numberOr(row.cacheRead, 0),
    total: numberOr(row.total, 0),
  };
}

/** An agent's `models[]` history rows → `UsageModelBreakdown[]`. The
 *  remainder row (`model: null`) gets a stand-in name — it still carries
 *  real tokens/cost that must not vanish from the Top Models card. */
function normalizeHistoryModels(value: unknown): UsageModelBreakdown[] {
  return arrayOfRecords(value).map((row) => {
    const modelName = typeof row.model === "string" && row.model.trim().length > 0 ? row.model : "Unknown model";
    return {
      modelName,
      tokens: coerceTokens(row.tokens),
      estimatedCost: estimatedCost(numberOr(row.costUsd, 0)),
      // REVIEW-W1 #1: a backfilled-only model's row carries `costKnown:
      // false` — `0`-filled, not a real zero price. Threaded through so
      // `isUnpriced` never mislabels it "unpriced".
      costKnown: row.costKnown === true,
    };
  });
}

function normalizeHistoryDay(day: RecordValue): UsageDailyPoint {
  const agents = arrayOfRecords(day.agents);
  const harnesses = agents.map((agent) => {
    const id = harnessId(agent.agent);
    return {
      id,
      name: stringOr(agent.name, harnessName(id)),
      tokens: coerceTokens(agent.tokens),
      estimatedCost: estimatedCost(numberOr(agent.costUsd, 0)),
      costKnown: agent.costKnown === true,
      splitKnown: agent.splitKnown === true,
      ...(typeof agent.sessions === "number" && Number.isFinite(agent.sessions) && agent.sessions >= 0
        ? { sessions: agent.sessions }
        : {}),
      ...(typeof agent.sessionsKnown === "boolean" ? { sessionsKnown: agent.sessionsKnown } : {}),
      models: normalizeHistoryModels(agent.models),
    };
  });
  return {
    date: stringOr(day.date, "Unknown date"),
    provenance: isDayProvenance(day.provenance) ? day.provenance : "scanned",
    costKnown: day.costKnown === true,
    splitKnown: day.splitKnown === true,
    ...(typeof day.sessions === "number" && Number.isFinite(day.sessions) && day.sessions >= 0
      ? { sessions: day.sessions }
      : {}),
    ...(typeof day.sessionsKnown === "boolean" ? { sessionsKnown: day.sessionsKnown } : {}),
    harnesses,
    tokens: coerceTokens(day.tokens),
    estimatedCost: estimatedCost(numberOr(day.costUsd, 0)),
  };
}

/**
 * `hub usage history --json`'s `days[]` → `UsageDailyPoint[]`, sorted by
 * date. Tolerant of a missing/malformed `agents` array (an empty ledger, or
 * a hand-edited payload) the way {@link normalizeCcusageScan} is tolerant of
 * a malformed scan — a bad day degrades to an empty-harnesses point rather
 * than throwing. The one function `rangeScopedDaily` (`usageAggregate.ts`)
 * chooses between and every range-scoped card reads from, alongside
 * {@link normalizeCcusageScan}'s scan-derived points.
 */
export function normalizeUsageHistory(payload: UsageHistoryPayload): UsageDailyPoint[] {
  const days = Array.isArray(payload?.days) ? (payload.days as unknown as RecordValue[]) : [];
  return days
    .filter((day): day is RecordValue => isRecord(day))
    .map(normalizeHistoryDay)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function anonymizeProjectPath(path: string, index = 0, includeFullPath = false): UsageProjectRef {
  const label = projectLabel(index);
  const redactedPath = redactPath(path);
  return includeFullPath
    ? { label, anonymized: true, redactedPath, fullPath: path }
    : { label, anonymized: true, redactedPath };
}

export function isLikelyProjectPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("/Users/") ||
    trimmed.includes("/home/") ||
    trimmed.includes("/workspace/") ||
    trimmed.includes("/projects/")
  );
}

const CCUSAGE_ENCODED_PROJECT_KEY = /^--[A-Za-z0-9_.-]+--$/;

/** ccusage encodes `metadata.projectPath` by replacing `/` with `-` and
 *  wrapping in `--`, e.g. `/Users/alice/Dev/private/note-board` →
 *  `--Users-alice-Dev-private-note-board--`. {@link isLikelyProjectPath}
 *  only recognizes `/`-based shapes, so this dedicated predicate is needed to
 *  catch the encoded form. */
function isCcusageEncodedProjectKey(value: unknown): value is string {
  return typeof value === "string" && CCUSAGE_ENCODED_PROJECT_KEY.test(value.trim());
}

/** Best-effort decode of ccusage's dash-encoded project key back to a
 *  slash-form path. Lossy: real path segments that themselves contain a
 *  literal `-` (e.g. "note-board") can't be perfectly distinguished from an
 *  encoded `/` — acceptable for a local convenience display, not a security
 *  boundary. */
function decodeCcusageProjectKey(key: string): string {
  const inner = key.trim().replace(/^--/, "").replace(/--$/, "");
  return "/" + inner.replace(/-/g, "/");
}

const PATH_RUN_PATTERN =
  /(?:~\/|\/(?:Users|home|workspace|projects)\/)[^\s"'\\]*|[A-Za-z]:\\[^\s"']+/g;

/** Redact path-shaped runs embedded inside a free-form text blob (e.g. ccusage
 *  stdout/stderr) so local absolute paths never leak into copyable diagnostics.
 *  Unlike {@link isLikelyProjectPath} (which classifies a whole-string value),
 *  this scrubs substrings within a larger string. */
export function redactPathsInText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text.replace(PATH_RUN_PATTERN, "<redacted-path>");
}

/** Model/token/cost breakdown rows off `modelBreakdowns[]`, strictly
 *  validated: the on-disk cache (`~/.skill-hub/usage/latest-ccusage.json`) is
 *  a plain file a user can hand-edit, so a corrupt row — a numeric or
 *  missing `modelName`, a NaN/negative token or cost field — is dropped
 *  WHOLE rather than coerced to a placeholder name or a zero, which would
 *  otherwise get summed into every rollup this feeds (session, harness,
 *  overview). A present-but-valid field is used verbatim; an ABSENT field
 *  still defaults to 0 (most rows omit `totalTokens`, for instance). */
export function readModelBreakdowns(value: unknown): UsageModelBreakdown[] {
  return arrayOfRecords(value)
    .map(readModelBreakdown)
    .filter((entry): entry is UsageModelBreakdown => entry !== undefined);
}

function readModelBreakdown(row: RecordValue): UsageModelBreakdown | undefined {
  if (typeof row.modelName !== "string" || row.modelName.trim().length === 0) {
    return undefined;
  }
  const tokens = readStrictTokens(row);
  const estimatedCost = readStrictCost(row, "cost");
  if (!tokens || !estimatedCost) {
    return undefined;
  }
  return { modelName: row.modelName, tokens, estimatedCost };
}

const MODEL_BREAKDOWN_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "totalTokens",
] as const;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Like {@link readTokens}, but a PRESENT token field that isn't a finite,
 *  non-negative number fails the whole row instead of falling back to 0. */
function readStrictTokens(row: RecordValue): UsageTokenCounts | undefined {
  for (const field of MODEL_BREAKDOWN_TOKEN_FIELDS) {
    if (row[field] !== undefined && !isFiniteNonNegative(row[field])) {
      return undefined;
    }
  }
  return readTokens(row);
}

/** Like {@link readCost}, but a PRESENT cost field that isn't a finite,
 *  non-negative number fails the row instead of falling back to 0. */
function readStrictCost(row: RecordValue, key: string): UsageCostEstimate | undefined {
  if (row[key] !== undefined && !isFiniteNonNegative(row[key])) {
    return undefined;
  }
  return readCost(row, key);
}

/** Cap on a rendered tool name, in characters — the same cap
 *  `usage_enrich.rs` truncates to before ever writing a `toolBreakdown` key,
 *  so an on-disk key longer than this can only be hand tampering. */
const MAX_TOOL_NAME_CHARS = 64;
/** Cap on how many `toolBreakdown` entries survive into a session row —
 *  mirrors the Rust writer's own cap so re-reading a well-formed cache never
 *  drops anything the writer kept. */
const MAX_TOOL_BREAKDOWN_ENTRIES = 16;

/** `metadata.toolBreakdown`, read into a sorted, capped list. Guards every
 *  field the same way the rest of this module guards a plain-file cache:
 *  must be a plain object (not an array, not a primitive); each key must be
 *  a non-empty string at or under {@link MAX_TOOL_NAME_CHARS} and not
 *  path-shaped (a tool name is never a filesystem path); each value must be
 *  a non-negative integer. Sorted by count descending, then name, and capped
 *  to {@link MAX_TOOL_BREAKDOWN_ENTRIES} — `undefined` when nothing
 *  survives, never an empty array. */
function readToolBreakdown(metadata: RecordValue): UsageToolBreakdownEntry[] | undefined {
  const raw = metadata.toolBreakdown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const entries: UsageToolBreakdownEntry[] = [];
  for (const [name, value] of Object.entries(raw as RecordValue)) {
    if (name.length === 0 || name.length > MAX_TOOL_NAME_CHARS || isLikelyProjectPath(name)) {
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      continue;
    }
    entries.push({ name, count: value });
  }
  if (entries.length === 0) {
    return undefined;
  }
  entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return entries.slice(0, MAX_TOOL_BREAKDOWN_ENTRIES);
}

function normalizeNestedAgentRows(row: CcusageRow): CcusageRow[] {
  const agents = arrayOfRecords(row.agents);
  if (agents.length > 0) {
    return agents;
  }
  return [row];
}

function ensureHarness(harnesses: Map<string, HarnessAccumulator>, id: string): HarnessAccumulator {
  const existing = harnesses.get(id);
  if (existing) {
    return existing;
  }
  const created: HarnessAccumulator = {
    id,
    name: harnessName(id),
    tokens: zeroTokens(),
    estimatedCostUsd: 0,
    sessions: 0,
    days: new Set<string>(),
    models: new Map<string, ModelAccumulator>(),
    toolCalls: 0,
  };
  harnesses.set(id, created);
  return created;
}

function ensureProject(
  projects: Map<string, ProjectAccumulator>,
  key: string,
  label: string,
): ProjectAccumulator {
  const existing = projects.get(key);
  if (existing) {
    return existing;
  }
  const created: ProjectAccumulator = {
    key,
    label,
    sessions: 0,
    tokens: zeroTokens(),
    estimatedCostUsd: 0,
    toolCalls: 0,
  };
  projects.set(key, created);
  return created;
}

function buildProjectSummaries(projects: Map<string, ProjectAccumulator>): UsageProjectSummary[] {
  return Array.from(projects.values())
    .map((p) => ({
      key: p.key,
      label: p.label,
      sessions: p.sessions,
      tokens: p.tokens,
      estimatedCost: estimatedCost(p.estimatedCostUsd),
      toolCalls: p.toolCalls,
    }))
    .sort(
      (a, b) =>
        b.estimatedCost.usd - a.estimatedCost.usd ||
        b.tokens.total - a.tokens.total ||
        a.label.localeCompare(b.label),
    );
}

function mergeAllModels(harnesses: Map<string, HarnessAccumulator>): UsageModelBreakdown[] {
  const merged = new Map<string, ModelAccumulator>();
  for (const acc of harnesses.values()) {
    for (const [name, usage] of acc.models) {
      const existing = merged.get(name) ?? { tokens: zeroTokens(), estimatedCostUsd: 0 };
      addTokens(existing.tokens, usage.tokens);
      existing.estimatedCostUsd += usage.estimatedCostUsd;
      merged.set(name, existing);
    }
  }
  return Array.from(merged.entries())
    .map(([modelName, usage]) => ({
      modelName,
      tokens: usage.tokens,
      estimatedCost: estimatedCost(usage.estimatedCostUsd),
    }))
    .sort(
      (a, b) =>
        b.estimatedCost.usd - a.estimatedCost.usd ||
        b.tokens.total - a.tokens.total ||
        a.modelName.localeCompare(b.modelName),
    );
}

function sumTokenCounts(list: UsageTokenCounts[]): UsageTokenCounts {
  const total = zeroTokens();
  for (const t of list) {
    addTokens(total, t);
  }
  return total;
}

/** Cap on a rendered session title. The Rust enricher caps it too, but the
 *  cache is a file on disk a user (or a stale older build) can hand us. */
const MAX_TITLE_CHARS = 160;
/** Cap on a rendered hub project name. A registry key is a short slug. */
const MAX_HUB_PROJECT_CHARS = 120;
/** Cap on a rendered branch chip. A git ref name is short. */
const MAX_BRANCH_CHARS = 120;

/** Reads a `pr` link off session metadata only when BOTH a usable `prNumber`
 *  and an `https://` `prUrl` are present — a partial pair (e.g. a number with
 *  no url) never surfaces, since a session row wouldn't be able to link out.
 *
 *  The number must be a positive integer (a PR is 1-based, so `0`, a negative,
 *  `NaN`, `Infinity`, a float and a numeric STRING are all refused), and the
 *  url must be `https://` — which is also what drops a `prUrl` the cache
 *  redactor hashed into a `~/redacted/<hash>` placeholder, so a placeholder
 *  can never become a link target. */
function readPrLink(metadata: RecordValue): { number: number; url: string } | undefined {
  const number = metadata.prNumber;
  const url = metadata.prUrl;
  if (
    typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0 &&
    typeof url === "string" &&
    url.startsWith("https://")
  ) {
    return { number, url };
  }
  return undefined;
}

/** A session title, safe to render. Trimmed, re-scrubbed of path runs (the
 *  cache is a plain file: an older build, or a hand edit, can put an
 *  unscrubbed one there), length-capped, and dropped when nothing is left. */
function readTitle(metadata: RecordValue): string | undefined {
  const raw = firstString(metadata.title);
  if (!raw) {
    return undefined;
  }
  const scrubbed = redactPathsInText(raw).trim();
  return scrubbed.length > 0 ? scrubbed.slice(0, MAX_TITLE_CHARS) : undefined;
}

/** A git branch, safe to render as a chip. Unlike the title, a branch is shown
 *  verbatim, so a path-shaped value — including the `~/redacted/<hash>`
 *  placeholder the cache redactor writes for one — is refused outright rather
 *  than displayed as a branch name. */
function readBranch(metadata: RecordValue): string | undefined {
  const raw = firstString(metadata.gitBranch);
  if (!raw) {
    return undefined;
  }
  // Capped BEFORE the predicate: `isLikelyProjectPath` is a `value is string`
  // type guard, so the negated branch narrows a string variable to `never`.
  const branch = raw.trim().slice(0, MAX_BRANCH_CHARS);
  if (branch.length === 0 || isLikelyProjectPath(branch)) {
    return undefined;
  }
  return branch;
}

/** The registry project NAME the Rust side matched for this session.
 *
 *  Rust only ever writes a registry key here, never a path — but the cache is
 *  a file on disk, so a path-shaped (or `~/redacted/<hash>`) value is refused
 *  and the session falls back to the anonymous `Project A` lettering. The
 *  value is used verbatim as TEXT otherwise (React escapes it), only trimmed
 *  and length-capped. */
function readHubProject(metadata: RecordValue): string | undefined {
  const raw = firstString(metadata.hubProject);
  if (!raw) {
    return undefined;
  }
  const name = raw.trim().slice(0, MAX_HUB_PROJECT_CHARS);
  if (name.length === 0 || isLikelyProjectPath(name)) {
    return undefined;
  }
  return name;
}

/** A countable metric (tool calls, lines added/removed): a non-negative
 *  integer or nothing. A negative would SUBTRACT from the screen's totals and
 *  a float would render as "3.5 tools". */
function countMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addModelUsage(acc: HarnessAccumulator, row: CcusageRow) {
  const breakdowns = readModelBreakdowns(row.modelBreakdowns);
  if (breakdowns.length > 0) {
    for (const model of breakdowns) {
      const existing = acc.models.get(model.modelName) ?? {
        tokens: zeroTokens(),
        estimatedCostUsd: 0,
      };
      addTokens(existing.tokens, model.tokens);
      existing.estimatedCostUsd += model.estimatedCost.usd;
      acc.models.set(model.modelName, existing);
    }
    return;
  }
  // Fallback for rows with `modelsUsed` but no cost/token breakdown: record
  // presence at zero usage so the model still surfaces (sorts last) instead of
  // silently vanishing.
  for (const name of arrayOfStrings(row.modelsUsed)) {
    if (!acc.models.has(name)) {
      acc.models.set(name, { tokens: zeroTokens(), estimatedCostUsd: 0 });
    }
  }
}

function sortModelUsage(models: Map<string, ModelAccumulator>): UsageModelBreakdown[] {
  return Array.from(models.entries())
    .map(([modelName, usage]) => ({
      modelName,
      tokens: usage.tokens,
      estimatedCost: estimatedCost(usage.estimatedCostUsd),
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total || a.modelName.localeCompare(b.modelName));
}

function buildHarnessSummaries(harnesses: Map<string, HarnessAccumulator>): UsageHarnessSummary[] {
  const detected = Array.from(harnesses.values())
    .map((acc) => {
      const modelBreakdown = sortModelUsage(acc.models);
      return {
        id: acc.id,
        name: acc.name,
        status: "detected" as const,
        tokens: acc.tokens,
        estimatedCost: estimatedCost(acc.estimatedCostUsd),
        sessions: acc.sessions,
        days: acc.days.size,
        toolCalls: acc.toolCalls,
        models: modelBreakdown.map((m) => m.modelName),
        modelBreakdown,
      };
    })
    .sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));

  const noUsage = Object.entries(KNOWN_HARNESSES)
    .filter(([id]) => !harnesses.has(id))
    .map(([id, name]) => ({
      id,
      name,
      status: "no_usage" as const,
      tokens: zeroTokens(),
      estimatedCost: estimatedCost(0),
      sessions: 0,
      days: 0,
      toolCalls: 0,
      models: [],
      modelBreakdown: [],
    }));

  return [...detected, ...noUsage];
}

function buildDetectedSources(harnesses: Map<string, HarnessAccumulator>): UsageDetectedSource[] {
  const detected = Array.from(harnesses.values())
    .map((acc) => ({
      id: acc.id,
      name: acc.name,
      status: "detected" as const,
      tokens: acc.tokens,
      estimatedCost: estimatedCost(acc.estimatedCostUsd),
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));

  const knownNoUsage = Object.entries(KNOWN_HARNESSES)
    .filter(([id]) => !harnesses.has(id))
    .map(([id, name]) => ({
      id,
      name,
      status: "no_usage" as const,
      tokens: zeroTokens(),
      estimatedCost: estimatedCost(0),
    }));

  return [...detected, ...knownNoUsage];
}

function createProjectAnonymizer(includeFullPaths: boolean) {
  const byPath = new Map<string, UsageProjectRef>();
  return {
    projectFor(row: RecordValue, metadata: RecordValue): UsageProjectRef | undefined {
      const candidate = firstString(
        row.projectPath,
        row.project,
        row.cwd,
        row.path,
        metadata.projectPath,
        metadata.project,
        metadata.cwd,
        metadata.workspace,
        metadata.repository,
      );
      const period = stringOr(row.period, "");
      const resolvedCandidate = isCcusageEncodedProjectKey(candidate)
        ? decodeCcusageProjectKey(candidate)
        : candidate;
      const path = isLikelyProjectPath(resolvedCandidate)
        ? resolvedCandidate
        : pathFromPeriod(period);
      // A hub-recognized project (registry name, resolved server-side from
      // cwd) names the ref directly — never consumes a letter, and two
      // sessions under different cwds but the same hub project share this
      // label. Path-only lettering below is completely untouched by this
      // branch, so its ordering never shifts because a hub-project session
      // happened to be interleaved.
      //
      // This runs BEFORE the "no path, no ref" bail-out: the hub name is
      // resolved from the session's own transcript, so it can be present when
      // no path candidate reached the row at all (a claude row whose
      // projectPath join missed). Returning undefined there would show the row
      // as "Local project" while the projects rollup filed it under the hub
      // name — the row and the rollup must agree.
      const hubProject = readHubProject(metadata);
      if (hubProject) {
        if (!path) {
          return { label: hubProject, anonymized: true };
        }
        const redactedPath = redactPath(path);
        return includeFullPaths
          ? { label: hubProject, anonymized: true, redactedPath, fullPath: path }
          : { label: hubProject, anonymized: true, redactedPath };
      }
      if (!path) {
        return undefined;
      }
      const existing = byPath.get(path);
      if (existing) {
        return existing;
      }
      const ref = anonymizeProjectPath(path, byPath.size, includeFullPaths);
      byPath.set(path, ref);
      return ref;
    },
  };
}

function pathFromPeriod(period: string): string | undefined {
  if (!period || !isLikelyProjectPath(period)) {
    return undefined;
  }
  const normalized = period.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "";
  if (leaf.includes(".") && parts.length > 1) {
    const prefix = normalized.startsWith("/") ? "/" : "";
    return `${prefix}${parts.slice(0, -1).join("/")}`;
  }
  return period;
}

export function readTokens(row: RecordValue): UsageTokenCounts {
  const input = numberOr(row.inputTokens, 0);
  const output = numberOr(row.outputTokens, 0);
  const cacheCreation = numberOr(row.cacheCreationTokens, 0);
  const cacheRead = numberOr(row.cacheReadTokens, 0);
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    // Rows that carry a real totalTokens (daily/session/totals/nested-agent
    // rows) keep using ccusage's own reported value verbatim — never silently
    // override it. Only rows that omit it (modelBreakdowns[] entries, which
    // never carry totalTokens) fall back to the component sum.
    total:
      typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens)
        ? row.totalTokens
        : input + output + cacheCreation + cacheRead,
  };
}

function addTokens(target: UsageTokenCounts, value: UsageTokenCounts) {
  target.input += value.input;
  target.output += value.output;
  target.cacheCreation += value.cacheCreation;
  target.cacheRead += value.cacheRead;
  target.total += value.total;
}

function readCost(row: RecordValue, key = "totalCost"): UsageCostEstimate {
  return estimatedCost(numberOr(row[key], 0));
}

function estimatedCost(usd: number): UsageCostEstimate {
  return { usd, label: COST_LABEL };
}

function readModels(row: CcusageRow): string[] {
  const fromModelsUsed = arrayOfStrings(row.modelsUsed);
  const fromBreakdowns = readModelBreakdowns(row.modelBreakdowns).map((model) => model.modelName);
  return unique([...fromModelsUsed, ...fromBreakdowns]).sort();
}

function sessionId(row: RecordValue, index: number, project?: UsageProjectRef): string {
  const explicit = firstString(row.id, row.sessionId, row.conversationId);
  if (explicit) {
    return explicit;
  }
  const period = stringOr(row.period, `session-${index}`);
  const safePeriod = isLikelyProjectPath(period) ? (project?.label ?? `session-${index + 1}`) : period;
  // Always fold `index` in so the fallback id is unique per row even when
  // `safePeriod` collapses to a shared project label (ccusage session ids are
  // commonly path-shaped) — otherwise two sessions in the same harness+project
  // produce an identical id, colliding as a React list key.
  return `${stringOr(row.agent, "agent")}:${safePeriod}:${index}`;
}

function harnessId(value: unknown): string {
  const raw = stringOr(value, "unknown").toLowerCase().trim();
  if (!raw || raw === "all") {
    return "all";
  }
  return raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function harnessName(id: string): string {
  return KNOWN_HARNESSES[id] ?? titleCase(id.replace(/[-_]+/g, " "));
}

function sanitizeSource(source: UsageScanSource): UsageScanSource {
  return {
    command: source.command,
    args: [...source.args],
    resolved_from: source.resolved_from,
  };
}

function zeroTokens(): UsageTokenCounts {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

function arrayOfRecords(value: unknown): CcusageRow[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is CcusageRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function projectLabel(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < alphabet.length) {
    return `Project ${alphabet[index]}`;
  }
  return `Project ${index + 1}`;
}

function redactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1];
  return leaf ? `…/${leaf}` : "…";
}
