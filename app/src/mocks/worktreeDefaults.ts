import type { WorktreeDefaults, WorktreeDefaultsReply } from "@/lib/worktreeDefaults";

const KEY = "st:mock:worktree-defaults";
const DEFAULTS: WorktreeDefaults = {
  location: "shared-directory", base_dir: "~/Dev/worktrees",
  access_enabled: false, include_in_backup: false,
};

/** Preview fixture only. Python fixture tests establish actual path semantics. */
export function mockWorktreeDefaults(args: string[]): WorktreeDefaultsReply {
  const stored = localStorage.getItem(KEY);
  let defaults = stored ? JSON.parse(stored) as WorktreeDefaults : { ...DEFAULTS };
  const configIndex = args.indexOf("--config-json");
  if (configIndex >= 0) defaults = JSON.parse(args[configIndex + 1]) as WorktreeDefaults;
  if (!defaults.base_dir.startsWith("/") && !defaults.base_dir.startsWith("~/")) {
    return { ok: false, configured: !!stored, defaults, preview: null,
      error: { code: "invalid_config", field: "base_dir", message: "Base directory must be absolute or use ~/." } };
  }
  if (args[2] === "set") localStorage.setItem(KEY, JSON.stringify(defaults));
  const name = args[args.indexOf("--name") + 1];
  const path = args[args.indexOf("--path") + 1];
  const preview = args[2] === "preview" ? {
    path: defaults.location === "project-subdirectory" ? `${path}/.worktrees` :
      `${defaults.base_dir.replace(/^~/, "/Users/dev").replace(/\/+$/, "")}/${name}`,
    access_enabled: defaults.access_enabled,
    missing_directory: true,
  } : null;
  return { ok: true, configured: !!stored || args[2] === "set", defaults, preview, error: null };
}
