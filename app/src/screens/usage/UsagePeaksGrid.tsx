import { useState } from "react";
import { sequentialSteps } from "@/components/charts/chartColors";
import { percentileLevels, moveIndexRowMajor } from "./usageHeatmap";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const tokenFormat = new Intl.NumberFormat("en-US");
const formatDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));

export function UsagePeaksGrid({ grid, since, until }: { grid: number[][]; since: string | null; until: string | null }) {
  const values = grid.flat();
  const levels = percentileLevels(values, 5);
  const [focus, setFocus] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const steps = sequentialSteps(5);
  const period = since && until ? `${formatDate(since)} to ${formatDate(until)}`
    : since ? `from ${formatDate(since)} onward`
    : until ? `through ${formatDate(until)}` : "all recorded dates";
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const labelFor = (index: number, value = values[index] ?? 0) => {
    const hour = index % 24;
    return `${tokenFormat.format(value)} tokens total across all ${weekdays[Math.floor(index / 24)]}s, ${String(hour).padStart(2, "0")}:00 to ${String(hour + 1).padStart(2, "0")}:00 UTC, ${period}`;
  };
  // The monospaced label is widest with Wednesday and the largest count.
  // Keep its wrapped height in the layout even when no cell is active.
  const sizingLabel = labelFor(2 * 24, Math.max(0, ...values));
  const tooltipIndex = active ?? focused;
  const tooltip = tooltipIndex === null ? "" : labelFor(tooltipIndex);
  return <section className="usage-card usage-peaks-card" aria-label="Peaks">
    <span className="usage-kicker">Peaks</span><h3>When tokens happen</h3>
    <p className="usage-note">Totals by weekday and hour · {period}</p>
    <div className="usage-peaks-grid-wrap">
      <div className="usage-peaks-row-labels" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day.slice(0, 3)}</span>)}</div>
      <div className="usage-peaks-grid" role="grid" aria-label="Token peaks by weekday and UTC hour">
        {values.map((_, index) => <button key={index} role="gridcell" type="button" tabIndex={index === focus ? 0 : -1}
        className="usage-peaks-cell" data-level={levels[index]} style={{ background: levels[index] ? steps[levels[index] - 1] : "var(--bg-3)" }}
        aria-label={labelFor(index)}
        onFocus={() => { setFocus(index); setFocused(index); }} onBlur={() => setFocused(null)} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}
        onKeyDown={(event) => { if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = moveIndexRowMajor(index, event.key, { rows: 7, columns: 24 }); setFocus(next); document.querySelector<HTMLButtonElement>(`[data-peak-index="${next}"]`)?.focus(); } }} data-peak-index={index} />)}
      </div>
      <div className="usage-peaks-hour-labels" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span></div>
    </div><div className="usage-heatmap-tooltip usage-peaks-tooltip">
      <span className="usage-peaks-tooltip-size" aria-hidden="true">{sizingLabel}</span>
      <span role="tooltip">{tooltip}</span>
    </div>
  </section>;
}
