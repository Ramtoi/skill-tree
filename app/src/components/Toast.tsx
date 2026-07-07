import { useEffect } from "react";
import { useAppStore } from "@/store";
import type { Toast, ToastAction, ToastKind } from "@/types";
import { Icon, type IconTone } from "./Icon";

interface ToastInput {
  kind?: ToastKind;
  title: string;
  body?: string;
  duration?: number;
  action?: ToastAction;
}

/** Per-kind default auto-dismiss timeouts. Errors linger longer (D10). */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  error: 6000,
  success: 3200,
  info: 3200,
};

export function useToast() {
  const pushToast = useAppStore((s) => s.pushToast);

  return {
    success(title: string, body?: string) {
      pushToast({ kind: "success", title, body });
    },
    error(title: string, body?: string) {
      pushToast({ kind: "error", title, body });
    },
    info(title: string, body?: string) {
      pushToast({ kind: "info", title, body });
    },
    push(t: ToastInput) {
      pushToast({ kind: t.kind ?? "info", title: t.title, body: t.body, duration: t.duration, action: t.action });
    },
  };
}

function ToastItem({ id, kind, title, body, duration, action }: Toast) {
  const removeToast = useAppStore((s) => s.removeToast);

  useEffect(() => {
    const ms = duration ?? DEFAULT_DURATION[kind];
    const t = setTimeout(() => removeToast(id), ms);
    return () => clearTimeout(t);
  }, [id, kind, duration, removeToast]);

  const iconName =
    kind === "error" ? "state.error" : kind === "success" ? "state.ok" : "state.update";
  const iconTone: IconTone | undefined =
    kind === "error" ? "red" : kind === "success" ? "green" : "blue";

  return (
    <div className={`toast toast-${kind}`} role="status">
      <span className="toast-icon">
        <Icon name={iconName} size={14} tone={iconTone} />
      </span>
      <div className="toast-content">
        <div className="toast-title">{title}</div>
        {body && <div className="toast-body">{body}</div>}
      </div>
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.onClick();
            removeToast(id);
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => removeToast(id)}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>
  );
}
