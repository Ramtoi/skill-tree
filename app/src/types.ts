export type SkillType = "claude-skill" | "mcp-server";
export type SkillScope = "global" | "portable" | "project-specific";

export type SkillManaged = "local" | "external" | "starter";

export type WorkingMode = "inline" | "delegator" | "mixed";
export type InteractionStyle = "conversational" | "checkpointed" | "autonomous";
export type Maturity = "experimental" | "confident" | "trusted";
export interface SkillClassification {
	classes?: string[];
	outputs?: string[];
	working_mode?: WorkingMode;
	interaction_style?: InteractionStyle;
	maturity?: Maturity;
}
export type ClassificationField = keyof SkillClassification;
export interface SkillRefsGraph {
	edges: Array<{ from: string; to: string; count: number }>;
}

// `ships_with` (D1/I3/A6) — declared in `lib/companions.ts`, the one place
// these shapes live; re-imported here so `Skill`/`Project` can carry them.
import type { ShipsWith, CompanionLedgerEntry } from "./lib/companions";
export type { ShipsWith, CompanionLedgerEntry } from "./lib/companions";

export interface SkillOrigin {
	source: string;
	source_type?: string;
	path?: string;
	ref?: string | null;
}

/** `hub mcp` transport vocabulary (`mcp_spec.TRANSPORTS`). */
export type McpTransport = "stdio" | "http" | "sse";

/** The registry `mcp:` block (INTERFACES §2/§6) — mirrors `mcp_spec.McpServerSpec`
 *  field-for-field, but as the literal registry dict (what `hub mcp show/set`
 *  read and write), not the Python dataclass. Every field optional/absent-safe:
 *  a stdio block omits `transport` (implied), an http/sse block omits
 *  `command`/`args`/`env`. */
export interface McpSpec {
	transport?: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	timeout_ms?: number;
	allow_literal_secrets?: boolean;
	/** Legacy field, read by nothing — preserved verbatim on rewrite. */
	runtime?: string;
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
	classification?: SkillClassification;
	/** Set when this skill came from an external source. */
	origin?: SkillOrigin;
	/** True if the owning external source no longer carries this skill upstream. */
	source_missing?: boolean;
	/** Optional harness affinity list. */
	harnesses?: string[];
	/** The `mcp:` block — present only for `type: "mcp-server"`. */
	mcp?: McpSpec;
	/** Sync-time mirror of the SKILL.md invocation frontmatter. Absent = `auto`
	 *  (both flags cleared). `conflicted` is the derived both-flags-set state. */
	invocation?: "user-only" | "model-only" | "conflicted";
	/** Names this skill's body mentions that are deliberately not references (CLI-managed: `hub set-meta --refs-ignore`). */
	refs_ignore?: string[];
	/** D1: companions this skill declares (agents/hooks/permissions), mirrored
	 *  from SKILL.md frontmatter by `sync_skill_frontmatter_metadata`. Absent
	 *  or all-empty means the skill ships nothing extra. Read-only from the
	 *  registry side — the frontmatter is the source of truth. */
	ships_with?: ShipsWith;
}

/** Why `hub source dropped` no longer sees this skill upstream. `unknown` is
 *  the checkout-or-ref-gone degrade — never raised, just reported. */
export type DroppedSkillReason = "renamed" | "deleted" | "unknown";

/** The upstream path this skill's content moved to, when a git rename was
 *  detected. `registered_as` is the registry key already pointed at it, or
 *  `null` when nothing in the library has picked it up yet. `similarity`
 *  (0-100) is the CLI's rename-confidence score — a `reason: "renamed"` row
 *  is only ever reported at similarity >= 70; anything less shows up as
 *  `reason: "deleted"` with the candidate under `possible_successor` instead. */
export interface DroppedSkillSuccessor {
	path: string;
	name: string;
	registered_as: string | null;
	similarity: number;
}

/** Every holder still referencing a dropped skill's name — the same shape the
 *  blast-radius confirm in `useSkillRemoval` computes for any skill. */
