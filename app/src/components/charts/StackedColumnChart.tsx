import { type ReactNode, useId, useMemo, useState } from "react";
import {
  focusedTooltipPosition,
  pointerTooltipPosition,
  tooltipPositionStyle,
  useTooltipPosition,
  type TooltipPosition,
} from "../tooltipPosition";

export interface Series {
  id: string;
  label: string;
  color: string;
  swatch?: ReactNode;
}

/** Deliberately a bare string union, not an import from a usage-domain
 *  module: this is a generic chart primitive, and `usageChartColumns.ts`'s
 *  `UsageDayProvenance` is structurally identical, so no cross-feature
 *  dependency is needed for the two to agree. */
export type ColumnProvenance = "scanned" | "frozen" | "backfilled";
export interface ChartColumnMarker { id: string; label: string; harness?: string }

export interface Column {
  key: string;
  label: string;
  tooltipLabel: string;
  values: Record<string /* series id */, number>;
  /** A calendar-boundary marker (a month change on a `day` axis, January on
   *  a `month` axis) — rendered `--fg-mute` instead of the usual `--fg-dim`
   *  so a long axis still reads without hovering for the tooltip. */
  labelEmphasis?: boolean;
  /** Render this column's label even when `labelStep` would otherwise thin
   *  it away — reserved for the same calendar-boundary markers. */
  labelPinned?: boolean;
  /** Where this column's data came from — surfaced as `data-provenance` on
   *  `.chart-col` (totals, tooltip and `aria-label` unchanged). Absent for a
   *  chart with no provenance concept at all; a caller that HAS the concept
   *  always sets it (`usageChartColumns.ts`'s `buildStackedColumns`). Only
   *  `"backfilled"` changes anything visually today (a faded segment, see
   *  `charts.css`). */
  provenance?: ColumnProvenance;
  markers?: ChartColumnMarker[];
}

export interface StackedColumnChartProps {
  series: Series[];
  columns: Column[];
  format: (v: number) => string;
  ariaLabel: string;
  /** Plot height in px. Default 160. */
  height?: number;
  emptyText?: string;
  /** Show the legend automatically for 2+ series, or always including one series. */
  legend?: "auto" | "always";
  onSelectColumn?: (key: string) => void;
}

const DEFAULT_HEIGHT = 160;
/** Above this column count, only every k-th x-label renders (k = ceil(n/12)). */
const LABEL_THIN_THRESHOLD = 24;

/**
 * One column's value for one series, clamped. `values` arrives from a
 * normalizer over a user-editable cache, so a non-finite or negative number
 * is reachable: a single `NaN` would poison `maxTotal` and turn every
 * segment's height into `"NaN%"` (nothing renders, no error), and a negative
 * value would subtract from the total the tooltip and the `aria-label`
 * announce. Every consumer below reads through this, so the total, the
 * segment heights, the legend and the tooltip can never disagree.
 */
