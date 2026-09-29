import type { ReactNode } from "react";
import { SINGLE_SERIES } from "./chartColors";

export interface BarRow {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  value: number;
  /** Usually a compacted string ("$6,921.07"), but a caller with nothing
   *  meaningful to price (an unpriced model) may render a node instead — a
   *  `<Tag>` reads honestly where a fabricated "$0.00" would not. */
  display: ReactNode;
  /** Hover text override — the exact count/money `display` rounds away (a
   *  compacted display value), or the reason behind a non-string `display`.
   *  Defaults to `display` itself when it is a plain string (already exact
   *  for a caller that never compacts); a node with no `titleText` gets no
   *  title at all rather than "[object Object]". */
  titleText?: string;
  color?: string;
}

export interface HorizontalBarListProps {
  rows: BarRow[];
  ariaLabel: string;
  /** Defaults to the largest row value. */
  max?: number;
}

/** Same clamp the column chart applies: one non-finite or negative row value
 *  must not flatten every other bar to 0% (a `NaN` max fails the `> 0` guard
 *  below for the whole list). */
function safeValue(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function HorizontalBarList({ rows, ariaLabel, max }: HorizontalBarListProps) {
  const computedMax = max ?? Math.max(1, ...rows.map((r) => safeValue(r.value)));

  return (
    <div className="hbar-list" role="list" aria-label={ariaLabel}>
      {rows.map((row) => {
        const pct =
          computedMax > 0 ? Math.max(0, Math.min(100, (safeValue(row.value) / computedMax) * 100)) : 0;
        return (
          <div
            className="hbar-row"
            role="listitem"
            key={row.key}
            title={row.titleText ?? (typeof row.display === "string" ? row.display : undefined)}
          >
            <div className="hbar-label-col">
              <span className="hbar-label">{row.label}</span>
              {row.sub != null && <span className="hbar-sub">{row.sub}</span>}
            </div>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{ width: `${pct}%`, background: row.color ?? SINGLE_SERIES }}
              />
            </div>
            <span className="hbar-value">{row.display}</span>
          </div>
        );
      })}
    </div>
  );
}
