import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { fromNav, usageBackTarget } from "@/lib/backTarget";
import { ledgerSessionIdFor } from "./usageTimelineModel";
import { periodFromKey, type UsagePeriod, type UsagePeriodKind } from "./usagePeriod";

const kinds: UsagePeriodKind[] = ["day", "week", "month"];
function readPeriod(query: string): UsagePeriod | null {
  const params = new URLSearchParams(query);
  const selected = kinds.filter(kind => params.has(kind));
  return selected.length === 1 ? periodFromKey(selected[0], params.get(selected[0])!) : null;
}
function withPeriod(previous: URLSearchParams, period: UsagePeriod | null) {
  const next = new URLSearchParams(previous);
  kinds.forEach(kind => next.delete(kind));
  if (period) next.set(period.kind, period.key);
  return next;
}

/** Keep controls immediate while the router commits the shareable period URL. */
export function useUsagePeriodSelection() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodQuery = new URLSearchParams([...searchParams].filter(([key]) => kinds.some(kind => kind === key))).toString();
  const [selectedPeriod, setPeriod] = useState<UsagePeriod | null>(() => readPeriod(periodQuery));
  useEffect(() => { setPeriod(readPeriod(periodQuery)); }, [periodQuery]);
  const setSelectedPeriod = (period: UsagePeriod | null) => {
    setPeriod(period);
    setSearchParams(previous => withPeriod(previous, period), { replace: true });
  };
  const selectPeriodKey = (key: string, kind: UsagePeriodKind) => setSelectedPeriod(periodFromKey(kind, key));
  const inspectPeriodSession = (session: UsageSessionRow) => {
    const id = session.inspection?.session_id ?? ledgerSessionIdFor(session) ?? session.id;
    const harness = session.inspection?.harness ?? (session.harnessId === "claude" ? "claude-code" : session.harnessId);
    navigate(`/usage/session/${encodeURIComponent(id)}?harness=${encodeURIComponent(harness)}`,
      fromNav({ ...usageBackTarget(), path: `/usage?${withPeriod(searchParams, selectedPeriod).toString()}` }));
  };
  return { selectedPeriod, setSelectedPeriod, selectPeriodKey, inspectPeriodSession };
}
