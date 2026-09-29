import { Fragment, useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import {
  focusedTooltipPosition,
  pointerTooltipPosition,
  tooltipPositionStyle,
  useTooltipPosition,
  type TooltipPosition,
} from "./tooltipPosition";

export interface StatCardHint {
  title: string;
  /** Paragraphs of explanation, plus an optional trailing `.stat-hint-sources`
   *  line — the caller composes these as `<p>` children. */
  body: ReactNode;
}

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Hover text on the hero value — the exact figure a compacted `value`
   *  ("29.5B", "845k") rounds away, so a reader can still get the precise
   *  number without leaving the card. */
  title?: string;
  sub?: ReactNode;
  /** A sub line as independent clauses ("18% output", "6% cache read")
   *  instead of one pre-joined string. Each clause renders in its own
   *  `.stat-clause` (never breaks mid-clause) with a ` · ` `.stat-sep`
   *  between — so a clause wraps as a whole onto the next line rather than
   *  splitting inside a word. Wins over `sub` when both are passed. */
  clauses?: ReactNode[];
  accent?: boolean;
  valueStyle?: CSSProperties;
  className?: string;
  /** A discoverable "why does this matter" overlay: an info mark at the end
   *  of the label row opens a `role="tooltip"` panel on hover/focus with a
   *  title + explanatory body. Absent by default — most tiles need none. */
  hint?: StatCardHint;
}

/** A hero value's length band, stamped as `data-value-len` so the stylesheet
 *  can step the type down for the string that needs it ("$3,885,000.00")
 *  and leave "$693.75" at full hero size in the same row. Only a string
 *  value can be measured; a node keeps the default size. */
function valueLength(value: ReactNode): "long" | "xlong" | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = String(value).length;
  if (n >= 12) return "xlong";
  if (n >= 9) return "long";
  return undefined;
}

export function StatCard({
  label,
  value,
  title,
  sub,
  clauses,
  accent,
  valueStyle,
  className,
  hint,
}: StatCardProps) {
  const hintId = useId();
  // Escape hides the panel without requiring the pointer to move; it stays
  // hidden until the pointer/focus actually leaves and comes back, so the
  // reader's dismissal isn't immediately undone by the hover that's still
  // sitting there.
  const [hintDismissed, setHintDismissed] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<TooltipPosition | null>(null);
  const [focusPosition, setFocusPosition] = useState<TooltipPosition | null>(null);
  const hintPosition = hoverPosition ?? focusPosition;
  const hintRef = useTooltipPosition(hintPosition, hint?.title ?? null);

  return (
    <div
      className={`stat-card ${accent ? "accent" : ""} ${className ?? ""}`.trim()}
      data-value-len={valueLength(value)}
      data-hint-dismissed={hint && hintDismissed ? "true" : undefined}
      tabIndex={hint ? 0 : undefined}
      aria-describedby={hint ? hintId : undefined}
      onMouseEnter={(event) => {
        if (hint) setHoverPosition(focusedTooltipPosition(event.currentTarget));
      }}
      onPointerMove={(event) => {
        if (!hint) return;
        setHoverPosition(
          Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
            ? pointerTooltipPosition(event.clientX, event.clientY)
            : focusedTooltipPosition(event.currentTarget),
        );
      }}
      onMouseLeave={() => {
        if (hint) {
          setHintDismissed(false);
          setHoverPosition(null);
        }
      }}
      onFocus={(event) => {
        if (hint) {
          setHoverPosition(null);
          setFocusPosition(focusedTooltipPosition(event.currentTarget));
        }
      }}
      onBlur={() => {
        if (hint) {
          setHintDismissed(false);
          setFocusPosition(null);
        }
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (hint && e.key === "Escape") setHintDismissed(true);
      }}
    >
      <div className="label">
        {label}
        {hint && (
          <span className="stat-hint-mark" aria-hidden="true">
            <Icon name="info" size={12} />
          </span>
        )}
      </div>
      <div className="value" style={valueStyle} title={title}>
        {value}
      </div>
      {clauses && clauses.length > 0 ? (
        <div className="sub">
          {clauses.map((clause, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <span className="stat-sep" aria-hidden="true">
                  {" "}
                  ·{" "}
                </span>
              )}
              <span className="stat-clause">{clause}</span>
            </Fragment>
          ))}
        </div>
      ) : (
        sub && <div className="sub">{sub}</div>
      )}
      {hint && (
        <div
          id={hintId}
          role="tooltip"
          className="stat-hint"
          ref={hintRef}
          data-side={hintPosition?.side ?? "right"}
          data-vertical={hintPosition?.vertical ?? "below"}
          style={tooltipPositionStyle(hintPosition)}
        >
          <div className="stat-hint-title">{hint.title}</div>
          <div className="stat-hint-body">{hint.body}</div>
        </div>
      )}
    </div>
  );
}
