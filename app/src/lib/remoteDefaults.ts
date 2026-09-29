import { parseCliJson } from "@/lib/skillPack";

export const REMOTE_POLL_INTERVAL_MIN = 30;
export const REMOTE_POLL_INTERVAL_MAX = 3600;
export const REMOTE_POLL_INTERVAL_DEFAULT = 60;

export interface RemoteDefaults {
  poll_interval_seconds: number;
}

export interface RemoteDefaultsReply {
  ok: boolean;
  configured: boolean;
  defaults: RemoteDefaults | null;
  error: { code: string; message: string; field?: string | null } | null;
}

function isValidDefaults(value: unknown): value is RemoteDefaults {
  if (!value || typeof value !== "object") return false;
  const seconds = (value as { poll_interval_seconds?: unknown }).poll_interval_seconds;
  return typeof seconds === "number" && Number.isInteger(seconds) &&
    seconds >= REMOTE_POLL_INTERVAL_MIN && seconds <= REMOTE_POLL_INTERVAL_MAX;
}

export function parseRemoteDefaults(output: string): RemoteDefaultsReply {
  const reply = parseCliJson<RemoteDefaultsReply>(output);
  const errorValid = reply.error === null || (
    typeof reply.error === "object" && reply.error !== null &&
    typeof reply.error.code === "string" && typeof reply.error.message === "string"
  );
  if (typeof reply.ok !== "boolean" || typeof reply.configured !== "boolean" ||
    !errorValid) {
    throw new Error("The backend returned invalid remote defaults.");
  }
  if (reply.ok && !isValidDefaults(reply.defaults)) {
    throw new Error("The backend returned invalid remote defaults.");
  }
  if (!reply.ok && reply.defaults !== null) {
    throw new Error("The backend returned invalid remote defaults.");
  }
  return reply;
}

export function parseRemotePollInterval(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= REMOTE_POLL_INTERVAL_MIN &&
    value <= REMOTE_POLL_INTERVAL_MAX ? value : undefined;
}
