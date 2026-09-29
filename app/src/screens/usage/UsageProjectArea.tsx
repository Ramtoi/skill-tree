import { ProjectContextEstimate } from "@/screens/project/ProjectContextPanel";
import { useRegistry } from "@/hooks/useRegistry";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { groupCodexSessions } from "./usageSessionFamilies";
import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { useLocalAgentUsage } from "@/features/usage/useLocalAgentUsage";
import { SCANNED_HARNESSES } from "@/features/usage/usageAnalyticsTypes";
import { UsageSessionItem } from "./UsageSessionItem";
import { UsageSessionSheet, type UsageSessionSheetSession } from "./UsageSessionSheet";
import { projectSessionItems } from "./usageSessionPresentation";
import { useUsagePrefs } from "./useUsagePrefs";
import { useEffect, useRef, useId, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CompositionBar, type Segment } from "@/components/charts/CompositionBar";
import { sequentialSteps } from "@/components/charts/chartColors";
import { HorizontalBarList, type BarRow } from "@/components/charts/HorizontalBarList";
import { EmptyState } from "@/components/EmptyState";
import { Field, MetaGrid } from "@/components/Field";
import { InfoBanner } from "@/components/InfoBanner";
import { StatCard } from "@/components/StatCard";
import { UsageActivityCard } from "./UsageActivityCard";
import { StackedColumnChart, type Series } from "@/components/charts/StackedColumnChart";
import { identityColor } from "@/components/charts/chartColors";
import type {
  UsageActivityCounts,
  UsageActivityCountsNullable,
  UsageFinding,
  UsageOutcomes,
  UsageProjectPayload,
  UsageLoadoutRow,
  UsageUtilizationRow,
  UsageWindow,
} from "@/features/usage/usageAnalyticsTypes";
import { useUsageFootprint, useUsageLoadouts, useUsageProject, useUsageProjectTimeline } from "@/hooks/useUsageAnalytics";
import { fromNav, projectAreaBackTarget, usageProjectBackTarget, type BackTarget } from "@/lib/backTarget";
import { Disclosure } from "@/components/Disclosure";
import { Button } from "@/components/Button";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessDisplayLabel } from "@/components/harness/harnessRegistry";
import { useFootprintTokensByHarness } from "@/lib/footprintTokens";
import { plural } from "@/lib/plural";
import { ACTIVITY_COLOR_INDEX, ActivityBar } from "./ActivityBar";
import { isReplanRequired, ScanButton, useLastScanResult } from "./UsageScanAction";
import { UsageScanRecovery } from "./UsageScanRecovery";
import { formatCompact, formatCount, formatPercent, formatRelativeTime } from "./usageFormat";
import { buildProjectSessionColumns } from "./usageProjectTimeline";
import { UsagePeaksGrid } from "./UsagePeaksGrid";
import { harnessColorIndex, orderHarnessIds } from "./harnessIdentity";
import { UsageWindowSelector } from "./UsageWindowSelector";

export interface UsageProjectAreaProps {
  name: string;
  window: UsageWindow;
  /** Kept for signature parity with wave 3's re-host (design D14.6/D14.12
   *  — the props stay at exactly four so the component never has to fork).
   *  The window SELECTOR renders in the route's `ScreenHeader` only
   *  (`UsageWindowSelector`, G15) — this component never reads or calls it. */
  onWindowChange: (w: UsageWindow) => void;
  /** How a Sessions row opens a timeline. The `/usage` route navigates to
   *  `/usage/session/:id`; wave 3's project chrome passes its own. */
  onOpenSession: (sessionId: string, harness: string) => void;
}

/** A byte magnitude for the Footprint band — "128 KB", "3.4 MB". Local to
 *  this component: `usageFormat.ts`'s `formatCompact` already spends the
 *  "B" suffix on the billions unit, so reusing it here would collide with
 *  the bytes unit ("29.5B" tokens vs. "29.5B" bytes read as the same
 *  string for two different magnitudes). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded = unitIndex === 0 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toString();
  return `${rounded} ${units[unitIndex]}`;
}

/** A [0,1] fractional share OR a plain integer count — `outcomes.activity`
 *  and `median_all_projects.activity` are both `UsageActivityCounts`, but
 *  design D14.6 does not say which shape this project payload carries, so
 *  the note formatter must not assume either (mirrors `ActivityBar.tsx`'s
 *  own `formatActivityValue`, which is not exported). */
function formatActivityValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

const ACTIVITY_ORDER_BY_INDEX = (Object.entries(ACTIVITY_COLOR_INDEX) as [keyof UsageActivityCounts, number][]).sort(
  (a, b) => a[1] - b[1],
);

function medianActivityNote(median: UsageActivityCountsNullable): ReactNode {
  const clauses = ACTIVITY_ORDER_BY_INDEX.filter(([cls]) => (median[cls] ?? 0) > 0).map(
    ([cls]) => `${cls} ${formatActivityValue(median[cls] ?? 0)}`,
  );
  return (
    <span className="usage-note">
      All-projects median — {clauses.length > 0 ? clauses.join(" · ") : "no activity recorded"}
    </span>
  );
}

function formatNullablePercent(value: number | null): string {
  return value == null ? "—" : formatPercent(value);
}

function formatNullableCount(value: number | null): string {
  return value == null ? "—" : formatCount(value);
}

function formatNullableSteering(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function nonNullActivity(activity: UsageActivityCountsNullable): UsageActivityCounts {
  return Object.fromEntries(Object.entries(activity).map(([key, value]) => [key, value ?? 0])) as UsageActivityCounts;
}

function FootprintBand({
  payload,
  tokenizedByHarness,
  harness,
}: {
  payload: UsageProjectPayload;
  tokenizedByHarness: ReturnType<typeof useFootprintTokensByHarness>;
  harness: string | null;
}) {
  const footprint = payload.footprint;
  const entries = Object.entries(footprint);
  if (entries.length === 0) return null;
  return (
    <section className="usage-card usage-project-band" aria-label="Footprint">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Footprint</span>
          {harness && <span className="usage-scope-note">all harnesses</span>}
          <h3>Prompt size per harness</h3>
        </div>
      </div>
      {entries.map(([harness, h]) => {
        const steps = sequentialSteps(Math.max(h.parts.length, 1));
        const segments: Segment[] = h.parts.map((part, i) => ({
          id: part.part,
          label: part.label,
          value: part.bytes,
          color: steps[i],
        }));
        return (
          <div key={harness} className="usage-footprint-harness">
            <div className="usage-footprint-harness-head">
              <span className="usage-footprint-harness-name">
                <HarnessGlyph id={harness} label={harnessDisplayLabel(harness)} size={16} decorative />
                {harnessDisplayLabel(harness)}
              </span>
              <span className="usage-footprint-harness-observed">
                Observed bytes: {h.observed == null ? "not analysed yet" : formatBytes(h.observed)}
              </span>
            </div>
            {segments.length > 0 && (
              <CompositionBar
                segments={segments}
                format={formatBytes}
                ariaLabel={`${harness} prompt composition`}
              />
            )}
            <p className="usage-note usage-footprint-calculated">
              {h.unknown.length > 0 ? "Known prompt size" : "Calculated prompt size"}: {tokenizedByHarness?.[harness]
                ? `${formatCompact(tokenizedByHarness[harness].total)} ${plural(tokenizedByHarness[harness].total, "token")}`
                : "unavailable"}
            </p>
            {h.unknown.length > 0 && (
              <Disclosure summary={`Unknown contributions (${h.unknown.length})`}>
                <div className="usage-footprint-unknown-list">
                  {h.unknown.map((entry) => (
                    <p key={`${entry.part}-${entry.label}`} className="usage-note usage-footprint-unknown">
                      {entry.label} — size unknown. {entry.hint && <code>{entry.hint}</code>}
                    </p>
                  ))}
                </div>
              </Disclosure>
            )}
          </div>
        );
      })}
    </section>
  );
}

function UtilizationBand({ rows, harness, showAll, onToggle, back, skillNames }: {
  rows: UsageUtilizationRow[];
  harness: string | null;
  showAll: boolean;
  onToggle: () => void;
  back: BackTarget;
  skillNames: Set<string>;
}) {
  const listId = useId();
  const sortedRows = [...rows].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, 8);
  const barRows: BarRow[] = visibleRows.map((row) => ({
    key: row.key,
    label: skillNames.has(row.key)
      ? <Link className="usage-inline-link" to={`/skill/${encodeURIComponent(row.key)}`} {...fromNav(back)} title={row.key}>{row.key}</Link>
      : row.key,
    sub: `${formatCount(row.you)} you · ${formatCount(row.model)} model · ${formatCount(row.script)} script · ${
      row.last_used_at ? formatRelativeTime(row.last_used_at) : "never used"
    }`,
    value: row.count,
    display: formatCount(row.count),
  }));
  return (
    <section className="usage-card usage-project-band" aria-label="Utilization">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Utilization</span>
          {harness && <span className="usage-scope-note">all harnesses</span>}
          <h3>Skill usage</h3>
        </div>
      </div>
      <div id={listId}>
        <HorizontalBarList rows={barRows} ariaLabel="Skill utilization" />
      </div>
      {rows.length > 8 && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={onToggle}
        >
          {showAll ? "Show fewer" : `Show all ${rows.length} skills`}
        </Button>
      )}
    </section>
  );
}

