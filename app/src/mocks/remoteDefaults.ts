import type { RemoteDefaults, RemoteDefaultsReply } from "@/lib/remoteDefaults";

const KEY = "st:mock:remote-defaults";
const DEFAULTS: RemoteDefaults = { poll_interval_seconds: 60 };

export function mockRemoteDefaults(args: string[]): RemoteDefaultsReply {
  const stored = localStorage.getItem(KEY);
  let defaults = stored ? JSON.parse(stored) as RemoteDefaults : { ...DEFAULTS };
  const valueIndex = args.indexOf("--poll-interval-seconds");
  if (valueIndex >= 0) defaults = { poll_interval_seconds: Number(args[valueIndex + 1]) };
  if (!Number.isInteger(defaults.poll_interval_seconds) || defaults.poll_interval_seconds < 30 || defaults.poll_interval_seconds > 3600) {
    return { ok: false, configured: !!stored, defaults: null,
      error: { code: "invalid_remote_defaults", field: "poll_interval_seconds", message: "Polling interval must be an integer from 30 to 3600 seconds." } };
  }
  if (args[2] === "set") localStorage.setItem(KEY, JSON.stringify(defaults));
  return { ok: true, configured: !!stored || args[2] === "set", defaults, error: null };
}
