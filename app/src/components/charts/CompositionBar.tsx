import { compositionPercents } from "./compositionPercents";

export interface Segment {
  id: string;
  label: string;
  value: number;
  color: string;
}

export interface CompositionBarProps {
  segments: Segment[];
  format: (v: number) => string;
  ariaLabel: string;
}

export function CompositionBar({ segments, format, ariaLabel }: CompositionBarProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  // Legend percentages: a non-zero segment never prints "0%", and a share
  // under 1% renders through `formatPercent` instead of rounding to nothing
  // — see `compositionPercents` for the full rule.
  const percents = compositionPercents(
    segments.map((s) => s.value),
    total,
  );

  return (
    <div className="comp-bar-wrap">
      <div className="comp-bar" role="img" aria-label={ariaLabel}>
        {visible.map((seg) => {
          const pct = total > 0 ? (seg.value / total) * 100 : 0;
          return (
            <div
              key={seg.id}
              data-segment={seg.id}
              className="comp-bar-seg"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${seg.label}: ${format(seg.value)}`}
            />
          );
        })}
      </div>
      <div className="comp-bar-legend">
        {segments.map((seg, index) => {
          const pct = percents[index] ?? "0%";
          return (
            <div className="comp-bar-legend-item" key={seg.id}>
              <span className="comp-bar-swatch" style={{ background: seg.color }} aria-hidden="true" />
              <span className="comp-bar-legend-label">{seg.label}</span>
              <span className="comp-bar-legend-value">{format(seg.value)}</span>
              <span className="comp-bar-legend-pct">{pct}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
