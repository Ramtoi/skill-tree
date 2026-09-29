import { formatCapturedCount } from "./usageFormat";
import { Fragment, useMemo, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { identityColor } from "@/components/charts/chartColors";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { plural } from "@/lib/plural";
import { ccusageToHubHarness, harnessColorIndex, orderHarnessIds } from "./harnessIdentity";
import { parseModelId } from "./modelIdentity";
import type { HarnessTotal } from "./usageAggregate";
import { formatCompact, formatCount, formatMoney, formatPercent, formatRelativeTime, type UsageCurrency } from "./usageFormat";

export interface UsageHarnessBreakdownProps {
  harnesses: HarnessTotal[];
  /** Display names of harnesses ccusage supports that have never shown any
   *  local usage on this machine — a stable, range-independent list. */
  noUsageNames: string[];
  currency: UsageCurrency;
  eurRate: number;
  /** The ccusage cache timestamp. Freshness is evaluated when the screen is entered. */
  scannedAt?: string;
  busy: boolean;
  onScan: () => void;
}

/** Left card of the two-column band: one row per harness with any usage in
 *  the active scope, fixed series order, a token-share track in the
 *  harness's identity color, and a folded disclosure for every
 *  ccusage-supported harness that has never shown local usage at all. */
export function UsageHarnessBreakdown({ harnesses, noUsageNames, currency, eurRate, scannedAt, busy, onScan }: UsageHarnessBreakdownProps) {
  const orderedIds = useMemo(() => orderHarnessIds(harnesses.map((h) => h.id)), [harnesses]);
  const byId = useMemo(() => new Map(harnesses.map((h) => [h.id, h])), [harnesses]);
  const totalTokens = harnesses.reduce((sum, h) => sum + h.tokens.total, 0);

  return (
    <section className="usage-card usage-harness-card" aria-label="Harness breakdown">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Harness breakdown</span>
          <h3>Where the tokens went</h3>
          <span className="usage-note">{scannedAt ? `scanned ${formatRelativeTime(scannedAt)}` : "no cached scan yet"}</span>
        </div>
        <Button variant="soft" size="sm" icon="rescan" busy={busy} onClick={onScan}>Scan</Button>
      </div>
      <div className="usage-harness-list">
        {orderedIds.map((id) => {
          const harness = byId.get(id)!;
          const hubHarness = ccusageToHubHarness(id);
          const share = totalTokens > 0 ? harness.tokens.total / totalTokens : 0;
          // The top-model entry reads as its display name — the raw id
          // still recovers on hover, via the wrapping span's own title
          // below (never a second, nested span: one span per clause).
          const subParts: Array<{ node: ReactNode; title?: string }> = [
            { node: `${formatCount(harness.sessions)} ${plural(harness.sessions, "session")}` },
            { node: `${formatCapturedCount(harness.toolCalls, harness.toolCallsKnown !== false)} ${plural(harness.toolCalls, "tool call")}` },
            ...(harness.topModel
              ? [{ node: parseModelId(harness.topModel).display, title: harness.topModel }]
              : []),
          ];
          return (
            <div className="usage-harness-row" key={id}>
              {hubHarness ? <HarnessGlyph id={hubHarness} size={22} decorative /> : <span className="usage-harness-glyph-fallback" aria-hidden="true" />}
              <div className="usage-harness-info">
                <strong>{harness.name}</strong>
                <span className="usage-harness-meta">
                  {subParts.map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && (
                        <span className="usage-harness-sep" aria-hidden="true">
                          ·
                        </span>
                      )}
                      <span title={part.title}>{part.node}</span>
                    </Fragment>
                  ))}
                </span>
              </div>
              <div className="usage-share-track" aria-hidden="true">
                <div className="usage-share-fill" style={{ width: `${share * 100}%`, background: identityColor(harnessColorIndex(id)) }} />
              </div>
              <div className="usage-row-numbers">
                <b title={formatCount(harness.tokens.total)}>{formatCompact(harness.tokens.total)}</b>
                <span
                  title={harness.costPartial ? "Partial: excludes this harness's backfilled days" : undefined}
                >
                  {formatMoney(harness.costUsd, currency, eurRate)}
                  {harness.costPartial && <span className="usage-partial-mark">*</span>}
                </span>
                <span className="usage-share-pct">{formatPercent(share)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {noUsageNames.length > 0 && (
        <details className="usage-fold">
          <summary>{noUsageNames.length} more {plural(noUsageNames.length, "harness", "harnesses")} ccusage supports show no local usage</summary>
          <p className="usage-note">{noUsageNames.join(", ")}</p>
        </details>
      )}
    </section>
  );
}
