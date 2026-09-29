import type { ReactNode } from "react";

export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={className ? `disclosure ${className}` : "disclosure"}>
      <summary>{summary}</summary>
      <div className="disclosure-content">{children}</div>
    </details>
  );
}
