import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface EmptyStateProps {
  icon?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({
  icon = "search",
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
