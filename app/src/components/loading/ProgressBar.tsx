import { type CSSProperties } from "react";

export interface ProgressBarProps {
  /** 0..1 (determinate) or null/undefined (indeterminate shimmer). */
  value?: number | null;
  height?: number;
  accent?: string;
}

export function ProgressBar({ value = null, height = 2, accent }: ProgressBarProps) {
  const indeterminate = value === null || value === undefined;
  const rootStyle = {
    height,
    "--lds-accent": accent ?? "var(--violet)",
  } as CSSProperties;
  const fillStyle: CSSProperties | undefined = indeterminate
    ? undefined
    : { width: `${Math.max(0, Math.min(1, value)) * 100}%` };
  return (
    <div
      className="lds-progress"
      data-indeterminate={indeterminate || undefined}
      style={rootStyle}
    >
      <div className="lds-progress-fill" style={fillStyle} />
    </div>
  );
}
