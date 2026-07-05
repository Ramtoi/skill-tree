import { type CSSProperties } from "react";

export interface SpinnerProps {
  size?: number;
  stroke?: number;
  color?: string;
}

/** Atomic loading ring. Always pair with a label — never use it as the only
 *  loading indicator on a control. */
export function Spinner({ size = 12, stroke = 1.6, color }: SpinnerProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderWidth: stroke,
    borderTopColor: color ?? "currentColor",
  };
  return <span className="lds-spinner" style={style} aria-hidden="true" />;
}
