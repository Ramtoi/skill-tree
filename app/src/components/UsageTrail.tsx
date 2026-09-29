import { SINGLE_SERIES } from "@/components/charts/chartColors";

export interface UsageTrailProps {
  /** One bucket per day of the requested window; the card always passes a 30-day payload. */
  values: readonly number[];
  ariaLabel: string;
  height?: number;
}

export function UsageTrail({ values, ariaLabel, height = 14 }: UsageTrailProps) {
  const maximum = Math.max(1, ...values);
  const bucketWidth = values.length ? 100 / values.length : 100;
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      className="usage-trail"
      viewBox={`0 0 100 ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      {values.map((value, index) => {
        const barHeight = value > 0 ? Math.max(1, (value / maximum) * height) : 1;
        return (
          <rect
            key={`${index}-${value}`}
            x={index * bucketWidth}
            y={value > 0 ? height - barHeight : height - 1}
            width={Math.max(0.5, bucketWidth - 0.5)}
            height={barHeight}
            fill={value > 0 ? SINGLE_SERIES : "var(--border)"}
          />
        );
      })}
    </svg>
  );
}
