import { groupCodexSessions } from "./usageSessionFamilies";
import { useMemo, useState } from "react";
import { SearchInput } from "@/components/SearchInput";
import { Select, type SelectOption } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { SCANNED_HARNESSES } from "@/features/usage/usageAnalyticsTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { ccusageToHubHarness } from "./harnessIdentity";
import { parseModelId } from "./modelIdentity";
import { sessionTimeMs } from "./usageAggregate";
import { ledgerSessionIdFor } from "./usageTimelineModel";
import { UsageSessionItem } from "./UsageSessionItem";
import { UsageSessionSheet, type UsageSessionSheetSession } from "./UsageSessionSheet";
import {
  type UsageCurrency,
} from "./usageFormat";

type SortMode = "tokens" | "cost" | "tools" | "recent";

const SORT_OPTIONS: SelectOption<SortMode>[] = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
  { value: "tools", label: "Tool calls" },
  { value: "recent", label: "Most recent" },
];

const SESSIONS_COLLAPSED_LIMIT = 10;
const SESSIONS_EXPANDED_LIMIT = 100;

const NO_PROJECT_VALUE = "__none__";

/** The session's own project identity for the Project filter — the hub
 *  project name when known, else the anonymized label. Never the redacted/
 *  full path (same rule the search haystack below already follows). */
function projectKeyOf(session: UsageSessionRow): string | undefined {
  return session.hubProject ?? session.project?.label;
}

/** Descending by the active measure, with the session id as a final
 *  tiebreaker so two equal rows never swap places between renders. */
function compareSessions(
  a: UsageSessionRow,
  b: UsageSessionRow,
  mode: SortMode,
): number {
  if (mode === "recent") {
    const at = sessionTimeMs(a);
    const bt = sessionTimeMs(b);
    // Never `bt - at`: two undated sessions are both -Infinity, and
    // -Infinity - -Infinity is NaN.
    if (at !== bt) return bt > at ? 1 : -1;
    return a.id.localeCompare(b.id);
  }
  const av =
    mode === "cost"
      ? a.estimatedCost.usd
      : mode === "tools"
        ? (a.toolCalls ?? 0)
        : a.tokens.total;
  const bv =
    mode === "cost"
      ? b.estimatedCost.usd
      : mode === "tools"
        ? (b.toolCalls ?? 0)
        : b.tokens.total;
  return bv - av || a.id.localeCompare(b.id);
}

export interface UsageSessionsCardProps {
  /** Already range-filtered by the caller. */
  sessions: UsageSessionRow[];
  allSessions?: UsageSessionRow[];
  effectiveShowFullPaths: boolean;
  onShowFullPathsChange: (value: boolean) => void;
  hasFullFidelityData: boolean;
  busy: boolean;
  onRunFreshScan: () => void;
  currency: UsageCurrency;
  eurRate: number;
  /** Opens `/usage/session/:id` (design D14.8) — offered only on a row whose
   *  harness has a transcript scanner AND whose ledger id is derivable
   *  (`ledgerSessionIdFor`), and only once a scan has actually run. */
  onOpenTimeline?: (sessionId: string, harness: string) => void;
  /** Whether the transcript ledger has ever been scanned. Before the first
   *  scan the ledger holds no row at all, so `Timeline` is suppressed on
   *  EVERY row — a click would always land on `not_found` (design D14.8,
   *  G7). Read from `useUsageFindings()`'s `last_scan_at` by the caller.
   *  Optional, defaulting to `false` (the conservative reading — no
   *  Timeline offered) so a pre-existing caller that predates this wave
   *  (`UsageSessionSheet.test.tsx`, out of this unit's file scope) keeps
   *  compiling without a required prop it has no reason to know about. */
  scanned?: boolean;
  analysedSessions?: readonly string[];
}

/** "Sessions" — search, harness/model/sort filters, the full-paths toggle,
 *  and one `ResourceRow` per session (title or a harness+id fallback, a meta
 *  chip line, a relative-time + models description, and a right-aligned
 *  tokens/cost/tools cluster). */
