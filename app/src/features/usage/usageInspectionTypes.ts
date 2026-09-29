export type InspectionStatus = "available" | "partial" | "unavailable";
export type EvidenceStatus = "complete" | "partial" | "unavailable";
export type InspectionSummaryProvenance = "canonical" | "legacy_import";
export type InspectionCaptureCoverage = "complete" | "partial" | "unavailable";

export type InspectionTokens = {
  input: number | null;
  output: number | null;
  cache_creation: number | null;
  cache_read: number | null;
  total: number | null;
  status: InspectionStatus;
};

export type InspectionCost = {
  currency: string;
  value: number | null;
  status: "known" | "partial" | "unpriced" | "unavailable";
};

export type InspectionTiming = {
  first_at: string | null;
  last_at: string | null;
  active_ms: number | null;
  status: "observed" | "unavailable";
};

export type InspectionScope = {
  tokens: InspectionTokens;
  cost: InspectionCost;
  timing: InspectionTiming;
};

export type InspectionIndexPr = {
  repository_id: string;
  number: number;
  url: string;
  relationship: "created" | "changed" | "reviewed" | "associated";
  last_evidenced_at: string | null;
};

export type InspectionNativeFacts = {
  lines_added: number | null;
  lines_removed: number | null;
  duration_ms: number | null;
  branch: string | null;
  tool_calls: number | null;
  tool_breakdown: Array<{ name: string; count: number }>;
  status: "observed" | "partial" | "unavailable";
  field_status: Record<"lines_added" | "lines_removed" | "duration_ms" | "branch" | "tool_calls" | "tool_breakdown", "observed" | "partial" | "unavailable">;
};

export type InspectionNativeProjection = {
  own: InspectionNativeFacts;
  children: InspectionNativeFacts;
  subtree: InspectionNativeFacts;
};

export type InspectionIndexSession = {
  [key: string]: unknown;
  harness: string;
  session_id: string;
  root_session_id: string;
  run_id: string;
  status: InspectionStatus;
  /** Host-owned facts. Completeness is explicit; token values alone are not
   * evidence that a canonical summary covers the full capture. */
  summary_provenance?: InspectionSummaryProvenance | null;
  capture_coverage?: InspectionCaptureCoverage | null;
  scopes: { own: InspectionScope; children: InspectionScope; subtree: InspectionScope };
  latest_pr: InspectionIndexPr | null;
  additional_pr_count: number;
  /** Optional index-provided links for the row-level PR picker. */
  prs?: InspectionIndexPr[];
  pinned: boolean;
  /** Root rows may advertise captured descendant runs without duplicating
   *  each agent as a top-level index session. */
  native?: InspectionNativeProjection;
  agents?: Array<{ session_id: string; run_id: string; status?: InspectionStatus; summary_provenance?: InspectionSummaryProvenance | null; capture_coverage?: InspectionCaptureCoverage | null; scopes?: { own: InspectionScope; children: InspectionScope; subtree: InspectionScope }; native?: InspectionNativeProjection; latest_pr?: InspectionIndexPr | null; prs?: InspectionIndexPr[]; additional_pr_count?: number }>;
};

export type InspectionIndexPayload = {
  ok: boolean;
  schema_version?: number;
  sessions?: InspectionIndexSession[];
  evidence?: { status: EvidenceStatus; notices: string[] };
  reason?: string;
};

export type InspectionRun = {
  id: string;
  parent_id: string | null;
  depth: number;
  label: string;
  role: { value: string | null; status: "observed" | "unavailable" };
  models: string[];
  start: { at: string | null; status: "observed" | "unavailable" };
  activity_intervals: Array<{ start: string; end: string; status?: "observed" | "inferred" | "unavailable" }>;
  lifespan: { start: string | null; end: string | null; status: "observed" | "unavailable" };
  worktree: { label: string | null; status: "unknown" | "observed"; locations?: Array<{ id: string; label: string; basis: "command_workdir" }> };
  scopes: { own: InspectionScope; children: InspectionScope; subtree: InspectionScope };
  tool_calls: number;
  edits: number;
  evidence: string[];
};

