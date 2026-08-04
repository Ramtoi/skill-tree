export interface PowerPipsProps {
  on: number;
  total?: number;
  color?: string;
  ariaLabel?: string;
}

export function PowerPips({
  on,
  total = 7,
  color,
  ariaLabel,
}: PowerPipsProps) {
  return (
    <div className="pips" aria-label={ariaLabel ?? `level ${on}/${total}`}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className="pip"
          style={i < on ? { background: color ?? "var(--violet)" } : undefined}
        />
      ))}
    </div>
  );
}
