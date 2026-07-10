import { Children, cloneElement, isValidElement, type ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  full?: boolean;
  children: ReactNode;
  className?: string;
  /** Inline validation error. When set, the control gets aria-invalid and the
   *  message renders below it (role="alert"). */
  error?: ReactNode;
  /** Non-error helper text below the control (suppressed while an error shows). */
  hint?: ReactNode;
  /** Optional id linking the control to its error text for aria-describedby. */
  htmlFor?: string;
}

export function Field({ label, full, children, className, error, hint, htmlFor }: FieldProps) {
  const invalid = error != null && error !== false;
  const cls = `field${full ? " field-full" : ""}${invalid ? " field-invalid" : ""}${className ? ` ${className}` : ""}`;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;

  // Best-effort: stamp aria-invalid on a single element child so validation is
  // surfaced on the control itself (per the form-validation contract).
  let control = children;
  if (invalid) {
    const only = Children.toArray(children).filter(isValidElement);
    if (only.length === 1) {
      control = cloneElement(
        only[0] as React.ReactElement,
        { "aria-invalid": true, "aria-describedby": errorId } as Record<string, unknown>,
      );
    }
  }

  return (
    <div className={cls}>
      <label htmlFor={htmlFor}>{label}</label>
      {control}
      {invalid ? (
        <span className="field-error" role="alert" id={errorId}>
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
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
