import { type ReactNode } from "react";

export interface SectionHeaderProps {
  label: ReactNode;
  count?: number | string;
  right?: ReactNode;
  level?: 1 | 2;
  /** Accent color for the leading dot (used in Group-by-Source headers). */
  accent?: string;
  /** Right-aligned secondary detail string (e.g., URL · branch · path). */
  detail?: ReactNode;
}

export function SectionHeader({
  label,
  count,
  right,
  level = 1,
  accent,
  detail,
}: SectionHeaderProps) {
  return (
    <div className={`section-header lvl-${level}`}>
      {accent && (
        <span
          className="section-accent-dot"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 8,
            background: accent,
            marginRight: 8,
            flexShrink: 0,
          }}
        />
      )}
      <span className="section-label">{label}</span>
      {count !== undefined && <span className="section-count">{count}</span>}
      {detail && (
        <span
          className="section-detail"
          style={{
            marginLeft: "auto",
            color: "var(--fg-mute)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {detail}
        </span>
      )}
      {right && <span className="section-right">{right}</span>}
    </div>
  );
}
