/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- the plot is a pointer surface, while point buttons retain keyboard access. */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  focusedTooltipPosition,
  pointerTooltipPosition,
  tooltipPositionStyle,
  useTooltipPosition,
  type TooltipPosition,
} from "../tooltipPosition";

export interface LinePoint {
  x: string;
  y: number;
}

export interface LineChartSeries {
  id: string;
  label: string;
  color: string;
  points: LinePoint[];
}

export interface LineChartProps {
  series: LineChartSeries[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  formatAxis?: (x: string) => string;
  formatX?: (x: string) => string;
  emptyText?: string;
  legend?: "auto" | "always";
  onSelectPoint?: (x: string) => void;
}

const PLOT_HEIGHT = 160;
const PLOT_PADDING = 8;
const MAX_AXIS_LABELS = 6;

function safeValue(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatDateLabel(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
}

export function LineChart({
  series,
  ariaLabel,
  formatValue,
  formatAxis = formatDateLabel,
  formatX = formatDateLabel,
  emptyText = "No data for this range",
  legend = "auto",
  onSelectPoint,
}: LineChartProps) {
  const tooltipId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<{ series: number; point: number } | null>(null);
  const [roving, setRoving] = useState({ series: 0, point: 0 });
  const [pointer, setPointer] = useState<{ series: number; point: number; position: TooltipPosition } | null>(null);
  const [focusPosition, setFocusPosition] = useState<TooltipPosition | null>(null);
  const [legendSeries, setLegendSeries] = useState<number | null>(null);
  const domain = useMemo(
    () => [...new Set(series.flatMap((item) => item.points.map((point) => point.x)))].sort(),
    [series],
  );
  const values = useMemo(
    () =>
      series.map((item) => {
        const byX = new Map(item.points.map((point) => [point.x, safeValue(point.y)]));
        return domain.map((x) => byX.get(x) ?? 0);
      }),
    [domain, series],
  );

  useEffect(() => {
    setRoving((current) => ({
      series: Math.max(0, Math.min(series.length - 1, current.series)),
      point: Math.max(0, Math.min(domain.length - 1, current.point)),
    }));
    setFocused((current) =>
      current && current.series < series.length && current.point < domain.length
        ? current
        : null,
    );
    setPointer((current) =>
      current && current.series < series.length && current.point < domain.length
        ? current
        : null,
    );
  }, [series.length, domain.length]);

  const positionedTooltip = domain.length > 0 ? pointer?.position ?? focusPosition : null;
  const tooltipRef = useTooltipPosition(
    positionedTooltip,
    pointer ? `${pointer.series}:${pointer.point}` : focused ? `${focused.series}:${focused.point}` : null,
  );

  if (domain.length === 0) return <div className="line-chart-empty">{emptyText}</div>;

  const dataMax = Math.max(0, ...values.flat());
  const max = dataMax > 0 ? dataMax * 1.1 : 1;
  const validPointer =
    pointer && pointer.series < series.length && pointer.point < domain.length ? pointer : null;
  const validFocused =
    focused && focused.series < series.length && focused.point < domain.length ? focused : null;
  const tooltip = validPointer ?? validFocused;
  const tooltipPosition = validPointer?.position ?? focusPosition;
  const emphasis = validPointer?.series ?? validFocused?.series ?? legendSeries;

  function xPercent(index: number): number {
    return domain.length === 1 ? 50 : (index / (domain.length - 1)) * 100;
  }

  function yPercent(value: number): number {
    return (
      (PLOT_PADDING + (1 - value / max) * (PLOT_HEIGHT - PLOT_PADDING * 2)) /
        PLOT_HEIGHT
    ) * 100;
  }

  function moveFocus(seriesIndex: number, pointIndex: number): void {
    const nextSeries = Math.max(0, Math.min(series.length - 1, seriesIndex));
    const nextPoint = Math.max(0, Math.min(domain.length - 1, pointIndex));
    setRoving({ series: nextSeries, point: nextPoint });
    setFocused({ series: nextSeries, point: nextPoint });
    document.getElementById(`${tooltipId}-${nextSeries}-${nextPoint}`)?.focus();
  }

  function activatePoint(seriesIndex: number, pointIndex: number): void {
    if (!onSelectPoint) return;
    const nextSeries = Math.max(0, Math.min(series.length - 1, seriesIndex));
    const nextPoint = Math.max(0, Math.min(domain.length - 1, pointIndex));
    setRoving({ series: nextSeries, point: nextPoint });
    setFocused({ series: nextSeries, point: nextPoint });
    document.getElementById(`${tooltipId}-${nextSeries}-${nextPoint}`)?.focus();
    onSelectPoint?.(domain[nextPoint]);
  }

  function pointerSelection(clientX: number, clientY: number): { series: number; point: number; position: TooltipPosition } | null {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || !series.length || rect.width <= 0 || rect.height <= 0) return null;
    const position =
      domain.length === 1
        ? 0
        : Math.max(0, Math.min(domain.length - 1, ((clientX - rect.left) / rect.width) * (domain.length - 1)));
    const point =
      domain.length === 1
        ? 0
        : Math.max(
            0,
            Math.min(
              domain.length - 1,
              Math.round(position),
            ),
          );
    const y = ((clientY - rect.top) / rect.height) * PLOT_HEIGHT;
    let nearest = 0;
    let distance = Infinity;
    values.forEach((row, index) => {
      const left = Math.floor(position);
      const right = Math.min(left + 1, row.length - 1);
      const fraction = position - left;
      const value = row.length === 1 ? row[0] : row[left] + (row[right] - row[left]) * fraction;
      const rowY = PLOT_PADDING + (1 - value / max) * (PLOT_HEIGHT - PLOT_PADDING * 2);
      const nextDistance = Math.abs(rowY - y);
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = index;
      }
    });
    return { series: nearest, point, position: pointerTooltipPosition(clientX, clientY) };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clientX = Number.isFinite(event.clientX) ? event.clientX : rect.left;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : rect.top;
    const selection = pointerSelection(clientX, clientY);
    if (selection) setPointer(selection);
  }

