import { useMemo, useState } from "react";
import { ChipRadios } from "@/components/ChipRadios";
import { sequentialSteps } from "@/components/charts/chartColors";
import type { UsageDailyPoint } from "@/features/usage/usageTypes";
import { formatCompact } from "./usageFormat";
import { dateFmt } from "./usageChartColumns";
import { heatmapCells, monthLabelIndices, moveIndex, type HeatmapMode } from "./usageHeatmap";
import type { UsagePeriodKind } from "./usagePeriod";

export interface UsageActivityHeatmapProps {
  daily: UsageDailyPoint[];
  harnessId: string | null;
  windowEnd: string;
  onSelectPeriod?: (key: string, kind: UsagePeriodKind) => void;
}

const MODES = [
  { value: "daily" as const, label: "Daily" },
  { value: "weekly" as const, label: "Weekly" },
  { value: "cumulative" as const, label: "Cumulative" },
];
const HEATMAP_MODE_KEY = "st:usage:heatmapMode";

function readHeatmapMode(): HeatmapMode {
  try {
    const value = localStorage.getItem(HEATMAP_MODE_KEY);
    return value === "daily" || value === "weekly" || value === "cumulative" ? value : "daily";
  } catch {
    return "daily";
  }
}

export function UsageActivityHeatmap({ daily, harnessId, windowEnd, onSelectPeriod }: UsageActivityHeatmapProps) {
  const [mode, setMode] = useState<HeatmapMode>(readHeatmapMode);
  const [focusIndex, setFocusIndex] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // The tooltip line reads only while a cell is hovered or the grid holds
  // focus; idle, the line stays empty (same as the spend chart's tooltip).
  const [gridFocused, setGridFocused] = useState(false);
  const cells = useMemo(() => {
    const scoped = harnessId === null
      ? daily
      : daily.map((point) => ({
          ...point,
          harnesses: point.harnesses.filter((harness) => harness.id === harnessId),
          tokens: point.harnesses.filter((harness) => harness.id === harnessId)
            .reduce((sum, harness) => ({ ...sum, total: sum.total + harness.tokens.total }), {
              input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0,
            }),
        }));
    return heatmapCells(scoped, windowEnd, mode);
  }, [daily, harnessId, mode, windowEnd]);
  const tooltipIndex = hoverIndex ?? (gridFocused ? focusIndex : null);
  const tooltipCell = tooltipIndex === null ? undefined : cells[tooltipIndex];
  const tooltipId = "usage-activity-heatmap-tooltip";
  const steps = sequentialSteps(5);
  const formatDate = dateFmt(undefined, { month: "long", day: "numeric", year: "numeric" });
  const tooltipText = tooltipCell
    ? mode === "weekly"
      ? `${formatCompact(tooltipCell.weekTokens)} tokens in the week of ${formatDate.format(new Date(`${cells[tooltipCell.column * 7].date}T00:00:00Z`))}`
      : `${formatCompact(mode === "cumulative" ? tooltipCell.runningTotal : tooltipCell.tokens)} tokens on ${formatDate.format(new Date(`${tooltipCell.date}T00:00:00Z`))}`
    : "";

  function move(index: number) {
    const next = Math.max(0, Math.min(cells.length - 1, index));
    setFocusIndex(next);
    document.getElementById(`usage-heatmap-cell-${next}`)?.focus();
  }

  function changeMode(value: HeatmapMode) {
    setMode(value);
    try {
      localStorage.setItem(HEATMAP_MODE_KEY, value);
    } catch {
      /* best-effort persistence only */
    }
  }

  return (
    <section className="usage-card usage-activity-card" aria-label="Token activity">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Token activity</span>
          <h3>Activity over the last year</h3>
        </div>
        <ChipRadios name="usage-heatmap-mode" label="View" value={mode} options={MODES} onChange={changeMode} />
      </div>
      <div className="usage-heatmap-scroll">
        <div className="usage-heatmap-months" aria-hidden="true">
          {monthLabelIndices(cells).map((column) => {
            const cell = cells[column * 7];
            return (
            <span key={cell.date} style={{ gridColumn: cell.column + 1 }}>{dateFmt(undefined, { month: "short" }).format(new Date(`${cell.date}T00:00:00Z`))}</span>
            );
          })}
        </div>
        <div
          className="usage-heatmap-grid"
          role="grid"
          aria-label={`Token activity, ${mode}`}
          onFocus={() => setGridFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGridFocused(false);
          }}
        >
          {Array.from({ length: 7 }, (_, row) => (
            <div role="row" key={row} className="usage-heatmap-row">
              {cells.filter((cell) => cell.row === row).map((cell) => {
                const index = cell.column * 7 + cell.row;
                return (
                  <button
                    id={`usage-heatmap-cell-${index}`}
                    key={cell.date}
                    type="button"
                    role="gridcell"
                    className="usage-heatmap-cell"
                    data-level={cell.level}
                    style={{ background: cell.level > 0 ? steps[5 - cell.level] : "var(--bg-3)" }}
                    aria-rowindex={row + 1}
                    aria-colindex={cell.column + 1}
                    aria-label={mode === "weekly"
                      ? `${formatCompact(cell.weekTokens)} tokens in the week of ${formatDate.format(new Date(`${cells[cell.column * 7].date}T00:00:00Z`))}`
                      : `${formatCompact(mode === "cumulative" ? cell.runningTotal : cell.tokens)} tokens on ${formatDate.format(new Date(`${cell.date}T00:00:00Z`))}`}
                    aria-describedby={tooltipId}
                    tabIndex={index === focusIndex ? 0 : -1}
                    onFocus={() => setFocusIndex(index)}
                    onMouseEnter={() => setHoverIndex(index)}
                    onMouseLeave={() => setHoverIndex(null)}
                    onClick={() => {
                      onSelectPeriod?.(cell.date, mode === "weekly" ? "week" : "day");
                    }}
                    onKeyDown={(event) => {
                      if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        move(moveIndex(index, event.key, { rows: 7, columns: 52 }));
                      }
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div id={tooltipId} role="tooltip" className="usage-heatmap-tooltip" aria-live="polite">{tooltipText}</div>
    </section>
  );
}
