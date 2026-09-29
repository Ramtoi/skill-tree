import type { InvocationOutcome } from "@/lib/invocation";
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";

export interface NativeLimitation { area: string; harness: string; name: string; message: string; binding?: string; risk?: string }

export interface MachinePreview {
  limitations?: NativeLimitation[];
  ok?: boolean;
  state?: string;
  candidate?: Revision | null;
  applied?: Revision | null;
  plan_digest: string | null;
  approval_digest: string | null;
  blockers: { code: string; path?: string; binding?: string }[];
  changes?: { path: string; action: string }[];
  changes_total?: number;
  native_review?: { entries: unknown[]; files: { path: string; content: string }[]; removals: unknown[]; retained_bindings: string[] } | null;
}
export interface Machine {
  id: string;
  connector: string;
  phase: string;
  sync_enabled: boolean;
  error?: string;
  draft?: {
    phase?: string;
    revision: number;
    input: { ssh_host?: string; host_key_sha256?: string; feed_url?: string;
      poll_interval_seconds: number; private_feed_confirmed?: boolean };
    observations: { start?: { applied?: unknown }; interval_update?: { requested_interval: number; state: string; message: string }; connect?: string; install?: { command: string };
      configure?: { feed_id?: string; interval?: number; replace_feed?: boolean };
      channel_conflict?: { feed_id?: string; publisher_key_id?: string; controller_key_id?: string; applied?: { generation?: number; applied_at?: string } };
      /** Mock-only marker: forces `preview` to fail with `feed_reconnect_required`. Never sent by the real backend. */
      needs_reconnect_demo?: boolean;
      preview?: MachinePreview; status?: { applied?: Revision | null; paused?: boolean };
      inspection?: { observed_at: string; plan: MachinePreview; published?: Revision | null } };
  };
  bindings?: Record<string, { source_project: string; mode: string; harnesses: string[]; global_native?: string[]; global_agents?: string[];
    confirmation?: { observed_at: string } }>;
  delivery?: { state: string; desired?: { digest: string } | null; published?: Revision | null;
    applied?: Revision | null; observed_at?: string | null; error?: { message: string; code?: string; retryable?: boolean } | null;
    invocation?: (InvocationOutcome & { binding: string })[]; invocation_total?: number; native_limitations?: NativeLimitation[] } | null;
  result?: MachinePreview & { candidates?: CheckoutDiscoveryCandidate[];
    issues?: { path?: string; code: string; message?: string }[]; partial?: boolean };
}
export interface CheckoutDiscoveryMatch {
  source_project: string;
  source_remote: string;
  destination_remote: string;
  checkout_path: string;
  association?: { url: string; remote: string; subdirectory: string };
}
export interface CheckoutDiscoveryCandidate {
  path: string;
  git_root?: string;
  is_worktree?: boolean;
  remotes?: { url: string; remote: string; subdirectory: string }[];
  matches?: CheckoutDiscoveryMatch[];
}
export interface Revision { revision: string; generation: number }

/** Carries the backend's error `code` (e.g. `channel_rotation_required`)
 *  alongside the unchanged message, so callers that only ever did
 *  `String(err)` keep seeing the same text. */
export class MachineError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function machineCommand<T = Machine>(verb: string, args: string[] = []): Promise<T> {
  const response = await hubCmd(["remote", "machine", verb, ...args, "--json"]);
  const reply = parseCliJson<{ ok: boolean; result: T; error?: { message: string; code?: string } }>(hubStreams(response).stdout);
  if (typeof reply.ok !== "boolean") throw new MachineError("Invalid machine response.");
  if (!response.success || !reply.ok) throw new MachineError(reply.error?.message || "Machine operation failed.", reply.error?.code);
  if (!reply.result || typeof reply.result !== "object") throw new MachineError("Missing machine response.");
  return reply.result;
}
