import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface ViewChip<V extends string> {
  id: V;
  label: string;
  icon?: string;
  /** Tooltip, for a label that doesn't say on its own what the view holds
   *  (a permission scope names a project, not what is in it). Falls back to
   *  `label`. */
  hint?: string;
  /** A count shown after the label (`.chip .count`) — what the view holds,
   *  so a row of chips can say "8 · 4 · 9 · 2" before any is opened. */
  count?: ReactNode;
  /** A warn dot after the label: the view holds something needing attention.
   *  Amber is the severity register; never a hue that means "selected". */
  attention?: "warn" | null;
}

export interface SubheaderViewChipsProps<V extends string> {
  views: Array<ViewChip<V>>;
  value: V;
  onChange: (v: V) => void;
  /** Accessible name of the tablist, when more than one is on screen. */
  ariaLabel?: string;
}

/**
 * Canonical view-mode tab row for the header subheader (Project / Agent Docs /
 * Skill editor / Project permissions). Renders the `.chips` shell as a real
 * `tablist`; drop it into `subheader.left` as the first element.
 *
 * Selection is carried by `aria-selected`, NOT `aria-pressed`: `aria-pressed`
 * is only defined on `role="button"`, so a `role="tab"` emitting it announced
 * a toggle button's state on a widget assistive tech was told is a tab. The
 * `.chip` rule matches both attributes, so the hand-rolled toggle chips
 * elsewhere in the app keep their styling unchanged.
 */
export function SubheaderViewChips<V extends string>({
  views,
  value,
  onChange,
  ariaLabel,
}: SubheaderViewChipsProps<V>) {
  return (
    <div className="chips" role="tablist" aria-label={ariaLabel}>
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className="chip"
          role="tab"
          aria-selected={value === v.id}
          onClick={() => onChange(v.id)}
          title={v.hint ?? v.label}
        >
          {v.icon && <Icon name={v.icon} size={12} />}
          <span className="chip-label">{v.label}</span>
          {v.count != null && <span className="count">{v.count}</span>}
          {v.attention && (
            <span
              className="dot"
              data-tone={v.attention}
              role="img"
              aria-label="needs attention"
            />
          )}
        </button>
      ))}
    </div>
  );
}
