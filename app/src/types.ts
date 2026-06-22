export type SkillType = "claude-skill" | "mcp-server";
export type SkillScope = "global" | "portable" | "project-specific";

export type SkillManaged = "local" | "external" | "starter";

export interface SkillOrigin {
	source: string;
	source_type?: string;
	path?: string;
	ref?: string | null;
}

export interface Skill {
	version: string;
	description: string;
	source: string;
	type: SkillType;
	scope: SkillScope;
	upstream: string | null;
	/** Ownership marker. Missing means local (backward compatible). */
	managed?: SkillManaged;
	/** Set when this skill came from an external source. */
	origin?: SkillOrigin;
	/** True if the owning external source no longer carries this skill upstream. */
	source_missing?: boolean;
	/** Optional harness affinity list. */
	harnesses?: string[];
}

export interface ProjectAgentDocsPrefs {
	/** Per-project root-derivation strategy override (symlink | import). */
	root_strategy?: "symlink" | "import";
}

export interface Project {
	path: string;
	bundles: string[];
	enabled: string[];
	harnesses?: string[];
	agent_docs?: ProjectAgentDocsPrefs;
}

export type BundleScope = "global" | "project-specific";

export interface Bundle {
	description: string;
	icon: string;
	scope?: BundleScope;
	skills: string[];
}

export interface BootstrapBlock {
	completed_at: string;
	version: number;
}

// ─── Sources ────────────────────────────────────────────────────────────────
// Mirrors hub.py: built-in `local` / `starter` plus configured `git` (and a
// reserved `litellm` placeholder). The shape here matches the JSON emitted by
// `hub source list --json` and the top-level `sources:` block in registry.yaml.

export type SourceType = "local" | "starter" | "git" | "litellm";

export type SourceStatus =
	| "local"
	| "bundled"
	| "unknown"
	| "up-to-date"
	| "update-available"
	| "syncing"
	| "error";

/** Source entry as it lives inside `registry.yaml`. Git sources carry the rich
 *  metadata; built-in `local` / `starter` are inferred and won't appear here. */
export interface GitSourceConfig {
	type: "git";
	name?: string;
	url: string;
	branch?: string | null;
	path?: string;
	auth?: "system-git";
	cache?: string;
	current_ref?: string | null;
	remote_ref?: string | null;
	status?: SourceStatus;
	last_checked_at?: string | null;
	last_synced_at?: string | null;
	error?: string | null;
}

export interface LiteLLMSourceConfig {
	type: "litellm";
	name?: string;
	status?: SourceStatus;
}

export type SourceConfig = GitSourceConfig | LiteLLMSourceConfig;

/** Public view returned by `hub source list --json` / `hub source status`.
 *  Always includes the built-in `local` and `starter` entries. */
export interface SourceView {
	id: string;
	type: SourceType;
	name: string;
	builtin: boolean;
	status: SourceStatus;
	skill_count?: number;
	// Git-only fields (present only when type === "git"):
	url?: string;
	branch?: string | null;
	path?: string;
	auth?: string;
	cache?: string;
	current_ref?: string | null;
	remote_ref?: string | null;
	last_checked_at?: string | null;
	last_synced_at?: string | null;
	error?: string | null;
}

export interface Registry {
	version: string;
	hub_path: string;
	bootstrap?: BootstrapBlock;
	harnesses_global?: string[];
	skills: Record<string, Skill>;
	projects: Record<string, Project>;
	bundles: Record<string, Bundle>;
	/** Configured external sources keyed by id (built-ins are NOT stored here). */
	sources?: Record<string, SourceConfig>;
	/** User-defined permission presets keyed by id. Built-in presets are NOT
	 *  stored here — they are emitted from `permission_presets.py`. */
	permission_presets?: Record<string, UserPermissionPresetEntry>;
}

/** Shape of a user-defined preset as it appears in `registry.yaml`. */
export interface UserPermissionPresetEntry {
	name: string;
	description?: string;
	icon?: string;
	category?: string;
	rules: Array<{
		pattern: string;
		kind?: "allow" | "deny" | "ask";
		description?: string;
		enabled_by_default?: boolean;
	}>;
}

export interface Toast {
	id: string;
	type: "success" | "error" | "info";
	message: string;
}

export interface RecentItem {
	type: "skill" | "project" | "bundle" | "source";
	name: string;
}