function OutcomesBand({
  outcomes,
  harness,
}: {
  outcomes: UsageOutcomes;
  harness: string | null;
}) {
  return (
    <section className="usage-card usage-project-band" aria-label="Outcomes">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Outcomes</span>
          {harness && <span className="usage-scope-note">all harnesses</span>}
          <h3>What happened</h3>
        </div>
      </div>
      <div className="tile-row usage-kpis usage-kpis--six">
        <StatCard label="Sessions" value={formatCount(outcomes.sessions)} />
        <StatCard label="Tokens / session" value={outcomes.tokens_per_session == null ? "—" : formatCompact(outcomes.tokens_per_session)} />
        <StatCard label="Cache hit" value={formatNullablePercent(outcomes.cache_hit_ratio)} />
        <StatCard label="Steering / session" value={formatNullableSteering(outcomes.steering_per_session)} />
        <StatCard
          label="Verified edits"
          value={formatNullablePercent(outcomes.verified_edit_session_ratio)}
          sub={`${formatCount(outcomes.editing_sessions)} editing · ${formatCount(outcomes.unverified_editing_sessions)} unverified`}
        />
        <StatCard
          label="Files read / edited"
          value={`${formatNullableCount(outcomes.files_read_median)} / ${formatNullableCount(outcomes.files_edited_median)}`}
          sub={
            outcomes.tracked_files != null
              ? `median, of ${formatCount(outcomes.tracked_files)} tracked`
              : "median per session"
          }
        />
      </div>
      <ActivityBar
        activity={nonNullActivity(outcomes.activity)}
        ariaLabel="Activity mix"
        note={
          <>
            <span className="usage-note">
              Thinking share {formatNullablePercent(outcomes.thinking_text_share)} (approximate)
            </span>
            <span className="usage-note" aria-hidden="true">
              {" · "}
            </span>
            {medianActivityNote(outcomes.median_all_projects.activity)}
          </>
        }
      />
    </section>
  );
}

