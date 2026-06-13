import { useEffect, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  head?: ReactNode;
  foot?: ReactNode;
  children?: ReactNode;
}

export function DetailDrawer({
  open,
  onClose,
  head,
  foot,
  children,
}: DetailDrawerProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className="detail-drawer" data-open={open}>
      <div className="detail-head">
        {head}
        <button
          type="button"
          className="close"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="detail-body">{children}</div>
      {foot && <div className="detail-foot">{foot}</div>}
    </div>
  );
}
