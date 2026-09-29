import { formatCapturedCount } from "./usageFormat";
import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  HorizontalBarList,
  type BarRow,
} from "@/components/charts/HorizontalBarList";
import { Button } from "@/components/Button";
import { Tag } from "@/components/Tag";
import type { UsageSessionPresentation } from "./usageSessionPresentation";
import { plural } from "@/lib/plural";
import { ccusageToHubHarness } from "./harnessIdentity";
import { stopEvent } from "@/lib/pressable";
import { ModelName } from "./ModelName";
import { isUnpriced } from "./pricing";
import { TokenCompositionBars } from "./TokenCompositionBars";
import { parseUsageDate } from "./usageAggregate";
import {
  formatCompact,
  formatCount,
  formatDuration,
  formatMoney,
  formatPercent,
  type UsageCurrency,
} from "./usageFormat";

const TOP_TOOLS_LIMIT = 5;

export interface UsageSessionDetailProps {
  session: UsageSessionPresentation;
  currency: UsageCurrency;
  eurRate: number;
  /** Pre-computed by the caller with the same rule the row's own project
   *  chip already uses (label, or the full/redacted path under the toggle) —
   *  one source of truth for how a session's project displays. */
  projectDisplay: string;
  /** `Inspect session` (R5) — opens the drill-down sheet for this session.
   *  Omitted entirely (no button rendered) when the caller has nothing to
   *  open it into (component tests that render this in isolation). */
  onInspect?: () => void;
}

