import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { ResourceRow } from "./ResourceRow";
import { pressable } from "@/lib/pressable";

export interface BundleChipProps {
  name: string;
  icon: string;
  count?: number;
  color: string;
  onClick?: () => void;
  onRemove?: () => void;
  removeTitle?: string;
  removeBusy?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Root `title` attribute (e.g. "Open bundle <name>"). */
  title?: string;
  /** Extra content after the skill count, before the remove ✕ — e.g. a
   *  "follows this source" marker (§Bundle chip). Additive, not a slot
   *  override: the chip's own name/count/remove render unchanged. */
  trailing?: ReactNode;
}

export function BundleChip({
  name,
  icon,
  count,
  color,
  onClick,
  onRemove,
  removeTitle,
  removeBusy,
  className,
  style,
  title,
  trailing,
}: BundleChipProps) {
  return (
    <span
      className={`bundle-chip ${className ?? ""}`.trim()}
      {...pressable(onClick, { disabled: removeBusy })}
      style={style}
      title={title}
    >
      <span className="icon" style={{ background: color }}>
        {icon}
      </span>
      <span>{name}</span>
      {count !== undefined && (
        <span className="skills-count">
          · {count} {count === 1 ? "skill" : "skills"}
        </span>
      )}
      {trailing}
      {onRemove && (
        <Button
          size="sm"
          icon="x"
          busy={removeBusy}
          className="remove"
          title={removeBusy ? `Removing ${name}…` : removeTitle ?? "Remove"}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          {removeBusy ? "Removing…" : undefined}
        </Button>
      )}
    </span>
  );
}

export interface BundleChipAddOption {
  name: string;
  icon: string;
  color: string;
  count: number;
}

export interface BundleChipAddProps {
  children?: ReactNode;
  available: BundleChipAddOption[];
  onPick: (bundleName: string) => void;
  onClose?: () => void;
}

export function BundleChipAdd({
  children,
  available,
  onPick,
  onClose,
}: BundleChipAddProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        onClose?.();
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, onClose]);

  return (
    <span
      ref={wrapperRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="bundle-chip-add"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={11} />
        {children ?? "Apply bundle"}
      </button>
      {open && (
        <div role="menu" className="bundle-chip-add-menu">
          {available.length === 0 ? (
            <div className="empty">All bundles applied</div>
          ) : (
            available.map((b) => (
              <ResourceRow
                key={b.name}
                role="menuitem"
                className="bundle-pick-row"
                onClick={() => {
                  onPick(b.name);
                  setOpen(false);
                  onClose?.();
                }}
                glyph={
                  <span className="bundle-glyph" style={{ background: b.color }}>
                    {b.icon}
                  </span>
                }
                name={b.name}
                badges={<span className="bundle-count">{b.count}</span>}
              />
            ))
          )}
        </div>
      )}
    </span>
  );
}
