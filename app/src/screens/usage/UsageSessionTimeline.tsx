import { useState } from "react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorCard } from "@/components/ErrorCard";
import { Plaque } from "@/components/Plaque";
import { SkeletonRow } from "@/components/loading/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Tag } from "@/components/Tag";
import { diagnosticMessage } from "@/features/usage/usageDiagnostic";
import type {
  UsageActivityCounts,
  UsageEvent,
  UsageSubagentRow,
} from "@/features/usage/usageAnalyticsTypes";
import { useUsageSession } from "@/hooks/useUsageAnalytics";
import { plural } from "@/lib/plural";
import { ActivityBar } from "./ActivityBar";
import { ScanButton } from "./UsageScanAction";
import {
  segmentEvents,
  segmentMetrics,
  summaryLine,
  TIMELINE_EVENTS_PER_SEGMENT_CAP,
  TIMELINE_SEGMENT_CAP,
  type UsageSegment,
} from "./usageTimelineModel";
import { formatCount, formatPercent, shortId } from "./usageFormat";

/**
 * The `hub usage session` drill-down (design D14.7). Props are deliberately
 * route-free — the caller (`UsageSessionRoute.tsx`, unit H) owns `:id` and
 * `?harness=`; this component owns its own loading/error/`ok:false` states.
 *
 */
export interface UsageSessionTimelineProps {
  sessionId: string;
  harness?: string;
}

const ZERO_ACTIVITY: UsageActivityCounts = {
  read: 0,
  edit: 0,
  verify: 0,
  operate: 0,
  delegate: 0,
  skill: 0,
  external: 0,
};

/** Sums a segment's non-opener events' activity counts. The opener (a
 *  `human_turn`/`slash_command`) carries no activity classification of its
 *  own — the same convention `segmentMetrics` (`usageTimelineModel.ts`)
 *  already follows for its token/thinking sums. */
function segmentActivity(segment: UsageSegment): UsageActivityCounts {
  const totals: UsageActivityCounts = { ...ZERO_ACTIVITY };
  for (const event of segment.events) {
    for (const cls of Object.keys(totals) as (keyof UsageActivityCounts)[]) {
      totals[cls] += event.activity[cls] ?? 0;
    }
  }
  return totals;
}

/** Sums a segment's non-opener events' `token_delta` — the "its token_delta"
 *  fact design D14.7 asks each segment to show. */
function segmentTokenDelta(segment: UsageSegment): number {
  return segment.events.reduce((sum, event) => sum + event.token_delta, 0);
}

/** True when the opener or any event inside the segment carries
 *  `edited_without_verify: true` — the field lives on `UsageEvent`, not on
 *  `UsageSegment` itself, so design D14.7's "a segment whose
 *  `edited_without_verify` is true" is read as "any event the segment
 *  covers". Conservative reading, noted under Deviations. */
function segmentEditedWithoutVerify(segment: UsageSegment): boolean {
  if (segment.opener?.edited_without_verify) return true;
  return segment.events.some((event) => event.edited_without_verify);
}

/** A blank excerpt renders as a dim em-dash rather than an empty quote — both
 *  a pruned session's blanked-out fields and a genuinely empty excerpt read
 *  the same way, per design D14.7's pruned-transcript rule. */
/** A slash command's excerpt is the harness's raw `<command-*>` markup; the
 *  segment shows `/name args` from the event's own `name` and the args tag. */
function openerExcerpt(opener: UsageEvent | null): string | undefined {
  if (!opener) return undefined;
  if (opener.kind === "slash_command" && opener.name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(opener.excerpt ?? "")?.[1]?.trim();
    return args ? `/${opener.name} ${args}` : `/${opener.name}`;
  }
  return opener.excerpt;
}

function ExcerptText({ text }: { text?: string }) {
  if (!text) return <span className="usage-timeline-dash">—</span>;
  return <>{text}</>;
}