export interface DroppedSkillEquipped {
	projects: string[];
	bundles: string[];
	remotes: string[];
	cloud: string[];
}

/** `hub source dropped [--skill NAME] [--content] --json` row. Read-only —
 *  this command never mutates the registry or the checkout. */
export interface DroppedSkill {
	name: string;
	source: string;
	source_name: string;
	path: string;
	ref: string | null;
	ref_short: string | null;
	last_seen_at: string | null;
	reason: DroppedSkillReason;
	successor: DroppedSkillSuccessor | null;
	/** A rename candidate below the confidence gate (similarity < 70) — never
	 *  the primary action, just a hedge: "Possibly renamed to X (N% similar)".
	 *  Only present on a `reason: "deleted"` row. */
	possible_successor?: DroppedSkillSuccessor | null;
	equipped: DroppedSkillEquipped;
	recoverable: boolean;
	/** `git show <ref>:<path>/SKILL.md` — present only with `--content`. */
	skill_md: string | null;
}

export interface ProjectAgentDocsPrefs {
	/** Per-project root-derivation strategy override (symlink | import). */
	root_strategy?: "symlink" | "import";
	/** Publish saved root Agent Docs to origin/main after a guarded check. */
	publish_on_save?: boolean;
}

export interface Project {
	path: string;
	/** Set by `hub restore` for a project whose recorded path does not exist
	 *  on this machine (F1). Sync refuses to write to it until `hub project
	 *  edit-path` clears the flag — see `lib/syncFreshness.ts`'s `quarantined`
	 *  state, the single source of truth for reading this. */
	path_unresolved?: boolean;
	bundles: string[];
	enabled: string[];
	harnesses?: string[];
	agent_docs?: ProjectAgentDocsPrefs;
	/** Per-project invocation overrides keyed by skill name. Only valid for
	 *  portable / project-specific skills (global skills can't be shadowed). */
	invocation_overrides?: Record<string, "auto" | "user-only" | "model-only">;
	/** The project's OWN permission block (same hybrid shape as
	 *  `permissions_global`), scoped to this project's own rules only — never
	 *  the merged effective view. The app counts these; the editor reads the
	 *  normalized form through `permissions_show`, and
	 *  `ProjectPermissionsTab.tsx:35-63` keeps its own cast for the full typed
	 *  shape — this is the navigator's read-only slice. */
	permissions?: {
		allow?: unknown[];
		deny?: unknown[];
		ask?: unknown[];
		hooks?: unknown[];
		/** Codex auto-grant marker: writing project command rules sets this. */
		project_trust?: boolean;
		worktree_access?: {
			enabled: boolean;
			path: string;
		};
	};
	hooks?: string[];
	/** D4: the ownership ledger for everything a skill's `ships_with`
	 *  provisioned on THIS project, keyed by skill name. The seam the app reads
	 *  for `via <skill>` provenance and that `hub disable` reads for removal. */
	companions?: Record<string, CompanionLedgerEntry>;
}

export type BundleScope = "global" | "portable" | "project-specific";

export interface PlaybookSection {
	id: string;
	title: string;
	guidance?: string;
	skills: string[];
}

export interface Bundle {
	playbook?: PlaybookSection[];
	description: string;
	icon: string;
	scope?: BundleScope;
	skills: string[];
	/** Set when this bundle FOLLOWS an external source: its membership is
	 *  reconciled by `hub source sync <id>` and may not be hand-edited until the
	 *  link is dropped (`hub bundle update <n> --detach-source`). */
	source?: string;
}

/** One bundle whose membership `hub source sync` reconciled. */
export interface SourceBundleUpdate {
	bundle: string;
	added: string[];
	removed: string[];
}

/** `hub source sync <id> --json`. The count-ish fields are emitted as name
 *  lists; they are typed permissively (list OR count) so a backend that reports
 *  a bare number still renders instead of crashing the toast. */
