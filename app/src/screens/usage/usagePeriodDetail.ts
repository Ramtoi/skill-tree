import type { UsageDailyPoint, UsageSessionRow } from "@/features/usage/usageTypes";
import { scopeFromDaily, sessionTimeMs } from "./usageAggregate";
import { isUnpriced } from "./pricing";
import { isUsageDayKey, type UsagePeriod } from "./usagePeriod";

/** Inputs are already harness-scoped, but deliberately not range-scoped. */
export function usagePeriodDetail(period: UsagePeriod, daily: UsageDailyPoint[], sessions: UsageSessionRow[]) {
  const contains = (date: string) => isUsageDayKey(date) && date >= period.since && date <= period.until;
  const points = daily.filter((point) => contains(point.date.slice(0, 10)));
  const summary = scopeFromDaily(points);
  const rows = sessions.filter((session) => {
    const time = sessionTimeMs(session);
    return Number.isFinite(time) && contains(new Date(time).toISOString().slice(0, 10));
  });
  const agents = points.flatMap((point) => point.harnesses);
  const knownCost = agents.some((agent) => agent.costKnown !== false);
  const unknownCost = summary.coverage.costUnknownDays > 0;
  const models = summary.models.map((model) => ({
    ...model,
    costPartial: agents.some((agent) => (agent.models ?? []).some((entry) =>
      entry.modelName === model.modelName && (agent.costKnown === false || entry.costKnown === false))),
  }));
  return {
    ...summary,
    models,
    sessions: rows,
    costUnavailable: unknownCost && !knownCost,
    costPartial: (unknownCost && knownCost) || models.some(isUnpriced),
    splitUnavailable: summary.coverage.splitUnknownDays > 0,
    historyOnly: points.length > 0 && points.every((point) => point.provenance === "backfilled") && rows.length === 0,
  };
}
