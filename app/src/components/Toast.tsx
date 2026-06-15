import { useEffect } from "react";
import { useAppStore } from "@/store";
import { Icon, type IconTone } from "./Icon";

type ToastKind = "info" | "success" | "error";

interface ToastInput {
  kind?: ToastKind;
  title: string;
  body?: string;
  duration?: number;
}

function encode(title: string, body?: string): string {
  return body ? `${title} — ${body}` : title;
}

function decode(message: string): { title: string; body?: string } {
  const idx = message.indexOf(" — ");
  if (idx === -1) return { title: message };
  return {
    title: message.slice(0, idx),
    body: message.slice(idx + 3),
  };
}

export function useToast() {
  const addToast = useAppStore((s) => s.addToast);

  return {
    success(message: string, body?: string) {
      addToast("success", encode(message, body));
    },
    error(message: string, body?: string) {
      addToast("error", encode(message, body));
    },
    info(message: string, body?: string) {
      addToast("info", encode(message, body));
    },
    push(t: ToastInput) {
      const kind: ToastKind = t.kind ?? "info";
      addToast(kind, encode(t.title, t.body));
    },
  };
}

function ToastItem({
  id,
  type,
  message,
}: {
  id: string;
  type: ToastKind;
  message: string;
}) {
  const removeToast = useAppStore((s) => s.removeToast);

  useEffect(() => {
    const t = setTimeout(() => removeToast(id), 3200);
    return () => clearTimeout(t);
  }, [id, removeToast]);

  const { title, body } = decode(message);
  const iconName =
    type === "error" ? "state.error" : type === "success" ? "state.ok" : "apply";
  const iconTone: IconTone | undefined =
    type === "error" ? "red" : type === "success" ? "green" : "amber";

  return (
    <div className={`toast toast-${type}`}>
      <span className="toast-icon">
        <Icon name={iconName} size={14} tone={iconTone} />
      </span>
      <div>
        <div className="toast-title">{title}</div>
        {body && <div className="toast-body">{body}</div>}
      </div>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} type={t.type} message={t.message} />
      ))}
    </div>
  );
}
