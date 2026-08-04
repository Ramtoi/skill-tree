import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface ErrorCardProps {
  title: ReactNode;
  description?: ReactNode;
  cmd?: ReactNode;
  fix?: ReactNode[];
  actions?: ReactNode;
}

export function ErrorCard({
  title,
  description,
  cmd,
  fix,
  actions,
}: ErrorCardProps) {
  return (
    <div className="error-card">
      <h2>
        <Icon name="warning" size={18} /> {title}
      </h2>
      {description && (
        <div
          style={{
            color: "var(--fg-mute)",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {description}
        </div>
      )}
      {cmd && (
        <div className="cmd">
          <span className="prompt">$</span> {cmd}
        </div>
      )}
      {fix && (
        <>
          <div className="fix-label">Fix</div>
          <ol>
            {fix.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>
        </>
      )}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
