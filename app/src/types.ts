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

export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface Toast {
	id: string;
	kind: ToastKind;
	title: string;
	body?: string;
	/** Auto-dismiss timeout in ms. Defaults per-kind (errors linger longer). */
	duration?: number;
	/** Optional trailing action button (label + handler). */
	action?: ToastAction;
}

export interface RecentItem {
	type: "skill" | "project" | "bundle" | "source" | "remote";
	name: string;
}

// ─── Remotes (remote connectors) ──────────────────────────────────────────────
// Shapes mirror the JSON emitted by `hub remote … --json` (see hub.py
// cmd_remote_*). The registry stores only references; secrets live in the OS
// keychain (handled in Rust).

/** One row of `hub remote list --json`. */
export interface RemoteListEntry {
	id: string;
	connector: string;
	sync_enabled: boolean;
	apply_global_bundles: boolean;
	ssh_host: string | null;
	bundles: string[];
	enabled: string[];
}

/** `hub remote show <id> --json` — config + resolved skills. */
export interface RemoteShow {
	id: string;
	connector: string;
	ssh_host: string | null;
	host_key_pinned: boolean;
	secret_ref: string | null;
	home: string | null;
	sync_enabled: boolean;
	apply_global_bundles: boolean;
	bundles: string[];
	enabled: string[];
	resolved_skills: string[];
}

/** Per-artifact drift status — `local-ahead` fast-forwards; everything else is
 *  surfaced and waits for an explicit resolve op (D8). */
export type DriftStatus =
	| "in-sync"
	| "local-ahead"
	| "remote-drifted"
	| "conflict"
	| "orphaned"
	| "missing"
	| null;

/** One row in a `hub remote diff <id> --json` plan. */
export interface RemoteDiffAction {
	name: string;
	kind: string; // skill | mcp | agent_doc
	action: string; // noop | create | fast_forward | SKIP_* | remove
	drift: DriftStatus;
}

/** `hub remote diff <id> --json` — either a plan (ready) or a health shape. */
export interface RemoteDiffPlan {
	remote: string;
	actions?: RemoteDiffAction[];
	// Health shape (returned when the remote is not ready):
	reachable?: boolean;
	ok?: boolean;
	detail?: string;
}

/** One box-native skill from `hub remote import-skill --scan --json`. */
export interface RemoteImportCandidate {
	name: string;
	ref: string;
	sha256: string;
	category: "NEW" | "INVALID_NAME" | "ALREADY_REGISTERED";
	origin: string; // e.g. "remote:hermes-main"
}

export interface RemoteImportScan {
	remote: string;
	candidates: RemoteImportCandidate[];
}

/** One LIVE agent doc on the box from `hub remote list-docs <id> --json`. */
export interface RemoteLiveDoc {
	name: string; // SOUL.md | MEMORY.md | USER.md
	present: boolean;
	sha256: string | null;
	managed: boolean;
}

/** `hub remote list-docs <id> --json` — the documented docs + present flags. */
export interface RemoteDocsList {
	remote: string;
	ok: boolean;
	docs: RemoteLiveDoc[];
	// Health shape when not ready:
	reachable?: boolean;
	detail?: string;
}

/** Raw `{success, output}` from a mutating `hub …` subprocess command. */
export interface HubResult {
	success: boolean;
	output: string;
}

/** A registered remote connector type (for the add-connector wizard). */
export interface ConnectorType {
	key: string;
	label: string;
	description: string;
	transport: string;
	available: boolean;
}