export type InspectionToolPart = {
  kind: string;
  status: "available" | "truncated" | "external_file" | "unsupported" | "unavailable" | "pruned";
  content_type: string;
  bytes: number;
  body_id?: string;
  retained_version?: boolean;
  source_revision?: string | null;
  /** ISO date. Set once retention detaches this part's body reference. */
  pruned_at?: string | null;
};

export type InspectionToolCall = {
  id: string;
  run_id: string;
  ordinal: number;
  at: string | null;
  tool: { name: string; kind: string };
  operation: { summary: string | null; signature: string | null; status: "available" | "unavailable" };
  execution: "pending" | "acknowledged" | "completed" | "failed" | "unavailable";
  input_parts: InspectionToolPart[];
  result_parts: InspectionToolPart[];
  source_epoch: string;
  evidence: string[];
};

export type InspectionChange = {
  id: string;
  kind: "session_edit" | "tool_patch" | "runtime_patch" | "worktree_patch" | "current_snapshot" | "pr_change";
  source: string;
  repository_id: string | null;
  revision_id: string | null;
  base_id: string | null;
  merge_base_id: string | null;
  captured_at: string | null;
  files: string[];
  patch?: InspectionToolPart | null;
  attribution: "confirmed" | "attempted" | "captured" | "current" | "associated" | "unavailable";
};

export type InspectionTimeline = {
  origin: string | null;
  events: Array<{ id?: string; run_id?: string; at: string | null; kind: string; status?: string; label?: string }>;
  gaps: Array<{ start: string; end: string; duration_ms?: number }>;
  wait_intervals?: Array<{ start: string; end: string | null; run_id?: string | null; status?: "observed" | "inferred" | "unavailable" }>;
  relationship_edges: Array<{ from_run_id: string; to_run_id: string | null; kind: string; at?: string | null; status?: string }>;
};

export type InspectionPr = InspectionIndexPr & { first_seen: string | null };

export type InspectionPayload = {
  ok: boolean;
  schema_version?: number;
  session?: { key: { harness: string; session_id: string }; status: InspectionStatus; source_epochs: Array<{ id: string; status: string; captured_at: string }>;
    summary: { own: InspectionScope; children: InspectionScope; subtree: InspectionScope } };
  runs?: InspectionRun[];
  timeline?: InspectionTimeline;
  tool_calls?: { items: InspectionToolCall[]; next_after: string | null; total: number; status: "complete" | "partial" };
  changes?: InspectionChange[];
  prs?: InspectionPr[];
  pins?: InspectionPin[];
  evidence?: { status: EvidenceStatus; notices: string[] };
  reason?: string;
};

export type InspectionBodyPayload = {
  ok: boolean;
  body_id?: string;
  status?: InspectionToolPart["status"];
  content_type?: string;
  total_bytes?: number;
  chunks?: Array<{ seq: number; bytes: number; base64: string }>;
  next_after_chunk?: number | null;
  /** Retrieval can fail while the retained source body remains complete. */
  retrieval_status?: "partial" | "failed";
  retrieval_error?: string;
  reason?: string;
  /** Set alongside reason: "pruned", including when a previously available
   *  body was pruned after the panel requested it. */
  pruned_at?: string | null;
};

export type InspectionPin = {
  harness: string;
  session_id: string;
  root_session_id: string;
  run_id: string | null;
  root_type?: "session" | "agent";
  breadcrumb?: { label: string; status: "available" | "unavailable" }[];
  status?: InspectionStatus;
  scopes?: { own: InspectionScope; subtree: InspectionScope };
  pinned?: boolean;
};

export type InspectionPinsPayload = {
  ok: boolean;
  schema_version?: number;
  items?: InspectionPin[];
  next_after?: string | null;
  evidence?: { status: EvidenceStatus; notices: string[] };
  reason?: string;
};

export type PinMutationPayload = InspectionPinsPayload & { action?: "add" | "remove"; pin?: Pick<InspectionPin, "harness" | "session_id" | "root_session_id" | "run_id"> };

export const unavailableReason = (reason?: string) =>
  reason === "not_captured" ? "This session has not been captured yet." :
  reason === "inspection_corrupt" ? "Captured inspection data is unavailable because its local store is corrupt." :
  reason === "inspection_version_unsupported" ? "This captured inspection needs a newer Skill Tree version." :
  reason === "pruned" ? "This captured body was pruned and cannot be recovered." :
  "Captured inspection data is unavailable.";