export function UsageSessionsCard({
  sessions,
  allSessions = sessions,
  effectiveShowFullPaths,
  onShowFullPathsChange,
  hasFullFidelityData,
  busy,
  onRunFreshScan,
  currency,
  eurRate,
  onOpenTimeline,
  scanned = false,
  analysedSessions,
}: UsageSessionsCardProps) {
  const [harnessFilter, setHarnessFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sortMode, setSortMode] = useState<SortMode>("tokens");
  const [searchText, setSearchText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // Lifted here (not per-row) so only ONE session's drill-down sheet can be
  // open at a time — the sheet itself lives once at the bottom of this card.
  const [inspectedSession, setInspectedSession] = useState<UsageSessionSheetSession | null>(
    null,
  );
  const pins = useUsageSessionPins();

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const availableHarnesses = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions)
      map.set(session.harnessId, session.harnessName);
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [sessions]);

  const availableModels = useMemo(
    () => Array.from(new Set(sessions.flatMap((s) => s.models))).sort(),
    [sessions],
  );

  const availableProjects = useMemo(() => {
    const names = new Set<string>();
    let hasNoProject = false;
    for (const session of sessions) {
      const key = projectKeyOf(session);
      if (key) names.add(key);
      else hasNoProject = true;
    }
    return { names: Array.from(names).sort(), hasNoProject };
  }, [sessions]);

  const harnessOptions: SelectOption<string>[] = [
    { value: "all", label: "All harnesses" },
    ...availableHarnesses.map((h) => {
      const hubHarness = ccusageToHubHarness(h.id);
      return {
        value: h.id,
        label: h.name,
        leading: hubHarness ? (
          <HarnessGlyph id={hubHarness} size={14} decorative />
        ) : undefined,
      };
    }),
  ];
  const modelOptions: SelectOption<string>[] = [
    { value: "all", label: "All models" },
    // Value stays the raw ccusage id (what a row's `models`/`modelBreakdown`
    // carries); only the label reads as a display name, via the same
    // `parseModelId` a row itself renders through — a filter and a row can
    // never name the same model differently.
    ...availableModels.map((m) => ({ value: m, label: parseModelId(m).display })),
  ];
  const projectOptions: SelectOption<string>[] = [
    { value: "all", label: "All projects" },
    ...availableProjects.names.map((p) => ({ value: p, label: p })),
    ...(availableProjects.hasNoProject
      ? [{ value: NO_PROJECT_VALUE, label: "No project" }]
      : []),
  ];

  const matchingSessions = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    const selected = sessions
      .filter((s) => harnessFilter === "all" || s.harnessId === harnessFilter)
      .filter((s) => modelFilter === "all" || s.models.includes(modelFilter))
      .filter((s) => {
        if (projectFilter === "all") return true;
        const key = projectKeyOf(s);
        return projectFilter === NO_PROJECT_VALUE
          ? !key
          : key === projectFilter;
      })
      .filter((s) => {
        if (!needle) return true;
        // Never the (redacted or real) path — only ever-anonymized fields.
        const haystack = [
          s.period,
          s.title,
          s.agentRole,
          s.agentNickname,
          s.harnessName,
          s.project?.label,
          ...s.models,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });
    return groupCodexSessions(selected, allSessions)
      .sort((a, b) => compareSessions(a.session, b.session, sortMode));
  }, [
    sessions,
    allSessions,
    harnessFilter,
    modelFilter,
    projectFilter,
    searchText,
    sortMode,
  ]);

  const expandTarget = Math.min(
    matchingSessions.length,
    SESSIONS_EXPANDED_LIMIT,
  );
  const shownSessions = matchingSessions.slice(
    0,
    expanded ? expandTarget : SESSIONS_COLLAPSED_LIMIT,
  );

  return (
    <section className="usage-card usage-sessions-card" aria-label="Sessions">
      <div className="usage-section-head usage-session-head">
        <div>
          <span className="usage-kicker">Sessions</span>
          <h3>
            {sortMode === "recent" ? "Recent sessions" : "Largest sessions"}
          </h3>
        </div>
      </div>
      {/* The ONE place this screen says the aggregate/session split out
          loud — every OTHER card above just shows the numbers. */}
      <p className="usage-note usage-provenance-note">
        Sessions, projects and tool calls come from the latest scan. Token and
        cost totals come from the durable usage history.
      </p>
      <div className="usage-session-controls">
        <SearchInput
          value={searchText}
          onChange={setSearchText}
          placeholder="Search sessions…"
          screenSearch
        />
        <Select
          value={harnessFilter}
          options={harnessOptions}
          onChange={(v) => setHarnessFilter(v)}
          label="Harness"
        />
        <Select
          value={modelFilter}
          options={modelOptions}
          onChange={(v) => setModelFilter(v)}
          label="Model"
        />
        <Select
          value={projectFilter}
          options={projectOptions}
          onChange={(v) => setProjectFilter(v)}
          label="Project"
        />
        <Select
          value={sortMode}
          options={SORT_OPTIONS}
          onChange={(v) => setSortMode(v)}
          label="Sort"
        />
        <Toggle
          className="usage-toggle"
          variant="switch"
          size="sm"
          checked={effectiveShowFullPaths}
          onChange={onShowFullPathsChange}
          disabled={!hasFullFidelityData}
          ariaLabel="Show full paths"
          label="Show full paths"
        />
      </div>
      {!hasFullFidelityData ? (
        <p className="usage-note usage-fullpath-hint">
          Cached data hides full paths for privacy.{" "}
          <button
            type="button"
            className="usage-inline-link"
            disabled={busy}
            onClick={onRunFreshScan}
          >
            Run a fresh scan
          </button>{" "}
          to reveal them for this session. Full paths are available only for
          harnesses that report a project path (currently Claude Code and
          pi-agent).
        </p>
      ) : (
        <p className="usage-note usage-fullpath-hint">
          Full paths are available only for harnesses that report a project path
          (currently Claude Code and pi-agent).
        </p>
      )}
      <div className="usage-sessions" role="list">
        {shownSessions.map((family) => {
          const { session } = family;
          const rawHubHarness = ccusageToHubHarness(session.harnessId);
          // A harness with no transcript scanner at all (no hub mapping, or
          // one outside `SCANNED_HARNESSES`) wears `not analysed yet` and
          // offers no `Timeline` — the analysis is missing, never the usage
          // itself (design D14.8).
          const hasScanner = Boolean(rawHubHarness && SCANNED_HARNESSES.includes(rawHubHarness));
          const ledgerId = ledgerSessionIdFor(session);
          const analysisKey = rawHubHarness && ledgerId ? `${rawHubHarness}:${ledgerId}` : null;
          const notAnalysed = hasScanner && (analysedSessions === undefined
            ? !scanned
            : analysisKey === null || !analysedSessions.includes(analysisKey));
          // `hasScanner` stays in the gate: a scannerless harness can carry a
          // uuid-shaped id (a Codex rollout) and must never offer a Timeline
          // that would look up a ledger row no scanner ever wrote.
          const canOpenTimeline =
            hasScanner && ledgerId !== null && Boolean(onOpenTimeline) && !notAnalysed;
          return (
            <UsageSessionItem
              key={`${session.harnessId}:${session.id}`}
              session={session}
              family={family}
              pins={pins}
              ledgerId={ledgerId}
              currency={currency}
              eurRate={eurRate}
              effectiveShowFullPaths={effectiveShowFullPaths}
              hasScanner={hasScanner}
              notAnalysed={notAnalysed}
              isOpen={expandedRows.has(session.id)}
              onToggle={() => toggleRow(session.id)}
              onInspect={() => setInspectedSession(session)}
              onOpenTimeline={canOpenTimeline ? () => onOpenTimeline!(ledgerId!, rawHubHarness!) : undefined}
            />
          );
        })}
        {shownSessions.length === 0 && (
          <p className="usage-note">No sessions match the selected filters.</p>
        )}
      </div>
      {matchingSessions.length > shownSessions.length ||
      shownSessions.length < expandTarget ? (
        <div className="usage-sessions-footer">
          <span className="usage-note">
            Showing {shownSessions.length} of {matchingSessions.length} sessions
          </span>
          {shownSessions.length < expandTarget && (
            <button
              type="button"
              className="usage-show-more"
              onClick={() => setExpanded(true)}
            >
              Show {expandTarget - shownSessions.length} more
            </button>
          )}
          {expanded && matchingSessions.length > SESSIONS_EXPANDED_LIMIT && (
            <p className="usage-note">
              Showing the first {SESSIONS_EXPANDED_LIMIT} matches — narrow your
              search or filters to see the rest.
            </p>
          )}
        </div>
      ) : null}
      <UsageSessionSheet
        session={inspectedSession}
        onClose={() => setInspectedSession(null)}
      />
    </section>
  );
}
