import { StatusBadge } from "./StatusBadge";

export interface RiskBadgeProps {
  code: string;
  severity: "danger" | "warning";
  explanation: string;
  /** Optional supplemental detail appended to the tooltip. */
  detail?: string;
}

/**
 * Permissions-risk pill — a thin preset of `StatusBadge` (D10). danger→error
 * (red), warning→warn (amber); the code renders mono. No brand violet.
 */
export function RiskBadge({
  code,
  severity,
  explanation,
  detail,
}: RiskBadgeProps) {
  const tooltip = detail ? `${explanation}\n\n${detail}` : explanation;
  return (
    <StatusBadge
      channel={severity === "danger" ? "error" : "warn"}
      shape="pill"
      icon="warning"
      title={tooltip}
      className="risk-badge"
    >
      <span style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
        {code}
      </span>
    </StatusBadge>
  );
}
