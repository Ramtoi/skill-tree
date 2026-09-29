import type { InspectionCaptureCoverage, InspectionIndexSession, InspectionNativeFacts } from "./usageInspectionTypes";
import type { UsageSessionRow } from "./usageTypes";

type DisplayTokens = UsageSessionRow["tokens"] | { total: number };

/** Return canonical own tokens only when the host explicitly proves complete
 * coverage. Provider totals remain the source for all aggregates. */
export function canonicalOwnTokens(inspection: InspectionIndexSession | undefined): UsageSessionRow["tokens"] | undefined {
  if (inspection?.summary_provenance !== "canonical" || inspection.capture_coverage !== "complete") return undefined;
  const tokens = inspection.scopes.own.tokens;
  const values = [tokens.input, tokens.output, tokens.cache_creation, tokens.cache_read, tokens.total];
  if (tokens.status !== "available" || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return undefined;
  return { input: tokens.input!, output: tokens.output!, cacheCreation: tokens.cache_creation!, cacheRead: tokens.cache_read!, total: tokens.total! };
}

export function tokenCaptureCoverage(inspection: InspectionIndexSession | undefined): InspectionCaptureCoverage | undefined {
  const coverage = inspection?.capture_coverage;
  if (!coverage) return undefined;
  // A complete legacy import, or a malformed canonical scope, still falls
  // back to provider totals and must carry a visible coverage signal.
  return coverage === "complete" && !canonicalOwnTokens(inspection) ? "unavailable" : coverage;
}

export function applyDisplayTokenProjection<T extends { tokens: DisplayTokens; inspection?: InspectionIndexSession }>(session: T): T {
  const tokens = canonicalOwnTokens(session.inspection);
  return tokens ? { ...session, tokens } : session;
}

/** A retained partial count is a lower bound, never a complete total. */
export function hasCompleteToolCount(session: Pick<UsageSessionRow, "toolCalls" | "inspection">): boolean {
  const native = session.inspection?.native?.own;
  return session.toolCalls !== undefined && (!native || native.field_status.tool_calls === "observed");
}

/** Overlay captured native facts while keeping unavailable fields honest. */
export function applyNativeProjection<T extends { inspection?: InspectionIndexSession; toolCalls?: number; toolBreakdown?: UsageSessionRow["toolBreakdown"]; linesAdded?: number; linesRemoved?: number; durationMs?: number; branch?: string }>(session: T, inspection: InspectionIndexSession): T {
  const native = inspection.native?.own;
  if (!native) return { ...session, inspection };
  const result = { ...session, inspection };
  const available = (field: keyof InspectionNativeFacts["field_status"]) => native.field_status[field] === "observed" || ((field === "tool_calls" || field === "tool_breakdown") && native.field_status[field] === "partial");
  if (available("tool_calls")) result.toolCalls = native.tool_calls ?? undefined;
  else delete result.toolCalls;
  if (available("tool_breakdown")) result.toolBreakdown = native.tool_breakdown;
  else delete result.toolBreakdown;
  if (available("lines_added")) result.linesAdded = native.lines_added ?? undefined;
  else delete result.linesAdded;
  if (available("lines_removed")) result.linesRemoved = native.lines_removed ?? undefined;
  else delete result.linesRemoved;
  if (available("duration_ms")) result.durationMs = native.duration_ms ?? undefined;
  else delete result.durationMs;
  if (available("branch")) result.branch = native.branch ?? undefined;
  else delete result.branch;
  return result;
}
