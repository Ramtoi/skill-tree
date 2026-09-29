import { applyDisplayTokenProjection, applyNativeProjection, tokenCaptureCoverage } from "@/features/usage/usageNative";
import type { InspectionCaptureCoverage, InspectionIndexSession } from "@/features/usage/usageInspectionTypes";
import type { UsageSessionRow, UsageTokenCounts, UsageCostEstimate } from "@/features/usage/usageTypes";
import type { UsageProjectSessionRow } from "@/features/usage/usageAnalyticsTypes";
import { harnessDisplayLabel } from "@/components/harness/harnessRegistry";
import { canonicalHarnessId } from "./harnessIdentity";
import { parseUsageDate } from "./usageAggregate";
import { expandInspectionIndexRows } from "@/features/usage/useLocalAgentUsage";
import { canonicalHarness, sessionKey } from "@/features/usage/sessionIdentity";

/** A ledger-only session has a known total, but no token split or price. */
export type UsageSessionPresentation = Omit<UsageSessionRow, "tokens" | "estimatedCost"> & {
  tokens: UsageTokenCounts | { total: number };
  estimatedCost?: UsageCostEstimate;
  projectContext?: Pick<UsageProjectSessionRow, "cache_hit_ratio" | "steering_count" | "loadout_assumed">;
  tokenCaptureCoverage?: InspectionCaptureCoverage;
};

/** Apply captured own tokens at the presentation boundary. The input session
 * remains provider-owned so range, project and harness aggregates stay raw. */
export function presentUsageSession(session: UsageSessionPresentation): UsageSessionPresentation {
  const projected = applyDisplayTokenProjection(session);
  const coverage = tokenCaptureCoverage(session.inspection);
  return coverage ? { ...projected, tokenCaptureCoverage: coverage } : projected;
}

function validTimestamp(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => parseUsageDate(value ?? undefined) !== undefined);
}

export function projectSessionItems(project: string, rows: UsageProjectSessionRow[], cached: UsageSessionRow[], inspectionRows: InspectionIndexSession[] = []) {
  const inspectionByIdentity = new Map(expandInspectionIndexRows(inspectionRows).flatMap((row) => {
    const key = sessionKey(row.harness, row.session_id);
    return key ? [[key, row] as const] : [];
  }));
  const byIdentity = new Map<string, UsageSessionRow>();
  for (const session of cached) {
    const key = sessionKey(session.harnessId, session.id) ?? sessionKey(session.harnessId, session.period);
    if (key && (!session.hubProject || session.hubProject === project)) {
      byIdentity.set(key, session);
    }
  }
  return rows.map((row) => {
    const key = sessionKey(row.harness, row.session_id) ?? `${canonicalHarnessId(row.harness)}:${row.session_id}`;
    const cachedSession = byIdentity.get(key);
    const inspection = inspectionByIdentity.get(sessionKey(row.harness, row.session_id) ?? "") ?? cachedSession?.inspection;
    const projectedCached = cachedSession && inspection ? applyNativeProjection(cachedSession, inspection) : cachedSession;
    const session: UsageSessionPresentation = {
      ...(projectedCached ?? {
        id: row.session_id,
        period: row.session_id,
        harnessId: canonicalHarness(row.harness) ?? canonicalHarnessId(row.harness),
        harnessName: harnessDisplayLabel(row.harness),
        models: [],
        tokens: { total: row.tokens_total },
      }),
      // Project scope and label come from the authoritative ledger read.
      inspection,
      parentSessionId: row.parent_session_id ?? cachedSession?.parentSessionId,
      hubProject: project,
      project: { label: project, anonymized: true },
      lastActivity: validTimestamp(row.last_activity_at, cachedSession?.lastActivity),
      startedAt: validTimestamp(row.started_at, cachedSession?.startedAt),
      projectContext: row,
    };
    const projectedSession = presentUsageSession(inspection ? applyNativeProjection(session, inspection) : session);
    return { key, row, session: projectedSession, cachedSession };
  }).sort((a, b) => {
    const at = parseUsageDate(a.session.lastActivity ?? a.session.startedAt) ?? -Infinity;
    const bt = parseUsageDate(b.session.lastActivity ?? b.session.startedAt) ?? -Infinity;
    return at === bt ? a.key.localeCompare(b.key) : at > bt ? -1 : 1;
  });
}
