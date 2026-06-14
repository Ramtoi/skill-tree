import { Tag } from "./Tag";
import { Icon } from "./Icon";

export interface RiskBadgeProps {
  code: string;
  severity: "danger" | "warning";
  explanation: string;
  /** Optional supplemental detail appended to the tooltip. */
  detail?: string;
}

/** Inline pill: amber (warning) or red (danger). Code in mono. */
export function RiskBadge({
  code,
  severity,
  explanation,
  detail,
}: RiskBadgeProps) {
  const color = severity === "danger" ? "var(--red)" : "var(--amber)";
  const tooltip = detail ? `${explanation}\n\n${detail}` : explanation;
  return (
    <span title={tooltip} style={{ display: "inline-flex" }}>
      <Tag
        color={color}
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.04em",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Icon name="warning" size={11} />
        {code}
      </Tag>
    </span>
  );
}