function FindingsBand({
  findings,
  findingsWindow,
  tokenizedByHarness,
  harness,
}: {
  findings: UsageFinding[];
  findingsWindow: number;
  tokenizedByHarness: ReturnType<typeof useFootprintTokensByHarness>;
  harness: string | null;
}) {
  const navigate = useNavigate();
  const tokensFor = (skill: string): string => {
    for (const harness of Object.values(tokenizedByHarness ?? {})) {
      const value = harness?.bySkill.get(skill);
      if (value != null) return `~${formatCompact(value)} tokens every session`;
    }
    return "…";
  };
  return (
    <section className="usage-card usage-project-band" aria-label="Findings">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Findings</span>
          {harness && <span className="usage-scope-note">all harnesses</span>}
          <h3>What to look at</h3>
        </div>
        <p className="usage-note">fixed at {findingsWindow} days</p>
      </div>
      {findings.length === 0 ? (
        <p className="usage-note">No findings in this window.</p>
      ) : (
        findings.map((finding) => (
          <div key={finding.id} className="usage-finding-card">
            <p className="usage-finding-observation">{finding.observation}</p>
            <Disclosure summary="Why">
              <div className="usage-finding-evidence">
                <MetaGrid>
                  {Object.entries(finding.numbers)
                    .filter(([key]) => key !== "bytes_per_skill")
                    .map(([key, value]) => (
                      <Field key={key} label={key.replace(/_/g, " ")}>
                        <span>{key === "share" && typeof value === "number" ? formatNullablePercent(value) : String(value)}</span>
                      </Field>
                    ))}
                </MetaGrid>
                {finding.kind === "idle" && (
                  <ul className="usage-finding-idle-evidence">
                    {((Array.isArray(finding.numbers.skills) ? finding.numbers.skills : []) as string[]).map((skill) => (
                      <li key={skill}>{skill}: {tokensFor(skill)}</li>
                    ))}
                  </ul>
                )}
                {finding.moves.length > 0 && (
                  <ul className="usage-finding-moves">
                    {finding.moves.map((move, i) => <li key={i}>{move.label}</li>)}
                  </ul>
                )}
              </div>
            </Disclosure>
            <a
              href={`/project/${encodeURIComponent(finding.review.project)}?tab=${encodeURIComponent(finding.review.area)}&review=${encodeURIComponent(finding.id)}`}
              className="usage-finding-review"
              onClick={(event) => {
                event.preventDefault();
                navigate(event.currentTarget.getAttribute("href") ?? "", fromNav(projectAreaBackTarget(finding.review.project, "usage")));
              }}
            >
              Review
            </a>
          </div>
        ))
      )}
    </section>
  );
}