export interface SourceSyncPayload {
	ok?: boolean;
	/** Upstream skills newly REGISTERED by this sync. */
	added?: string[] | number;
	/** Already-registered skills whose content/metadata moved. */
	changed?: string[] | number;
	/** Registered skills the source no longer carries upstream. */
	removed_upstream?: string[] | number;
	unchanged?: string[] | number;
	/** Candidates that stayed untouched (conflicts / invalid names). */
	new_pending?: unknown[] | number;
	needs_hub_sync?: boolean;
	bundle_updates?: SourceBundleUpdate[];
	errors?: unknown;
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
	/** User toggle written by `hub source disable|enable`. ABSENT MEANS TRUE —
	 *  a disabled source keeps its skills registered but stops syncing them. */
	enabled?: boolean;
	url: string;
	branch?: string | null;
	path?: string;
	/** Upstream skill names this source is allowed to register. Written when the
	 *  add wizard imported a SUBSET of what it discovered; `source sync` honors
	 *  it so the source can never re-grow past the curated set. ABSENT MEANS
	 *  "follow upstream fully" — the default. */
	include?: string[];
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
	/** See GitSourceConfig.enabled — absent means true. */
	enabled?: boolean;
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
	/** Whether this source currently syncs its skills to projects. Built-ins are
	 *  always true; `hub source list --json` reports it explicitly, and a config
	 *  with the key ABSENT resolves to true. */
	enabled?: boolean;
	skill_count?: number;
	// Git-only fields (present only when type === "git"):
	url?: string;
	branch?: string | null;
	path?: string;
	/** See GitSourceConfig.include — absent means "follow upstream fully". */
	include?: string[];
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
	/** Absolute path of the data home. **Optional**: the backup snapshot's
	 *  portable registry form drops it (design §3 drop list — it is a machine
	 *  -absolute path that must not travel), so a registry read straight after a
	 *  restore can legitimately lack it. Readers fall back (see StatusBar). */
	hub_path?: string;
	bootstrap?: BootstrapBlock;
	harnesses_global?: string[];
	skills: Record<string, Skill>;
	projects: Record<string, Project>;
	bundles: Record<string, Bundle>;
	/** Configured external sources keyed by id (built-ins are NOT stored here). */
	sources?: Record<string, SourceConfig>;
	/** Remote connector targets keyed by id. Same pass-through story as `cloud`
	 *  below: `read_registry` hands the YAML over verbatim, so the navigator can
	 *  name a remote and count what is equipped on it WITHOUT a `hub remote
	 *  list` round-trip (and without ever probing SSH health). Only the fields
	 *  the shell reads are typed; `useRemotes` owns the full CLI shape. */
	remotes?: Record<
		string,
		{
			connector?: string;
			bundles?: string[];
			enabled?: string[];
			sync_enabled?: boolean;
			/** Opt into `scope: global` bundles (off by default for a remote). */
			apply_global_bundles?: boolean;
		}
	>;
	/** Manual-upload cloud targets keyed by the FIXED catalog id (`claude-ai`,
	 *  `chatgpt-web`). Absent until something is equipped. Same equip model as a
	 *  project: `bundles` ∪ `enabled`. `read_registry` passes the YAML through
	 *  verbatim, so no Rust change was needed to surface it. */
	cloud?: Record<
		string,
		{
			bundles?: string[];
			enabled?: string[];
			/** Hand-edit only (no CLI/UI writes it): opt this target into the
			 *  `scope: global` bundles a project inherits by default. */
			apply_global_bundles?: boolean;
		}
	>;
	/** User-defined permission presets keyed by id. Built-in presets are NOT
	 *  stored here — they are emitted from `permission_presets.py`. */
	permission_presets?: Record<string, UserPermissionPresetEntry>;
	/** Global allow/deny/ask rules. Same pass-through story as `remotes` above:
	 *  `read_registry` hands the YAML over verbatim, so the navigator can show
	 *  rule COUNTS for the guardrails panel body without a `permissions_show`
	 *  round-trip. Only the three list lengths are read here; `usePermissions`
	 *  owns the full typed shape. */
	permissions_global?: {
		allow?: unknown[];
		deny?: unknown[];
		ask?: unknown[];
		hooks?: unknown[];
		/** Codex-only typed setting. */
		sandbox_mode?: string;
		/** Codex-only typed setting. */
		approval_policy?: string;
		additional_dirs?: string[];
		/** Harness ids opted out of hub management. */
		_unmanaged?: string[];
	};
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
	/** Ordered action buttons. `action` remains for existing callers. */
	actions?: ToastAction[];
}

