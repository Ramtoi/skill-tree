import type {
  UsageFinding,
  UsageProjectPayload,
} from "@/features/usage/usageAnalyticsTypes";
import { idleSkillsOf } from "@/features/usage/usageAnalyticsTypes";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";

export const USAGE_STALE_DAYS = 7;

export interface UsageSummary {
  scanned: boolean;
  scanAgeDays: number | null;
  sessions: number;
  cacheHitRatio: number | null;
  idle: number;
  loadoutTokens: number | null;
  observedTokens: number | null;
  analysedHarness: string | null;
}

export function idleSkills(payload: UsageProjectPayload | undefined): string[] {
  const finding = payload?.findings.find((item: UsageFinding) => item.kind === "idle");
  return finding ? idleSkillsOf(finding) : [];
}

export function scanAgeDays(lastScanAt: string | null, now: Date = new Date()): number | null {
  if (!lastScanAt) return null;
  const then = new Date(lastScanAt).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

export function usageSummary(
  payload: UsageProjectPayload | undefined,
  tokens: HarnessFootprintTokens | null,
): UsageSummary | null {
  if (!payload) return null;
  const harness = tokens?.harness ?? payload.harnesses.find((name) => name === "claude-code") ?? null;
  const observed = harness ? payload.footprint[harness]?.observed : undefined;
  return {
    scanned: payload.last_scan_at !== null,
    scanAgeDays: scanAgeDays(payload.last_scan_at),
    sessions: payload.outcomes.sessions,
    cacheHitRatio: payload.outcomes.cache_hit_ratio,
    idle: payload.utilization.filter((row) => row.idle).length,
    loadoutTokens: tokens?.total ?? null,
    observedTokens: observed ?? null,
    analysedHarness: observed !== undefined && observed !== null ? harness : null,
  };
}

function relativeAge(lastScanAt: string, now: Date): string {
  const age = Math.max(0, now.getTime() - new Date(lastScanAt).getTime());
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function usageAsOfLine(lastScanAt: string | null, now: Date = new Date()): string {
  if (!lastScanAt) return "usage never scanned";
  const age = scanAgeDays(lastScanAt, now);
  const suffix = age !== null && age > USAGE_STALE_DAYS ? " · may be out of date" : "";
  return `usage as of ${relativeAge(lastScanAt, now)}${suffix}`;
}