function kindLabel(kind: UsageEvent["kind"]): string {
  switch (kind) {
    case "human_turn":
      return "Turn";
    case "slash_command":
      return "Slash command";
    case "skill":
      return "Skill";
    case "script":
      return "Script";
    case "subagent":
      return "Sub-agent";
    case "tool":
      return "Tool";
    case "compaction":
      return "Compaction";
    default:
      return kind;
  }
}

function EditWithoutVerifyMarker() {
  return (
    <StatusBadge channel="warn" icon="warning" className="usage-timeline-marker">
      edit without verify
    </StatusBadge>
  );
}

function EventRow({ event, revealed }: { event: UsageEvent; revealed?: boolean }) {
  return (
    <li className={`usage-timeline-event${revealed ? " usage-timeline-reveal" : ""}`}>
      <span className="usage-timeline-event-kind">{kindLabel(event.kind)}</span>
      <span className="usage-timeline-event-name">{event.name ?? "—"}</span>
      <Tag>{event.invoker ?? "—"}</Tag>
      {event.kind === "subagent" && event.model && (
        <span className="usage-timeline-event-model">{event.model}</span>
      )}
    </li>
  );
}

function SegmentBlock({
  segment,
  index,
  revealed,
}: {
  segment: UsageSegment;
  index: number;
  revealed: boolean;
}) {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const metrics = segmentMetrics(segment);
  const activity = segmentActivity(segment);
  const tokenDelta = segmentTokenDelta(segment);
  const marker = segmentEditedWithoutVerify(segment);
  const events = segment.events;
  const visibleEvents = showAllEvents
    ? events
    : events.slice(0, TIMELINE_EVENTS_PER_SEGMENT_CAP);
  const hiddenEventCount = events.length - visibleEvents.length;

  return (
    <li
      className={`usage-timeline-segment${revealed ? " usage-timeline-reveal" : ""}`}
      data-testid="usage-timeline-segment"
    >
      <div className="usage-timeline-segment-head">
        <div className="usage-timeline-segment-opener">
          {segment.opener && <Tag>{segment.opener.invoker ?? "—"}</Tag>}
          <p className="usage-timeline-segment-excerpt">
            <ExcerptText text={openerExcerpt(segment.opener)} />
          </p>
        </div>
        {marker && <EditWithoutVerifyMarker />}
      </div>
      <dl className="usage-timeline-segment-stats">
        <div className="usage-timeline-stat">
          <dt>Tokens</dt>
          <dd>{formatCount(tokenDelta)}</dd>
        </div>
        <div className="usage-timeline-stat">
          <dt>Cache hit (approx.)</dt>
          <dd>{metrics.cache_ratio == null ? "n/a" : formatPercent(metrics.cache_ratio)}</dd>
        </div>
        <div className="usage-timeline-stat">
          <dt>Thinking share (approx.)</dt>
          <dd>
            {metrics.thinking_share == null ? "n/a" : formatPercent(metrics.thinking_share)}
          </dd>
        </div>
      </dl>
      <ActivityBar activity={activity} ariaLabel={`Segment ${index + 1} activity mix`} />
      {events.length > 0 && (
        <ul className="usage-timeline-events">
          {visibleEvents.map((event, i) => (
            <EventRow
              key={i}
              event={event}
              revealed={showAllEvents && i >= TIMELINE_EVENTS_PER_SEGMENT_CAP}
            />
          ))}
        </ul>
      )}
      {hiddenEventCount > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAllEvents(true)}>
          {`Show ${hiddenEventCount} more ${plural(hiddenEventCount, "event")}`}
        </Button>
      )}
    </li>
  );
}

function SubagentRow({ row }: { row: UsageSubagentRow }) {
  return (
    <li className="usage-timeline-subagent-row">
      <span className="usage-timeline-subagent-type">{row.type ?? "—"}</span>
      {row.model && <span className="usage-timeline-subagent-model">{row.model}</span>}
      <span className="usage-timeline-subagent-tokens">
        {row.tokens != null ? `${formatCount(row.tokens)} tokens` : "—"}
      </span>
    </li>
  );
}