function SessionsBand({
  payload,
  onOpenSession,
  harness,
}: {
  payload: UsageProjectPayload;
  onOpenSession: (sessionId: string, harness: string) => void;
  harness: string | null;
}) {
  const { snapshot, inspectionIndex } = useLocalAgentUsage({ includeInspection: true });
  const pins = useUsageSessionPins();
  const { currency, eurRate } = useUsagePrefs();
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [inspectedSession, setInspectedSession] = useState<UsageSessionSheetSession | null>(null);
  const sessions = useMemo(() => projectSessionItems(payload.project,
    payload.sessions.filter((session) => harness === null || session.harness === harness),
    snapshot?.sessions ?? [], inspectionIndex?.sessions,
  ), [payload.project, payload.sessions, harness, snapshot, inspectionIndex?.sessions]);
  const families = useMemo(() => groupCodexSessions(sessions.map((item) => item.session), [...(snapshot?.sessions ?? []), ...sessions.map((item) => item.session)]), [sessions, snapshot?.sessions]);
  const toggleRow = (key: string) => setOpenRows((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <section className="usage-card usage-project-band" aria-label="Sessions">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Sessions</span>
          {harness && <span className="usage-scope-note">{harnessDisplayLabel(harness)}</span>}
          <h3>Recent sessions</h3>
        </div>
      </div>
      <div className="usage-sessions" role="list">
        {families.map((family) => {
          const { session } = family;
          const item = sessions.find((item) => item.session.id === session.id && item.session.harnessId === session.harnessId);
          const row = item?.row;
          const cachedSession = item?.cachedSession;
          const key = `${session.harnessId}:${session.id}`;
          const harnessId = session.harnessId === "claude" ? "claude-code" : session.harnessId;
          const sessionId = row?.session_id ?? session.id;
          const analysed = row?.analysed ?? Boolean(session.inspection);
          const hasScanner = SCANNED_HARNESSES.includes(harnessId);
          const openTimeline = hasScanner && analysed
            ? () => onOpenSession(sessionId, harnessId) : undefined;
          return <UsageSessionItem
            key={key}
            session={session}
            pins={pins}
            family={family}
            ledgerId={sessionId}
            currency={currency}
            eurRate={eurRate}
            hasScanner={hasScanner}
            notAnalysed={!analysed}
            isOpen={openRows.has(key)}
            onToggle={() => toggleRow(key)}
            onInspect={cachedSession || session.inspection ? () => setInspectedSession({ ...session, id: sessionId }) : openTimeline}
            onOpenTimeline={cachedSession || session.inspection ? openTimeline : undefined}
          />;
        })}
        {sessions.length === 0 && (
          <p className="usage-note">{harness ? "No analysed sessions for this harness in this window" : "No analysed sessions in this window."}</p>
        )}
      </div>
      <UsageSessionSheet session={inspectedSession} onClose={() => setInspectedSession(null)} />
      {payload.not_analysed.length > 0 && (
        <p className="usage-note">
          {payload.not_analysed.map((row) => row.harness).join(", ")}{" "}
          {plural(payload.not_analysed.length, "session is", "sessions are")} not analysed yet.
        </p>
      )}
    </section>
  );
}

function ProjectActivityBand({
  payload,
  loadoutRows,
  window,
  harness,
  timeline,
}: {
  payload: UsageProjectPayload;
  loadoutRows: UsageLoadoutRow[];
  window: UsageWindow;
  harness: string | null;
  timeline: ReturnType<typeof useUsageProjectTimeline>;
}) {
  const bucket = window === 90 ? "week" : "day";
  const columns = useMemo(
    () => buildProjectSessionColumns(payload.sessions, loadoutRows, window, harness),
    [payload.sessions, loadoutRows, window, harness],
  );
  const harnessIds = useMemo(() => orderHarnessIds(columns.flatMap((column) => Object.keys(column.values))), [columns]);
  const series = useMemo<Series[]>(
    () => harnessIds.map((id) => ({
      id,
      label: harnessDisplayLabel(id),
      color: identityColor(harnessColorIndex(id)),
      swatch: <HarnessGlyph id={id} label={harnessDisplayLabel(id)} size={14} decorative />,
    })),
    [harnessIds],
  );
  const days = timeline.data?.days ?? [];
  const grid = timeline.data?.peaks.grid ?? Array.from({ length: 7 }, () => Array(24).fill(0));
  const hasNamedActivity = days.length > 0;
  const hasPeaks = grid.some((row) => row.some((value) => value > 0));
  const retry = <Button variant="ghost" icon="rescan" onClick={() => { void timeline.refetch(); }}>Retry</Button>;

  return (
    <section className="usage-project-activity" aria-label="Project activity">
      <div className="usage-project-activity-head">
        <div><span className="usage-kicker">Over time</span><h3>Project activity</h3></div>
        <p className="usage-note">includes sub-agent sessions</p>
      </div>
      {timeline.status === "unsupported" ? (
        <section className="usage-card usage-over-time-card"><h3>Project activity</h3><p className="usage-note">No transcript timeline for {harnessDisplayLabel(harness ?? "this harness")}</p></section>
      ) : timeline.isError ? (
        <section className="usage-card usage-over-time-card"><h3>Project activity</h3><p className="usage-note">Timeline unavailable</p>{retry}</section>
      ) : timeline.isPending ? (
        <div className="usage-project-activity-grid">
          {['Sessions', 'Skills used', 'Tool activity', 'When tokens happen'].map((title) => <section className="usage-card usage-over-time-card" key={title}><span className="usage-kicker">Over time</span><h3>{title}</h3><p className="usage-note">Loading…</p></section>)}
        </div>
      ) : (
        <div className="usage-project-activity-grid">
          <div className="usage-project-activity-main">
            <section className="usage-card usage-over-time-card">
              <span className="usage-kicker">Sessions</span><h3>Sessions</h3><p className="usage-note">by {bucket}</p>
              <StackedColumnChart series={series} columns={columns} format={formatCount} legend="always" ariaLabel="Project sessions" />
            </section>
            {hasNamedActivity ? (["skills", "tools"] as const).map((kind) => <UsageActivityCard
              key={kind} kind={kind} days={timeline.data!.days} bucket={bucket} bounds={timeline.data}
            />) : <section className="usage-card usage-over-time-card"><h3>Project activity</h3><p className="usage-note">No skill or tool events in this window</p></section>}
          </div>
          {hasPeaks ? <UsagePeaksGrid grid={grid} since={timeline.data?.since ?? null} until={timeline.data?.until ?? null} /> : <section className="usage-card usage-over-time-card"><h3>When tokens happen</h3><p className="usage-note">No token activity in this window</p></section>}
        </div>
      )}
    </section>
  );
}

/**
 * The `hub usage project` drill-down — five bands in the proposal's fixed
 * order (Outcomes, Sessions, Footprint, Utilization, Findings — summary first,
 * evidence at the end), an empty state before the first scan, and a failed-scan
 * banner that never hides the rows a partial scan already wrote (design
 * D14.6). Route-free by design (G5): wave 3 re-hosts this exact component
 * under `/project/:name/usage` with a different `onOpenSession`.
 */
export function UsageProjectArea({
  name,
  window,
  onWindowChange,
  onOpenSession,
}: UsageProjectAreaProps) {
  // The window selector lives in the route header (D14.6, G15); the prop
  // stays on the four-prop contract for wave 3's re-host and is unused here.
  void onWindowChange;
  const navigate = useNavigate();
  const location = useLocation();
  const registry = useRegistry();
  const skillNames = useMemo(() => new Set(Object.keys(registry.data?.skills ?? {})), [registry.data?.skills]);
  const focusParam = new URLSearchParams(location.search).get("focus");
  const focus = ["footprint", "sessions", "utilization"].includes(focusParam ?? "") ? focusParam : null;
  const focused = useRef<string | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const contextHarness = typeof location.state?.contextHarness === "string" ? location.state.contextHarness : null;
  // Keep controls on this history entry so both editor Back and browser Back restore them.
  const state = location.state as {
    usageProjectView?: { project?: unknown; harness?: unknown; showAll?: unknown; focus?: unknown };
  } | null;
  const view = state?.usageProjectView?.project === name ? state.usageProjectView : undefined;
  const [harness, setHarness] = useState<string | null>(() => typeof view?.harness === "string" ? view.harness : null);
  const [showAll, setShowAll] = useState(() => view?.focus === focus && typeof view?.showAll === "boolean" ? view.showAll : focus === "utilization");
  useEffect(() => {
    if (focus === "utilization" && view?.focus !== focus) setShowAll(true);
  }, [focus, view?.focus]);
  const path = `${location.pathname}${location.search}${location.hash}`;
  const setView = (next: { harness: string | null; showAll: boolean }) => {
    setHarness(next.harness);
    setShowAll(next.showAll);
    navigate(path, { replace: true, state: {
      ...state, usageProjectView: { project: name, focus, ...next },
    } });
  };
  const skillBack: BackTarget = {
    ...(location.pathname.startsWith("/usage/") ? usageProjectBackTarget(name) : projectAreaBackTarget(name, "usage")),
    path,
    restore: { ...state, usageWindow: window, usageProjectView: { project: name, focus, harness, showAll } },
  };
  const query = useUsageProject(name, window);
  const timeline = useUsageProjectTimeline(window, harness, name);
  const loadoutsQuery = useUsageLoadouts(name);
  const footprintQuery = useUsageFootprint(name);
  const tokenizedByHarness = useFootprintTokensByHarness(
    footprintQuery.data?.ok ? footprintQuery.data : undefined,
  );
  useEffect(() => {
    if (!focus || focused.current === `${name}:${focus}` || (focus !== "footprint" && !query.data?.ok)) return;
    const target = region.current?.querySelector<HTMLElement>(`[data-usage-focus="${focus}"]`);
    if (!target) return;
    focused.current = `${name}:${focus}`;
    target.focus(); target.scrollIntoView?.({ block: "start" });
  }, [name, focus, query.data, footprintQuery.data]);
  const staticContext = <div data-usage-focus="footprint" tabIndex={-1}><ProjectContextEstimate projectName={name} selectedHarness={contextHarness} detailed /></div>;
  const currentSkills = registry.data?.projects[name] ? new Set(resolveActiveSkills(registry.data.projects[name], registry.data).filter((key) => registry.data?.skills[key]?.type !== "mcp-server")) : null;
  const lastScan = useLastScanResult();
  const recovery = <UsageScanRecovery />;
  const payload = query.data;
  const payloadHarnesses = useMemo(
    () => (Array.isArray(payload?.harnesses) ? payload.harnesses : []),
    [payload?.harnesses],
  );
  const harnessOptions = useMemo<ChipRadioOption<string>[]>(
    () => [{ value: "all", label: "All" }, ...payloadHarnesses.map((id) => ({
      value: id,
      label: harnessDisplayLabel(id),
      icon: <HarnessGlyph id={id} label={harnessDisplayLabel(id)} size={14} decorative />,
    }))],
    [payloadHarnesses],
  );
  const shelf = (
    <div className="usage-controls-scope usage-project-controls">
      <UsageWindowSelector window={window} onChange={onWindowChange} />
      {payloadHarnesses.length > 0 && (
        <ChipRadios
          name="usage-project-harness"
          label="Harness filter (sessions and activity)"
          value={harness ?? "all"}
          options={harnessOptions}
          disabled={!payload || query.isFetching}
          onChange={(value) => setView({ harness: value === "all" ? null : value, showAll })}
        />
      )}
    </div>
  );
  const usageLink = <p className="usage-project-crosslink">Spend, models and harness totals across all projects live in <a href="/usage" onClick={(event) => { event.preventDefault(); navigate("/usage"); }}>Usage</a>.</p>;

  if (!payload) {
    if (query.isError) {
      return (
        <div className="usage-project-area" ref={region}>{shelf}{usageLink}{recovery}{staticContext}<EmptyState icon="warning" title="Could not load this project's usage" description="Try again from the header once the install is healthy." /></div>
      );
    }
    // Loading — the geometry contract still wants SOMETHING in the pane
    // rather than a layout jump once the query resolves.
    return <div className="usage-project-area" ref={region}>{shelf}{usageLink}{recovery}{staticContext}<p className="usage-note">Loading…</p></div>;
  }

  if (!payload.ok) {
    return (
      <div className="usage-project-area" ref={region}>{shelf}{usageLink}{recovery}{staticContext}<EmptyState icon="warning" title="This project's usage is unavailable" description={payload.reason === "not_found" ? "No usage data exists for this project." : "The usage data could not be read."} /></div>
    );
  }

  if (payload.last_scan_at == null && payload.sessions.length === 0) {
    return (
      <div className="usage-project-area" ref={region}>{shelf}{usageLink}{recovery}{staticContext}<EmptyState icon="usage" title="No scanned sessions yet" description="The first scan reads about 3 GB and takes a few minutes. Later scans are incremental." action={<ScanButton variant="primary">Scan now</ScanButton>} /></div>
    );
  }

  const scanFailed = lastScan !== undefined && !lastScan.ok && !isReplanRequired(lastScan);

  return (
    <div className="usage-project-area" ref={region}>
      {shelf}
      {usageLink}
      {recovery}
      {scanFailed && (
        <InfoBanner icon="warning" className="usage-project-scan-failed-banner">
          Scan stopped on {lastScan!.stopped_on ?? "a transcript"} — {lastScan!.errors.length}{" "}
          {plural(lastScan!.errors.length, "error")}. Every session already written still shows below.
          <ScanButton variant="ghost">Try again</ScanButton>
        </InfoBanner>
      )}
      <OutcomesBand outcomes={payload.outcomes} harness={harness} />
      <div data-usage-focus="sessions" tabIndex={-1}><SessionsBand payload={payload} harness={harness} onOpenSession={onOpenSession} /></div>
      <ProjectActivityBand payload={payload} loadoutRows={loadoutsQuery.data?.rows ?? []} window={window} harness={harness} timeline={timeline} />
      {focus === "footprint" && staticContext}<FootprintBand payload={payload} tokenizedByHarness={tokenizedByHarness} harness={harness} />
      <div data-usage-focus="utilization" tabIndex={-1}>{location.state?.loadoutOnly && <p className="usage-note">Currently equipped skills. Historical skills remain available from Usage.</p>}<UtilizationBand rows={location.state?.loadoutOnly && currentSkills ? payload.utilization.filter((row) => currentSkills.has(row.key)) : payload.utilization} harness={harness} showAll={showAll} onToggle={() => setView({ harness, showAll: !showAll })} back={skillBack} skillNames={skillNames} /></div>
      <FindingsBand findings={payload.findings} findingsWindow={payload.findings_window} tokenizedByHarness={tokenizedByHarness} harness={harness} />
    </div>
  );
}
