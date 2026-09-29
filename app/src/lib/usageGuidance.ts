import type { UsageLoadoutRow } from "@/features/usage/usageAnalyticsTypes";
import { estimateTokens } from "@/lib/estimateTokens";

export interface ProspectiveSkillLineInput {
  name: string;
  description: string;
  projectSkillsDir: string;
}

export function formatProspectiveSkillLine({
  name,
  description,
  projectSkillsDir,
}: ProspectiveSkillLineInput): string {
  return `${name}: ${description} (${projectSkillsDir}/${name})`;
}

export function estimateGuidanceTokens(text: string): number {
  return estimateTokens(text);
}

export const tokensOf = estimateGuidanceTokens;

export function isFreshUsage(lastScanAt: string | null | undefined, now: number): boolean {
  if (!lastScanAt) return false;
  const age = now - Date.parse(lastScanAt);
  return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
}

export function groupLoadoutRows(rows: UsageLoadoutRow[]): Record<string, UsageLoadoutRow[]> {
  return rows.reduce<Record<string, UsageLoadoutRow[]>>((groups, row) => {
    (groups[row.harness] ??= []).push(row);
    return groups;
  }, {});
}

export function dailySessionCounts(
  sessions: Array<{ started_at: string }>,
): Record<string, number> {
  return sessions.reduce<Record<string, number>>((counts, session) => {
    const day = session.started_at.slice(0, 10);
    counts[day] = (counts[day] ?? 0) + 1;
    return counts;
  }, {});
}

export function changedLoadoutTicks(rows: UsageLoadoutRow[]): UsageLoadoutRow[] {
  return rows.filter((row) => row.kind === "changed");
}
