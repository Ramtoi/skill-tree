import { useEffect, useRef, type ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** "checkbox" = box+check; "switch" = pill track+knob. Same semantics/keyboard. */
  variant?: "checkbox" | "switch";
  size?: "sm" | "md";
  disabled?: boolean;
  /** Optional inline label; clicking it toggles (wraps control in <label>). */
  label?: ReactNode;
  /** Tri-state for "some selected" pickers (checkbox variant only). */
  indeterminate?: boolean;
  ariaLabel?: string;
  id?: string;
  className?: string;
}

/**
 * The single brand-violet control. A real `<input type="checkbox">` carries all
 * a11y / focus / keyboard (Space toggles) for free; the box/switch skins are
 * painted with tokenized pseudo-elements over the visually-hidden input.
 * `indeterminate` is a DOM-only property, applied via a ref effect.
 */
export function Toggle({
  checked,
  onChange,
  variant = "checkbox",
  size = "md",
  disabled,
  label,
  indeterminate,
  ariaLabel,
  id,
  className,
}: ToggleProps) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && variant === "checkbox";
  }, [indeterminate, variant, checked]);

  const control = (
    <span
      className={`toggle toggle-${variant} toggle-${size}`}
      data-checked={checked || undefined}
      data-indeterminate={(indeterminate && variant === "checkbox") || undefined}
      data-disabled={disabled || undefined}
    >
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="toggle-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-skin" aria-hidden="true" />
    </span>
  );

  if (label === undefined) {
    return className ? <span className={className}>{control}</span> : control;
  }

  return (
    <label
      className={`toggle-field${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      {control}
      <span className="toggle-label">{label}</span>
    </label>
  );
}
