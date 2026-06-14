import { type ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  full?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, full, children, className }: FieldProps) {
  const cls = `field${full ? " field-full" : ""}${className ? ` ${className}` : ""}`;
  return (
    <div className={cls}>
      <label>{label}</label>
      {children}
    </div>
  );
}

export interface MetaGridProps {
  children: ReactNode;
  className?: string;
}

export function MetaGrid({ children, className }: MetaGridProps) {
  return (
    <div className={`meta-grid${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
