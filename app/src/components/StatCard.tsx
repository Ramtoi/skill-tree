import type { CSSProperties, ReactNode } from "react";

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  valueStyle?: CSSProperties;
  className?: string;
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  valueStyle,
  className,
}: StatCardProps) {
  return (
    <div
      className={`stat-card ${accent ? "accent" : ""} ${className ?? ""}`.trim()}
    >
      <div className="label">{label}</div>
      <div className="value" style={valueStyle}>
        {value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
