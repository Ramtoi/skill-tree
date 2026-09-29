import { formatCapturedCount } from "./usageFormat";
import type { UsageSessionFamily } from "./usageSessionFamilies";
import type { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { ResourceRow } from "@/components/ResourceRow";
import { Tag } from "@/components/Tag";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { plural } from "@/lib/plural";
import { ccusageToHubHarness } from "./harnessIdentity";
import { parseModelId } from "./modelIdentity";
import { UsageSessionDetail } from "./UsageSessionDetail";
import { presentUsageSession, type UsageSessionPresentation } from "./usageSessionPresentation";
import { formatCompact, formatCount, formatMoney, formatRelativeTime, shortId, type UsageCurrency } from "./usageFormat";

/** Display names ("Sonnet 5, GPT-5.5"), never the raw ccusage ids — the raw
 *  ones still recover on hover via the wrapping span's `title`. */
function modelsSummary(models: string[]): ReactNode {
  if (models.length === 0) return "no models reported";
  const shown = models.slice(0, 2);
  const overflow = models.length - shown.length;
  const text = shown.map((m) => parseModelId(m).display).join(", ") + (overflow > 0 ? ` +${overflow}` : "");
  return <span title={models.join(", ")}>{text}</span>;
}

/** What a titleless session is called. The row and its `aria-label` both
 *  read from here so the two can never drift, and a `period` with no usable
 *  short id (an empty or separator-only value) degrades to the harness name
 *  alone instead of an empty `<code>`. */
function sessionFallbackName(session: UsageSessionPresentation): {
  text: string;
  id: string;
} {
  const id = shortId(session.period);
  return { text: `${session.harnessName} session`, id };
}

function sessionAriaLabel(
  session: UsageSessionPresentation,
  currency: UsageCurrency,
  eurRate: number,
): string {
  const fallback = sessionFallbackName(session);
  const titleText =
    session.title ?? [fallback.text, fallback.id].filter(Boolean).join(" ");
  const coverage = session.tokenCaptureCoverage && session.tokenCaptureCoverage !== "complete"
    ? `, provider token totals, ${session.tokenCaptureCoverage} capture`
    : "";
  return `${titleText}, ${formatCount(session.tokens.total)} tokens${coverage}${session.estimatedCost ? `, ${formatMoney(session.estimatedCost.usd, currency, eurRate)}` : ""}`;
}

export interface UsageSessionItemProps {
  session: UsageSessionPresentation;
  /** Sets the `Includes N agents` tag. Members are inspected from the
   *  session sheet's timeline, never from a second list in the row. */
  family?: UsageSessionFamily<UsageSessionPresentation>;
  pins: ReturnType<typeof useUsageSessionPins>;
  ledgerId?: string | null;
  currency: UsageCurrency;
  eurRate: number;
  effectiveShowFullPaths?: boolean;
  hasScanner: boolean;
  notAnalysed: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onInspect?: () => void;
  onOpenTimeline?: () => void;
}

/** Shared summary and disclosure. Callers own scope, ordering and navigation. */
export function UsageSessionItem({ session, currency, eurRate, effectiveShowFullPaths = false,
  hasScanner, notAnalysed, isOpen, onToggle, onInspect, onOpenTimeline, pins, ledgerId, family,
}: UsageSessionItemProps) {
  const presentedSession = presentUsageSession(session);
  const hubHarness = ccusageToHubHarness(presentedSession.harnessId) ?? presentedSession.harnessId;
  const projectDisplay = effectiveShowFullPaths
    ? (presentedSession.project?.fullPath ??
      presentedSession.project?.redactedPath ??
      "Local project")
    : (presentedSession.project?.label ?? "Local project");
  const agentCount = family?.members.filter((member) => member.id !== session.id).length ?? 0;
  const fallback = sessionFallbackName(presentedSession);
  // Order by what survives truncation: the time, then the in/out
  // split the user asked to see, then the model list — the one clause
  // that can run long ("claude-opus-5, claude-sonnet-5 +2") and the
  // one the detail panel restates in full.
  const relTime = formatRelativeTime(presentedSession.lastActivity ?? presentedSession.startedAt);
  const split = "input" in presentedSession.tokens ? presentedSession.tokens : undefined;
  const inOutText = split ? `${formatCompact(split.input)} in · ${formatCompact(split.output)} out` : "Token breakdown unavailable";
  const inOutTitle = split ? `${formatCount(split.input)} input tokens · ${formatCount(split.output)} output tokens` : undefined;
  const pinHarness = presentedSession.inspection?.harness ?? hubHarness;
  const pinSessionId = presentedSession.inspection?.root_session_id ?? presentedSession.id;
  const pinRunId = presentedSession.inspection && presentedSession.inspection.root_session_id !== presentedSession.id ? presentedSession.inspection.run_id : null;
  const isPinned = pins.isPinned(pinHarness, pinSessionId, pinRunId);
  const latestInspectionPr = presentedSession.inspection ? presentedSession.inspection.latest_pr : presentedSession.pr;
  const latestPrRepository = latestInspectionPr && "repository_id" in latestInspectionPr ? latestInspectionPr.repository_id : null;
  const additionalInspectionPrs = (presentedSession.inspection?.prs ?? []).filter((pr) => pr.number !== latestInspectionPr?.number || latestPrRepository === null || pr.repository_id !== latestPrRepository);
  return (
    <ResourceRow
      key={presentedSession.id}
      className="usage-session-row"
      role="listitem"
      glyph={<HarnessGlyph id={hubHarness} size={18} decorative />}
      name={
        presentedSession.title ? (
          <span className="usage-session-title" title={presentedSession.title}>{presentedSession.title}</span>
        ) : (
          <span className="usage-session-fallback">
            {fallback.text}
            {fallback.id ? (
              <>
                {" "}
                <code>{fallback.id}</code>
              </>
            ) : null}
          </span>
        )
      }
      meta={
        <span className="usage-session-meta">
          <Tag size="sm">{projectDisplay}</Tag>
          {agentCount > 0 && <Tag size="sm">Includes {agentCount} {plural(agentCount, "agent")}</Tag>}
          {family?.parentUnavailable && <Tag size="sm">Parent unavailable</Tag>}
          {presentedSession.tokenCaptureCoverage && presentedSession.tokenCaptureCoverage !== "complete" && (
            <span title={`Provider token totals; capture coverage is ${presentedSession.tokenCaptureCoverage}.`}>
              <Tag size="sm">Provider tokens · {presentedSession.tokenCaptureCoverage === "partial" ? "partial capture" : "capture unavailable"}</Tag>
            </span>
          )}
          {!hasScanner ? (
            <Tag size="sm">No analysis for {presentedSession.harnessName}</Tag>
          ) : (
            notAnalysed && <Tag size="sm">Not analysed yet</Tag>
          )}
          {presentedSession.branch && (
            <span className="usage-meta-chip">
              <Icon name="git-diff" size={11} />
              {presentedSession.branch}
            </span>
          )}
          {latestInspectionPr && (
            <button
              type="button"
              className="usage-pr-link"
              title={latestInspectionPr!.url}
              onClick={(e) => {
                e.stopPropagation();
                void openUrl(latestInspectionPr!.url);
              }}
            >
              PR #{latestInspectionPr!.number}
            </button>
          )}
          {(presentedSession.inspection?.additional_pr_count ?? 0) > 0 && (
            <details className="usage-row-pr-picker">
              <summary className="usage-pr-count" onClick={(e) => e.stopPropagation()}>+{presentedSession.inspection!.additional_pr_count} more PR{presentedSession.inspection!.additional_pr_count === 1 ? "" : "s"}</summary>
              <div>{additionalInspectionPrs.map((pr) => <a key={`${pr.repository_id}:${pr.number}`} className="usage-pr-link" href={pr.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openUrl(pr.url); }}>#{pr.number} · {pr.repository_id}</a>)}{additionalInspectionPrs.length === 0 && <span className="usage-note">Additional PR evidence is available in Inspect session.</span>}</div>
            </details>
          )}
        </span>
      }
      desc={
        <>
          {relTime ? `${relTime} · ` : ""}
          <span title={inOutTitle}>{inOutText}</span>
          {" · "}
          {modelsSummary(presentedSession.models)}
        </>
      }
      badges={
        <span className="usage-row-numbers">
          <b>{formatCompact(presentedSession.tokens.total)}</b>
          {presentedSession.estimatedCost && <span>
            {formatMoney(presentedSession.estimatedCost.usd, currency, eurRate)}
          </span>}
          {presentedSession.toolCalls !== undefined && (
            <span className="usage-row-tools">
              {formatCapturedCount(presentedSession.toolCalls, presentedSession.inspection?.native?.own.field_status.tool_calls !== "partial")}{" "}
              {plural(presentedSession.toolCalls, "tool")}
            </span>
          )}
          {presentedSession.inspection && (
            <button type="button" className="usage-session-pin" title={isPinned ? "Unpin session" : "Pin session"} aria-label={`${isPinned ? "Unpin" : "Pin"} ${presentedSession.title ?? "session"}`} aria-pressed={isPinned} onClick={(e) => { e.stopPropagation(); pins.mutate({ action: isPinned ? "remove" : "add", harness: pinHarness, sessionId: pinSessionId, runId: pinRunId }); }}>
              <Icon name="pin" size={13} />
            </button>
          )}
        </span>
      }
      detail={
        <>
          <UsageSessionDetail
            session={presentedSession}
            currency={currency}
            eurRate={eurRate}
            projectDisplay={projectDisplay}
            onInspect={onInspect}
          />
          {onOpenTimeline && !onInspect && (
            <div className="usage-timeline-action">
              <Button
                variant="soft"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTimeline();
                }}
              >
                Timeline
              </Button>
            </div>
          )}
        </>
      }
      detailOpen={isOpen}
      onDetailToggle={() => onToggle()}
      detailLabel="session details"
      onClick={() => onToggle()}
      // Use the inspection session key when the index joined this
      // row. The normalized React id can include a row index, while
      // browser journeys and deep links need the stable ledger key.
      dataset={{ testid: "usage-session-row", "session-id": ledgerId ?? presentedSession.id }}
      ariaLabel={sessionAriaLabel(presentedSession, currency, eurRate)}
    />
  );
}