export function UsageSessionTimeline({ sessionId, harness }: UsageSessionTimelineProps) {
  const [chosenHarness, setChosenHarness] = useState<string | undefined>(undefined);
  const effectiveHarness = chosenHarness ?? harness;
  const query = useUsageSession(sessionId, effectiveHarness);
  const [showAllSegments, setShowAllSegments] = useState(false);

  if (query.isPending) {
    return (
      <div className="usage-timeline-loading" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorCard
        title="This session could not be read."
        description={diagnosticMessage(query.error)}
        actions={
          <Button variant="soft" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const payload = query.data;
  if (!payload) return null;

  // The ambiguous-id chooser (design D14.7, G7/G24): the payload names no
  // candidate harnesses, so the two offered here mirror the design's own
  // example copy rather than a value read off the response — see the unit
  // report's Deviations.
  if (payload.reason === "ambiguous") {
    return (
      <Plaque
        eyebrow="Two sessions share this id"
        accent="anchor"
        data-testid="usage-timeline-ambiguous"
      >
        <p className="usage-note">
          Two sessions share this id. Open the claude-code one, or the codex one.
        </p>
        <div className="usage-timeline-ambiguous-actions">
          <Button variant="soft" size="sm" onClick={() => setChosenHarness("claude-code")}>
            Open the claude-code one
          </Button>
          <Button variant="soft" size="sm" onClick={() => setChosenHarness("codex")}>
            Open the codex one
          </Button>
        </div>
      </Plaque>
    );
  }

  // Not yet scanned (design D14.7, G7): a failed lookup, OR a successful one
  // where the ledger simply has never been scanned. Both render the same
  // named state rather than a separate empty state.
  const notScanned = !payload.ok || payload.last_scan_at == null;
  if (notScanned) {
    return (
      <div data-testid="usage-timeline-not-found">
        <EmptyState
          icon="usage"
          title="This session has not been scanned yet"
          description={
            <>
              Session <code className="usage-timeline-shortid">{shortId(sessionId)}</code>
            </>
          }
          action={
            <ScanButton variant="primary">Scan sessions</ScanButton>
          }
        />
      </div>
    );
  }

  const pruned = payload.transcript_present === false;
  const events = payload.events ?? [];
  const allSegments = segmentEvents(events);
  const visibleSegments = showAllSegments
    ? allSegments
    : allSegments.slice(-TIMELINE_SEGMENT_CAP);
  const hiddenSegmentCount = allSegments.length - visibleSegments.length;
  const subagents = payload.subagents ?? [];

  return (
    <div className="usage-timeline" data-testid="usage-timeline">
      <p className="usage-timeline-summary" data-testid="usage-timeline-summary">
        {summaryLine(payload)}
      </p>
      {pruned && (
        <Plaque eyebrow="Transcript pruned" accent="anchor" data-testid="usage-timeline-pruned">
          <p className="usage-note">
            The transcript for this session is gone. The numbers below come from
            the ledger; the text is pruned.
          </p>
        </Plaque>
      )}
      <Plaque eyebrow="Intent (redacted excerpt)" accent="anchor">
        <p className="usage-note">
          <ExcerptText text={payload.intent_excerpt} />
        </p>
      </Plaque>
      {hiddenSegmentCount > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAllSegments(true)}>
          {`Show ${hiddenSegmentCount} earlier ${plural(hiddenSegmentCount, "segment")}`}
        </Button>
      )}
      {visibleSegments.length > 0 ? (
        <ul className="usage-timeline-segments">
          {visibleSegments.map((segment, i) => (
            <SegmentBlock
              key={i}
              segment={segment}
              index={i}
              revealed={showAllSegments && i < hiddenSegmentCount}
            />
          ))}
        </ul>
      ) : (
        <p className="usage-note">No steering turns recorded.</p>
      )}
      {subagents.length > 0 && (
        <section className="usage-timeline-subagents">
          <h3>Sub-agents</h3>
          <ul>
            {subagents.map((row, i) => (
              <SubagentRow key={i} row={row} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
