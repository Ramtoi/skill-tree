import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Content max width in px; rendered as min(width, 92vw). Default 480. */
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  /** Element focused on open; defaults to the first focusable in the dialog. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Backdrop-click / Esc dismissal. Default true; false for blocking flows. */
  dismissable?: boolean;
  className?: string;
  /** Layout intent — center (modal) or right side (sheet). */
  side?: "center" | "right";
  "aria-label"?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The single overlay base. Portal + backdrop scrim + focus trap + Esc/backdrop
 * close + restore-focus-on-close + `min(width,92vw)` + `role="dialog"`/`aria-modal`.
 * ConfirmDialog and Sheet are thin presets that own copy/layout, not mechanics.
 */
export function Modal({
  open,
  onClose,
  title,
  width = 480,
  children,
  footer,
  initialFocus,
  dismissable = true,
  className,
  side = "center",
  "aria-label": ariaLabel,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Remember the opener so focus can be restored on close.
  useEffect(() => {
    if (open) openerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  // Initial focus into the dialog. If focus already landed inside (the user
  // started interacting before this frame), never steal it away.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const node = dialogRef.current;
      if (node?.contains(document.activeElement)) return;
      if (initialFocus?.current) {
        initialFocus.current.focus();
        return;
      }
      if (!node) return;
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, initialFocus]);

  // Restore focus to the opener when the dialog closes/unmounts.
  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    if (opener && typeof opener.focus === "function") opener.focus();
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
      );
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dismissable, onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      className={`modal-backdrop${side === "right" ? " modal-backdrop-right" : ""}`}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal-${side}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? (title as string) : ariaLabel}
        tabIndex={-1}
        style={{ width: `min(${width}px, 92vw)` }}
        onKeyDown={onKeyDown}
      >
        {title && (
          <div className="modal-head">
            <span className="modal-title">{title}</span>
            {dismissable && (
              <Button
                variant="ghost"
                size="sm"
                icon="x"
                title="Close"
                onClick={onClose}
                className="modal-close"
              />
            )}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body?: ReactNode;
  /** Blast-radius / consequence content rendered above the actions. */
  blastRadius?: ReactNode;
  confirmLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  /** Gate the confirm button on a precondition (e.g. a dry-run resolved + a
   *  "yes I understand" checkbox ticked). Independent of `busy`. */
  confirmDisabled?: boolean;
  cancelLabel?: string;
  confirmIcon?: string;
  /** Content max width in px; rendered as min(width, 92vw). Default 440. */
  width?: number;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  blastRadius,
  confirmLabel = "Confirm",
  tone = "default",
  busy = false,
  confirmDisabled = false,
  cancelLabel = "Cancel",
  confirmIcon,
  width = 440,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={width}
      dismissable={!busy}
      className="confirm-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            icon={busy ? undefined : confirmIcon}
            leading={busy ? <span className="btn-spinner" aria-hidden="true" /> : undefined}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="confirm-body">{body}</div>}
      {blastRadius && <div className="confirm-blast">{blastRadius}</div>}
    </Modal>
  );
}

export interface SheetProps extends Omit<ModalProps, "width" | "side"> {
  side?: "center" | "right";
  width?: number;
}

export function Sheet({ side = "center", width = 640, ...rest }: SheetProps) {
  return <Modal {...rest} side={side} width={width} />;
}