function KvRow({
  label,
  value,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="usage-detail-kv-row">
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
}

/**
 * The Sessions card's row disclosure (COMPONENTS.md §Resource row / card's
 * `detail` slot) — every fact THIS session's own data actually carries, never
 * a placeholder for one it doesn't. Up to three blocks in a `tile-row`
 * (Tokens, Models, Activity), each omitted outright when it would be empty —
 * a session with no per-model split and no model names has no Models block,
 * a session with none of the optional activity facts has no Activity block
 * at all (Project and Session id ride along inside it, but never justify it
 * on their own — otherwise the block would never actually go away, since
 * `period` and a project fallback exist on every row).
 */
export function UsageSessionDetail({
  session,
  currency,
  eurRate,
  projectDisplay,
  onInspect,
}: UsageSessionDetailProps) {
  const pr = session.inspection ? session.inspection.latest_pr : session.pr;
  const hubHarness = ccusageToHubHarness(session.harnessId);
  const isClaudeCode = hubHarness === "claude-code";
  // Sub-agents spawned is derivable only for Claude Code — Task/Agent tool
  // calls have no equivalent in Codex's or pi's own tool vocabularies.
  const subAgents = isClaudeCode
    ? (session.toolBreakdown ?? [])
        .filter((t) => t.name === "Agent" || t.name === "Task")
        .reduce((sum, t) => sum + t.count, 0)
    : 0;

  const topTools = session.toolBreakdown?.slice(0, TOP_TOOLS_LIMIT) ?? [];
  const moreTools = Math.max(
    0,
    (session.toolBreakdown?.length ?? 0) - topTools.length,
  );

  const hasLines =
    session.linesAdded !== undefined || session.linesRemoved !== undefined;
  const durationLabel =
    session.durationMs !== undefined
      ? formatDuration(session.durationMs)
      : undefined;
  const lastActivityMs = parseUsageDate(session.lastActivity);
  const lastActivityLabel =
    lastActivityMs !== undefined
      ? new Date(session.lastActivity!).toLocaleString()
      : undefined;
  // The row's own chip already shows a fallback ("Local project"/"No
  // project") — the detail only repeats Project when there is a genuinely
  // known one, never that filler text.
  const realProject = session.hubProject ?? session.project?.label;
  const reasoningVisible =
    hubHarness === "codex" && session.reasoningOutputTokens !== undefined;

  const hasActivity =
    session.toolCalls !== undefined ||
    subAgents > 0 ||
    topTools.length > 0 ||
    hasLines ||
    durationLabel !== undefined ||
    lastActivityLabel !== undefined ||
    !!session.branch ||
    !!pr ||
    !!session.projectContext;

  // Same row shape `UsageModelsCard` builds — a session carries at most a
  // handful of models, so unlike the screen-wide card this never folds a
  // tail into "Other". An unpriced model (real tokens, no cost) sinks below
  // every priced one, same rule as the screen-wide card.
  const modelBreakdown = session.modelBreakdown ?? [];
  const modelRows: BarRow[] = modelBreakdown
    .slice()
    .sort((a, b) => {
      const aUnpriced = isUnpriced({ tokens: a.tokens, costUsd: a.estimatedCost.usd });
      const bUnpriced = isUnpriced({ tokens: b.tokens, costUsd: b.estimatedCost.usd });
      if (aUnpriced !== bUnpriced) return aUnpriced ? 1 : -1;
      return aUnpriced
        ? b.tokens.total - a.tokens.total
        : b.estimatedCost.usd - a.estimatedCost.usd;
    })
    .map((model) => {
      const unpriced = isUnpriced({ tokens: model.tokens, costUsd: model.estimatedCost.usd });
      return {
        key: model.modelName,
        label: <ModelName model={model.modelName} />,
        sub: `${formatCompact(model.tokens.total)} provider tokens`,
        value: model.estimatedCost.usd,
        display: unpriced ? <Tag size="sm">unpriced</Tag> : formatMoney(model.estimatedCost.usd, currency, eurRate),
        titleText: unpriced
          ? "No price for this model in the current price table"
          : `${formatMoney(model.estimatedCost.usd, currency, eurRate)} · ${formatCount(model.tokens.total)} provider tokens`,
      };
    });
  const unpricedModelCount = modelBreakdown.filter((m) =>
    isUnpriced({ tokens: m.tokens, costUsd: m.estimatedCost.usd }),
  ).length;
  const hasModels = modelRows.length > 0 || session.models.length > 0;

  return (
    // The row itself is the click target that opens/closes this panel — a
    // click landing anywhere inside it (a hover on a bar, a text selection,
    // the PR link) must not also toggle the row shut underneath.
    <div className="usage-session-detail tile-row" onClick={stopEvent}>
      <div className="usage-detail-block">
        <span className="usage-kicker">Tokens</span>
        {/* The bar's legend already names the four figures with their
            share; a key/value list under it said the same thing twice. Only
            a figure the bar cannot carry (Codex reasoning tokens are a
            provider-reported subset of output, not a fifth segment) gets its own line. */}
        {"input" in session.tokens ? <TokenCompositionBars
          tokens={session.tokens}
          ariaLabel="Token composition for this session"
        /> : <p className="usage-note">{formatCount(session.tokens.total)} tokens · breakdown unavailable</p>}
        {reasoningVisible && (
          <dl className="usage-detail-kv">
            <KvRow
              label={<><span>Reasoning</span> <span>(provider tokens)</span></>}
              value={formatCompact(session.reasoningOutputTokens!)}
              title={formatCount(session.reasoningOutputTokens!)}
            />
          </dl>
        )}
      </div>

      {hasModels && (
        <div className="usage-detail-block">
          <span className="usage-kicker">Models</span>
          {modelRows.length > 0 ? (
            <HorizontalBarList rows={modelRows} ariaLabel="Models" />
          ) : (
            <p className="usage-note">
              {session.models.map((m, i) => (
                <Fragment key={m}>
                  {i > 0 ? ", " : ""}
                  <ModelName model={m} />
                </Fragment>
              ))}
            </p>
          )}
          {unpricedModelCount > 0 && (
            <p className="usage-note">
              {unpricedModelCount} {plural(unpricedModelCount, "model")} in this session{" "}
              {unpricedModelCount === 1 ? "has" : "have"} no price. Open Prices to see which.
            </p>
          )}
        </div>
      )}

      {hasActivity && (
        <div className="usage-detail-block">
          <span className="usage-kicker">Activity</span>
          <dl className="usage-detail-kv">
            {session.projectContext && <>
              <KvRow label="Cache hit" value={formatPercent(session.projectContext.cache_hit_ratio)} />
              <KvRow label="Steering turns" value={formatCount(session.projectContext.steering_count)} />
              {session.projectContext.loadout_assumed && <KvRow label="Loadout" value={<Tag size="sm">current loadout assumed</Tag>} />}
            </>}
            {session.toolCalls !== undefined && (
              <KvRow
                label="Tool calls"
                value={formatCapturedCount(session.toolCalls, session.inspection?.native?.own.field_status.tool_calls !== "partial")}
              />
            )}
            {subAgents > 0 && (
              <KvRow
                label="Sub-agents spawned"
                value={formatCapturedCount(subAgents, session.inspection?.native?.own.field_status.tool_breakdown !== "partial")}
              />
            )}
            {topTools.length > 0 && (
              <KvRow
                label={session.inspection?.native?.own.field_status.tool_breakdown === "partial" ? "Top tools (partial)" : "Top tools"}
                value={
                  <span className="usage-detail-tools">
                    {topTools
                      .map((t) => `${t.name} ${formatCount(t.count)}`)
                      .join(" · ")}
                    {moreTools > 0 ? ` +${moreTools} more` : ""}
                  </span>
                }
              />
            )}
            {hasLines && (
              <KvRow
                label="Lines changed"
                value={`${session.linesAdded === undefined ? "added unavailable" : `+${formatCount(session.linesAdded)}`} / ${session.linesRemoved === undefined ? "removed unavailable" : `−${formatCount(session.linesRemoved)}`}`}
              />
            )}
            {durationLabel && <KvRow label="Duration" value={durationLabel} />}
            {!lastActivityLabel && session.startedAt && (
              <KvRow label="Started" value={new Date(session.startedAt).toLocaleString()} />
            )}
            {lastActivityLabel && (
              <KvRow label="Last activity" value={lastActivityLabel} />
            )}
            {session.branch && <KvRow label="Branch" value={session.branch} />}
            {pr && (
              <KvRow
                label="PR"
                value={
                  <button
                    type="button"
                    className="usage-pr-link"
                    title={pr.url}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openUrl(pr.url);
                    }}
                  >
                    PR #{pr.number}
                  </button>
                }
              />
            )}
            {realProject && <KvRow label="Project" value={projectDisplay} />}
            <KvRow
              label="Session id"
              value={<code>{session.period}</code>}
              title={session.period}
            />
          </dl>
        </div>
      )}
      {onInspect && (
        <div className="usage-detail-actions">
          <Button
            variant="soft"
            size="sm"
            icon="expand"
            onClick={(e) => {
              stopEvent(e);
              onInspect();
            }}
          >
            Inspect session
          </Button>
        </div>
      )}
    </div>
  );
}
