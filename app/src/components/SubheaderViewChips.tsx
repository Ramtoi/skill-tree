import { Icon } from "./Icon";

export interface ViewChip<V extends string> {
  id: V;
  label: string;
  icon?: string;
}

export interface SubheaderViewChipsProps<V extends string> {
  views: Array<ViewChip<V>>;
  value: V;
  onChange: (v: V) => void;
}

/**
 * Canonical view-mode tab row for the header subheader (Project / Agent Docs /
 * Skill editor / Project permissions). Renders the `.chips` shell with
 * `aria-pressed` state; drop it into `subheader.left` as the first element.
 */
export function SubheaderViewChips<V extends string>({
  views,
  value,
  onChange,
}: SubheaderViewChipsProps<V>) {
  return (
    <div className="chips" role="tablist">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          className="chip"
          role="tab"
          aria-pressed={value === v.id}
          onClick={() => onChange(v.id)}
          title={v.label}
        >
          {v.icon && <Icon name={v.icon} size={12} />}
          <span className="chip-label">{v.label}</span>
        </button>
      ))}
    </div>
  );
}