/** The entity kinds the Recent strip may hold. Every one of them has a real
 *  per-item route (`/skill/:name`, `/project/:name`, `/bundle/:name`,
 *  `/hook/:name`, `/harness/:id`, `/remote/:id`, `/cloud/:id`,
 *  `/snippet/:name`), which is the whole membership rule: a chip that cannot
 *  navigate is a dead chip. Sources are deliberately absent — that screen IS
 *  the list. */
export const RECENT_TYPES = [
	"skill",
	"project",
	"bundle",
	"hook",
	"harness",
	"remote",
	"cloud",
	"snippet",
] as const;

export type RecentType = (typeof RECENT_TYPES)[number];

export interface RecentItem {
	type: RecentType;
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

/** Unified remote health/probe state tag (matches the backend `detail_kind`
 *  vocabulary from `classify_probe_exception` + `HealthResult`). */
export type RemoteDetailKind =
	| "ready"
	| "home_missing"
	| "auth_failed"
	| "unreachable"
	| "host_key_mismatch";

/** `hub remote diff <id> --json` — either a plan (ready) or a health shape. */
export interface RemoteDiffPlan {
	remote: string;
	actions?: RemoteDiffAction[];
	// Health shape (returned when the remote is not ready):
	reachable?: boolean;
	authenticated?: boolean;
	ready?: boolean;
	detail_kind?: RemoteDetailKind;
	ok?: boolean;
	detail?: string;
}

/** `hub remote pin <id> --json` — applied, no-op, or a differing-pin refusal. */
export interface RemotePinResult {
	remote: string;
	pinned?: boolean;
	changed?: boolean;
	refused?: boolean;
	reason?: string;
	old_pins?: string[];
	new_pin?: string;
	fingerprint?: string;
	detail?: string;
}

/** `hub remote probe --ssh-host <host> --json` — pre-registration auth probe. */
export interface RemoteProbeResult {
	ssh_host: string;
	reachable?: boolean;
	authenticated?: boolean;
	ok?: boolean;
	detail?: string;
	detail_kind?: RemoteDetailKind;
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

/** Raw `{success, output}` from a mutating `hub …` subprocess command. Canonical
 *  declaration lives in `lib/hubCmd.ts`; re-exported here (type-only, erased
 *  under `isolatedModules`) so existing `@/types` importers do not churn. */
export type { HubResult } from "./lib/hubCmd";
export type { RemoteDetailCommand } from "./lib/remoteCommands";

/** A registered remote connector type (for the add-connector wizard). This is
 *  the STATIC/offline card shape (see `connectors.ts` fallback list). */
export interface ConnectorType {
	key: string;
	label: string;
	description: string;
	transport: string;
	available: boolean;
}

/** One entry from the live connector catalog (`hub remote connectors --json`),
 *  marshaled by the `remote_connectors` Tauri command. Drives the add-remote
 *  wizard's cards + transport-aware step branching. */
export interface CatalogConnector {
  deployment_kind?: "artifacts" | "project-loadouts";
	key: string;
	label: string;
	description: string;
	/** Onboarding flow selector. Known kinds: "ssh" | "https". Unknown kinds
	 *  render the card as CLI-only (no wizard flow). */
	transport_kind: string;
	publishable: boolean;
	available: boolean;
	/** Provenance, for debugging: builtin | entry-point | drop-in. */
	source: string;
}
