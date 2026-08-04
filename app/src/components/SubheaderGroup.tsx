import { type ReactNode } from "react";

export interface SubheaderGroupProps {
  /** Optional uppercase mono label rendered before the controls. */
  label?: string;
  children: ReactNode;
}

/**
 * A labelled cluster of controls in the header subheader (e.g. "SOURCE [chips]").
 * Consecutive `SubheaderGroup`s auto-separate via the `+ .subheader-group`
 * border rule — never add manual separators between them.
 */
export function SubheaderGroup({ label, children }: SubheaderGroupProps) {
  return (
    <div className="subheader-group">
      {label && <span className="subheader-group-label">{label}</span>}
      {children}
    </div>
  );
}
