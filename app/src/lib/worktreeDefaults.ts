import { parseCliJson } from "@/lib/skillPack";

export interface WorktreeDefaults {
  location: "shared-directory" | "project-subdirectory";
  base_dir: string;
  access_enabled: boolean;
  include_in_backup: boolean;
}

export interface WorktreePreview {
  path: string;
  access_enabled: boolean;
  missing_directory: boolean;
}

export interface WorktreeDefaultsReply {
  ok: boolean;
  configured: boolean;
  defaults: WorktreeDefaults;
  preview: WorktreePreview | null;
  error: { code: string; message: string; field?: string | null } | null;
}

export function parseWorktreeDefaults(output: string): WorktreeDefaultsReply {
  const reply = parseCliJson<WorktreeDefaultsReply>(output);
  if (!reply.ok) throw new Error(reply.error?.message ?? "Could not read worktree defaults.");
  const defaults = reply.defaults;
  if (!defaults || !["shared-directory", "project-subdirectory"].includes(defaults.location) ||
    typeof defaults.base_dir !== "string" || typeof defaults.access_enabled !== "boolean" ||
    typeof defaults.include_in_backup !== "boolean") {
    throw new Error("The backend returned invalid worktree defaults.");
  }
  return reply;
}

export function worktreeDefaultsEqual(a: WorktreeDefaults, b: WorktreeDefaults): boolean {
  return a.location === b.location && a.base_dir === b.base_dir &&
    a.access_enabled === b.access_enabled && a.include_in_backup === b.include_in_backup;
}
