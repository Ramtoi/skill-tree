import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { SearchInput } from "@/components/SearchInput";
import { Select } from "@/components/Select";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { SCANNED_HARNESSES } from "@/features/usage/usageAnalyticsTypes";
import { UsageSessionItem } from "./UsageSessionItem";
import { ccusageToHubHarness } from "./harnessIdentity";
import { parseModelId } from "./modelIdentity";
import { sessionTimeMs } from "./usageAggregate";
import { ledgerSessionIdFor } from "./usageTimelineModel";
import type { UsagePeriodKind } from "./usagePeriod";
import type { UsageCurrency } from "./usageFormat";

interface Props {
  kind: UsagePeriodKind;
  sessions: UsageSessionRow[];
  available: boolean;
  currency: UsageCurrency;
  eurRate: number;
  onInspect: (session: UsageSessionRow) => void;
}

export function UsagePeriodSessions({ kind, sessions, available, currency, eurRate, onInspect }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(10);
  const pins = useUsageSessionPins();
  const matching = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return sessions.filter((session) => [session.title, session.hubProject, session.project?.label,
      session.harnessName, ...session.models.map((model) => parseModelId(model).display)]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle))
      .sort((a, b) => {
        const av = sort === "cost" ? a.estimatedCost.usd : sessionTimeMs(a);
        const bv = sort === "cost" ? b.estimatedCost.usd : sessionTimeMs(b);
        return av === bv ? a.id.localeCompare(b.id) : av > bv ? -1 : 1;
      });
  }, [sessions, search, sort]);
  return <section className="usage-day-sessions" aria-label={`Sessions last active in this ${kind}`}>
    <div className="usage-day-section-head"><h3>Sessions {available && <span className="usage-day-count">{sessions.length}</span>}</h3><span>Last active {kind === "day" ? "on this day" : `in this ${kind}`} · UTC</span></div>
    <p className="usage-note">Whole-session totals may include other days. Tokens and cost above come from daily usage.</p>
    {!available ? <p className="usage-day-unavailable">Session details are unavailable for this {kind}.</p> : <>
      {sessions.length > 0 && <div className="usage-day-session-controls">
        <SearchInput value={search} onChange={(value) => { setSearch(value); setLimit(10); }} placeholder={`Search this ${kind}'s sessions…`} trailing={<></>} inputProps={{ "aria-label": `Search this ${kind}'s sessions` }} />
        <Select label="Sort sessions" value={sort} onChange={setSort} options={[{ value: "recent", label: "Most recent" }, { value: "cost", label: "Highest cost" }]} />
      </div>}
      <div role="list" className="usage-day-session-list">{matching.slice(0, limit).map((session) => {
        const harness = ccusageToHubHarness(session.harnessId);
        const key = `${session.harnessId}:${session.id}`;
        return <UsageSessionItem key={key} session={session} pins={pins} ledgerId={ledgerSessionIdFor(session)}
          currency={currency} eurRate={eurRate} hasScanner={SCANNED_HARNESSES.includes(harness ?? "")}
          notAnalysed={!session.inspection} isOpen={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)}
          onInspect={() => onInspect(session)} />;
      })}</div>
      {matching.length === 0 && <p className="usage-day-unavailable">{search ? "No sessions match your search." : `No sessions in the latest scan were last active in this ${kind}.`}</p>}
      {matching.length > limit && <Button size="sm" onClick={() => setLimit(limit + 50)}>Show more sessions · {matching.length - limit} remaining</Button>}
    </>}
  </section>;
}