  return (
    <div className="chart line-chart" role="group" aria-label={ariaLabel}>
      {(series.length >= 2 || legend === "always") && (
        <div className="chart-legend line-chart-legend">
          {series.map((item, index) => (
            <div
              className="chart-legend-item"
              data-emphasis={emphasis === index ? "true" : undefined}
              key={item.id}
              onMouseEnter={() => setLegendSeries(index)}
              onMouseLeave={() => setLegendSeries(null)}
            >
              <span
                className="chart-swatch"
                style={{ background: item.color }}
                aria-hidden="true"
              />
              <span className="chart-legend-label" title={item.label}>{item.label}</span>
              <strong>{formatValue(values[index].reduce((sum, value) => sum + value, 0))}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="line-chart-plot" style={{ height: PLOT_HEIGHT }}>
        <div className="line-chart-axis line-chart-axis-max">{formatValue(dataMax)}</div>
        <div className="line-chart-axis line-chart-axis-zero">{formatValue(0)}</div>
        <div className="line-chart-gridline line-chart-gridline-max" />
        <div className="line-chart-gridline line-chart-gridline-zero" />
        <div
          className="line-chart-area"
          ref={areaRef}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setPointer(null)}
          onClick={/* a11y-ok: Enlarged pointer targets delegate to the keyboard-accessible point buttons below. */ (event) => {
            if (!onSelectPoint || (event.target instanceof Element && event.target.closest(".line-chart-tooltip"))) return;
            const selection = pointerSelection(event.clientX, event.clientY);
            if (selection) activatePoint(selection.series, selection.point);
          }}
        >
          <svg
            className="line-chart-svg"
            viewBox={`0 0 100 ${PLOT_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {values.map((points, seriesIndex) => (
              <polyline
                key={series[seriesIndex].id}
                className="line-chart-line"
                data-series={series[seriesIndex].id}
                data-emphasis={
                  emphasis == null
                    ? undefined
                    : emphasis === seriesIndex
                      ? "true"
                      : "false"
                }
                points={points
                  .map(
                    (value, pointIndex) =>
                      `${xPercent(pointIndex)},${PLOT_PADDING + (1 - value / max) * (PLOT_HEIGHT - PLOT_PADDING * 2)}`,
                  )
                  .join(" ")}
                stroke={series[seriesIndex].color}
              />
            ))}
          </svg>
          {series.map((item, seriesIndex) =>
            values[seriesIndex].map((value, pointIndex) => (
              <button
                className="line-chart-point"
                data-single={domain.length === 1 ? "true" : undefined}
                data-series={item.id}
                data-x={domain[pointIndex]}
                id={`${tooltipId}-${seriesIndex}-${pointIndex}`}
                key={`${item.id}-${domain[pointIndex]}`}
                style={{ left: `${xPercent(pointIndex)}%`, top: `${yPercent(value)}%`, color: item.color }}
                type="button"
                tabIndex={
                  roving.series === seriesIndex && roving.point === pointIndex ? 0 : -1
                }
                aria-label={`${item.label}, ${domain[pointIndex]}: ${formatValue(value)}`}
                aria-describedby={tooltip?.point === pointIndex ? tooltipId : undefined}
                onFocus={(event) => {
                  setPointer(null);
                  setRoving({ series: seriesIndex, point: pointIndex });
                  setFocused({ series: seriesIndex, point: pointIndex });
                  setFocusPosition(focusedTooltipPosition(event.currentTarget));
                }}
                onClick={onSelectPoint ? (event) => {
                  event.stopPropagation();
                  activatePoint(seriesIndex, pointIndex);
                } : undefined}
                onBlur={() => {
                  setFocused(null);
                  setFocusPosition(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    moveFocus(seriesIndex, pointIndex - 1);
                  }
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    moveFocus(seriesIndex, pointIndex + 1);
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveFocus(seriesIndex - 1, pointIndex);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveFocus(seriesIndex + 1, pointIndex);
                  }
                }}
              />
            )),
          )}
          {tooltip && (
            <>
              <div
                className="line-chart-guide"
                aria-hidden="true"
                style={{ left: `${xPercent(tooltip.point)}%` }}
              />
              <div
                id={tooltipId}
                role="tooltip"
                className="chart-tooltip line-chart-tooltip"
                ref={tooltipRef}
                data-side={tooltipPosition?.side ?? (xPercent(tooltip.point) > 50 ? "left" : "right")}
                data-vertical={tooltipPosition?.vertical ?? "above"}
                style={tooltipPositionStyle(tooltipPosition)}
              >
                <div className="chart-tooltip-title">{formatX(domain[tooltip.point])}</div>
                {series.map((item, index) => (
                  <div
                    className="chart-tooltip-row"
                    data-emphasis={
                      index === (validPointer?.series ?? validFocused?.series) ? "true" : undefined
                    }
                    key={item.id}
                  >
                    <span
                      className="chart-swatch"
                      style={{ background: item.color }}
                      aria-hidden="true"
                    />
                    <span className="chart-tooltip-row-label">{item.label}</span>
                    <span className="chart-tooltip-row-value">
                      {formatValue(values[index][tooltip.point] ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="line-chart-x-axis" aria-hidden="true">
        {domain.map((x, index) => {
          // Six labels fit a 520 px card without touching; more collide.
          const step = domain.length > MAX_AXIS_LABELS ? Math.ceil(domain.length / MAX_AXIS_LABELS) : 1;
          const show =
            index === 0 ||
            index === domain.length - 1 ||
            (index % step === 0 && index + step < domain.length);
          if (!show) return null;
          return (
            <span
              data-edge={
                index === 0 ? "start" : index === domain.length - 1 ? "end" : undefined
              }
              key={x}
              style={{ left: `${xPercent(index)}%` }}
            >
              {formatAxis(x)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
