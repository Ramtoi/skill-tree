import type {
  LocalAgentUsageSnapshot,
  NormalizeUsageOptions,
  UsageCostEstimate,
  UsageDailyPoint,
  UsageDetectedSource,
  UsageHarnessSummary,
  UsageModelBreakdown,
  UsageProjectRef,
  UsageScan,
  UsageScanSource,
  UsageSessionRow,
  UsageTokenCounts,
} from "./usageTypes";

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
      };
    });

    const rawDate = stringOr(row.period, "Unknown date");
    return {
      // Guard the daily bucket's date field the same way the sessions mapping
      // guards `period`: a path-shaped value must never be shown as a date.
      date: isLikelyProjectPath(rawDate) ? "Unknown date" : rawDate,
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
    return {
      id: sessionId(row, index, project),
      period: isLikelyProjectPath(period) ? `${project?.label ?? "Local project"} session` : period,
      startedAt: firstString(row.startedAt, row.startTime, metadata.startedAt, metadata.startTime),
      lastActivity: firstString(row.lastActivity, metadata.lastActivity, metadata.updatedAt),
      harnessId: id,
      harnessName: acc.name,
      project,
      models: readModels(row),
      tokens,
      estimatedCost: cost,
    };
  });

  const detectedSources = buildDetectedSources(harnesses);
  const harnessSummaries = buildHarnessSummaries(harnesses);
  const overviewTokens = readTokens(totalsRow);
  const overviewCost = readCost(totalsRow);
  const topHarness = harnessSummaries.find((harness) => harness.status === "detected")?.name;

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
    },
    harnesses: harnessSummaries,
    detectedSources,
    daily,
    sessions: sessions.sort((a, b) => b.tokens.total - a.tokens.total),
    privacy: {
      runsLocally: true,
      rawPromptsDisplayed: false,
      fullPathsHiddenByDefault: true,
      costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage.",
    },
  };
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

export function readModelBreakdowns(value: unknown): UsageModelBreakdown[] {
  return arrayOfRecords(value).map((row) => ({
    modelName: stringOr(row.modelName, "unknown"),
    tokens: readTokens(row),
    estimatedCost: readCost(row, "cost"),
  }));
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
  };
  harnesses.set(id, created);
  return created;
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
