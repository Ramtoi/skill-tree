import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

export interface BundleChipProps {
  name: string;
  icon: string;
  count?: number;
  color: string;
  onClick?: () => void;
  onRemove?: () => void;
  removeTitle?: string;
  className?: string;
  style?: CSSProperties;
}

export function BundleChip({
  name,
  icon,
  count,
  color,
  onClick,
  onRemove,
  removeTitle,
  className,
  style,
}: BundleChipProps) {
  return (
    <span
      className={`bundle-chip ${className ?? ""}`.trim()}
      onClick={onClick}
      style={style}
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
      {onRemove && (
        <button
          type="button"
          className="remove"
          title={removeTitle ?? "Remove"}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="x" size={11} />
        </button>
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
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "var(--bg-3)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            padding: 4,
            minWidth: 200,
            zIndex: 5,
            boxShadow: "0 12px 30px -10px rgba(0,0,0,0.6)",
          }}
        >
          {available.length === 0 ? (
            <div
              style={{
                padding: 10,
                fontSize: 11,
                color: "var(--fg-mute)",
              }}
            >
              All bundles applied
            </div>
          ) : (
            available.map((b) => (
              <button
                type="button"
                key={b.name}
                className="avail-skill"
                onClick={() => {
                  onPick(b.name);
                  setOpen(false);
                  onClose?.();
                }}
              >
                <span
                  className="icon"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    display: "grid",
                    placeItems: "center",
                    background: b.color,
                    color: "var(--bg-0)",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {b.icon}
                </span>
                <span className="name">{b.name}</span>
                <span
                  className="text-dim text-mono"
                  style={{ fontSize: 10.5 }}
                >
                  {b.count}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </span>
  );
}