function seriesValue(col: Column, seriesId: string): number {
  const raw = col.values[seriesId];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function columnTotal(col: Column, series: Series[]): number {
  return series.reduce((sum, s) => sum + seriesValue(col, s.id), 0);
}

/** The change from the previous column's total, or `null` when there is no
 *  previous column (the first one) or its total is zero (a percentage
 *  against zero is undefined, not "infinite growth"). */
function deltaVsPrevious(
  columns: Column[],
  series: Series[],
  idx: number,
): { direction: "up" | "down" | "none"; pct: number } | null {
  if (idx <= 0) return null;
  const previousTotal = columnTotal(columns[idx - 1], series);
  if (previousTotal <= 0) return null;
  const total = columnTotal(columns[idx], series);
  if (total === previousTotal) return { direction: "none", pct: 0 };
  const pct = ((total - previousTotal) / previousTotal) * 100;
  return { direction: pct > 0 ? "up" : "down", pct: Math.round(Math.abs(pct)) };
}

export function StackedColumnChart({
  series,
  columns,
  format,
  ariaLabel,
  height = DEFAULT_HEIGHT,
  emptyText = "No data for this range",
  legend = "auto",
  onSelectColumn,
}: StackedColumnChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<TooltipPosition | null>(null);
  const [focusPosition, setFocusPosition] = useState<TooltipPosition | null>(null);
  // Hovering a segment or a legend item narrows attention to one series —
  // independent of which column (if any) is active.
  const [emphasisSeries, setEmphasisSeries] = useState<string | null>(null);
  const activeIdx = hoverIdx ?? focusIdx;
  const tooltipPosition = hoverIdx != null ? hoverPosition : focusPosition;
  const tooltipId = useId();

  const maxTotal = useMemo(
    () => Math.max(1, ...columns.map((c) => columnTotal(c, series))),
    [columns, series],
  );

  const labelStep =
    columns.length > LABEL_THIN_THRESHOLD ? Math.ceil(columns.length / 12) : 1;

  const activeColumn = activeIdx != null ? columns[activeIdx] : null;
  const delta = activeIdx != null ? deltaVsPrevious(columns, series, activeIdx) : null;
  const tooltipRef = useTooltipPosition(tooltipPosition, activeIdx);
  const side: "left" | "right" = tooltipPosition?.side ?? (
    activeIdx != null && columns.length > 0 && (activeIdx + 0.5) / columns.length > 0.5
      ? "left"
      : "right"
  );

  function clearEmphasis(id: string) {
    setEmphasisSeries((current) => (current === id ? null : current));
  }

  return (
    <div className="chart chart-stacked-column">
      {(legend === "always" || series.length >= 2) && (
        <div className="chart-legend">
          {series.map((s) => {
            const total = columns.reduce((sum, c) => sum + seriesValue(c, s.id), 0);
            return (
              <div
                className="chart-legend-item"
                key={s.id}
                data-emphasis={emphasisSeries === s.id ? "true" : undefined}
                onMouseEnter={() => setEmphasisSeries(s.id)}
                onMouseLeave={() => clearEmphasis(s.id)}
              >
                {s.swatch ?? (
                  <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                )}
                <span className="chart-legend-label">{s.label}</span>
                <span className="chart-legend-value">{format(total)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="chart-plot" style={{ height }} role="group" aria-label={ariaLabel}>
        {columns.length === 0 ? (
          <div className="chart-empty">{emptyText}</div>
        ) : (
          <>
            <div className="chart-grid" aria-hidden="true">
              {[0, 0.5, 1].map((frac) => (
                <div key={frac} className="chart-grid-row" style={{ bottom: `${frac * 100}%` }}>
                  <span className="chart-grid-line" />
                  <span className="chart-grid-label">{format(maxTotal * frac)}</span>
                </div>
              ))}
            </div>

            {/* `data-has-active` lets the stylesheet recede every OTHER column
                while one is hovered/focused — so the column the tooltip
                describes is the only one at full ink, instead of a faint
                wash under an otherwise unchanged row of bars. */}
            <div className="chart-columns" data-has-active={activeIdx != null ? "true" : undefined}>
              {columns.map((col, idx) => {
                const total = columnTotal(col, series);
                return (
                  /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- columns retain keyboard tooltip navigation; selectable charts add button semantics. */
                  <div
                    key={col.key}
                    className="chart-col"
                    data-provenance={col.provenance}
                    data-active={activeIdx === idx ? "true" : undefined}
                    /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- grouped charts retain keyboard tooltip navigation without announcing an action. */
                    tabIndex={0}
                    role={onSelectColumn ? "button" : undefined}
                    aria-label={`${col.tooltipLabel}: ${format(total)}${col.markers?.length ? ` · ${col.markers.length} loadout change${col.markers.length === 1 ? "" : "s"}` : ""}`}
                    // What makes `role="tooltip"` legitimate: the active
                    // column points at the live tooltip, so a screen reader
                    // reaches the per-series breakdown a sighted user gets on
                    // hover instead of only the column's own total.
                    aria-describedby={activeIdx === idx ? tooltipId : undefined}
                    onMouseEnter={(event) => {
                      setHoverIdx(idx);
                      setHoverPosition(focusedTooltipPosition(event.currentTarget));
                    }}
                    onPointerMove={(event) => {
                      setHoverIdx(idx);
                      setHoverPosition(
                        Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
                          ? pointerTooltipPosition(event.clientX, event.clientY)
                          : focusedTooltipPosition(event.currentTarget),
                      );
                    }}
                    onMouseLeave={() => {
                      setHoverIdx((i) => (i === idx ? null : i));
                      setHoverPosition(null);
                    }}
                    onFocus={(event) => {
                      setHoverIdx(null);
                      setHoverPosition(null);
                      setFocusIdx(idx);
                      setFocusPosition(focusedTooltipPosition(event.currentTarget));
                    }}
                    onBlur={() => {
                      setFocusIdx((i) => (i === idx ? null : i));
                      setFocusPosition(null);
                    }}
                    onClick={onSelectColumn ? (event) => {
                      event.currentTarget.focus();
                      onSelectColumn?.(col.key);
                    } : undefined}
                    // Escape dismisses the tooltip without giving up the
                    // column's focus — the same out a menu or a popover has.
                    // Arrow keys walk the focused column to its neighbour —
                    // both are plain DOM siblings, so no index bookkeeping.
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setFocusIdx(null);
                        setHoverIdx(null);
                        setFocusPosition(null);
                        setHoverPosition(null);
                      } else if (onSelectColumn && (event.key === "Enter" || event.key === " " || event.key === "Spacebar")) {
                        event.preventDefault();
                        event.currentTarget.focus();
                        onSelectColumn?.(col.key);
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        const sibling = (
                          event.key === "ArrowLeft"
                            ? event.currentTarget.previousElementSibling
                            : event.currentTarget.nextElementSibling
                        ) as HTMLElement | null;
                        if (sibling) {
                          event.preventDefault();
                          sibling.focus();
                        }
                      }
                    }}
                  >
                    <div className="chart-col-bars">
                      {total <= 0 ? (
                        <div className="chart-col-stub" />
                      ) : (
                        series
                          .filter((s) => seriesValue(col, s.id) > 0)
                          .map((s) => {
                            const pct = (seriesValue(col, s.id) / maxTotal) * 100;
                            return (
                              <div
                                key={s.id}
                                data-series={s.id}
                                data-faded={
                                  emphasisSeries != null && emphasisSeries !== s.id ? "true" : undefined
                                }
                                className="chart-col-seg"
                                style={{ height: `${pct}%`, background: s.color }}
                                onMouseEnter={() => setEmphasisSeries(s.id)}
                                onMouseLeave={() => clearEmphasis(s.id)}
                              />
                            );
                          })
                      )}
                      {col.markers && col.markers.length > 0 && (
                        <span className="chart-col-marker" data-count={col.markers.length} aria-hidden="true" style={{ bottom: `${(total / maxTotal) * 100}%` }} />
                      )}
                    </div>
                    {(idx % labelStep === 0 || col.labelPinned) && (
                      <span
                        className="chart-col-label"
                        data-emphasis={col.labelEmphasis ? "true" : undefined}
                      >
                        {col.label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div
              className={`chart-tooltip${activeColumn ? " is-visible" : ""}`}
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              data-side={side}
              data-vertical={tooltipPosition?.vertical ?? "below"}
              aria-hidden={activeColumn == null}
              style={tooltipPositionStyle(tooltipPosition)}
            >
              {activeColumn && (
                <>
                  <div className="chart-tooltip-title">{activeColumn.tooltipLabel}</div>
                  <div className="chart-tooltip-summary">
                    <div className="chart-tooltip-total">
                      {format(columnTotal(activeColumn, series))}
                    </div>
                    {delta && (
                      <div className="chart-tooltip-delta">
                        {delta.direction === "none"
                          ? "no change"
                          : `${delta.direction === "up" ? "▲" : "▼"} ${delta.pct}% vs previous`}
                      </div>
                    )}
                  </div>
                  {series.length > 1 && series
                    .filter((s) => seriesValue(activeColumn, s.id) > 0)
                    .map((s) => {
                      const value = seriesValue(activeColumn, s.id);
                      const share = Math.round((value / columnTotal(activeColumn, series)) * 100);
                      return (
                        <div
                          className="chart-tooltip-row"
                          key={s.id}
                          data-emphasis={emphasisSeries === s.id ? "true" : undefined}
                        >
                          <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                          <span className="chart-tooltip-row-label">{s.label}</span>
                          <span className="chart-tooltip-row-value">
                            {format(value)}
                            <span className="chart-tooltip-row-share"> · {share}%</span>
                          </span>
                        </div>
                      );
                    })}
                  {activeColumn.markers?.map((marker) => (
                    <div className="chart-tooltip-row chart-tooltip-marker-row" key={marker.id}>
                      <span className="chart-tooltip-row-label">{marker.label}</span>
                      <span className="chart-tooltip-row-value">{marker.harness ?? ""}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
