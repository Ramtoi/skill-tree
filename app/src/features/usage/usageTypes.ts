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

export type UsageDailyPoint = {
  date: string;
  harnesses: Array<{
    id: string;
    name: string;
    tokens: UsageTokenCounts;
    estimatedCost: UsageCostEstimate;
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

export type UsageSessionRow = {
  id: string;
  period: string;
  startedAt?: string;
  lastActivity?: string;
  harnessId: string;
  harnessName: string;
  project?: UsageProjectRef;
  models: string[];
  tokens: UsageTokenCounts;
  estimatedCost: UsageCostEstimate;
};

export type LocalAgentUsageOverview = {
  totalTokens: number;
  estimatedCost: UsageCostEstimate;
  sessions: number;
  topHarness?: string;
  harnessesDetected: number;
};

export type LocalAgentUsageSnapshot = {
  scannedAt: string;
  runner: UsageScanSource;
  overview: LocalAgentUsageOverview;
  harnesses: UsageHarnessSummary[];
  detectedSources: UsageDetectedSource[];
  daily: UsageDailyPoint[];
  sessions: UsageSessionRow[];
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
export type UsageErrorKind = "no_usage" | "access" | "process_failure" | "timeout" | "parse_failure";

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
