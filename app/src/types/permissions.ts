// Mirror of the Python NormalizedPermissions / Rule / Hook shapes emitted by
// hub.py's permissions subcommands. All fields match `to_dict()` from
// permissions.py — keep this file in sync with that contract.

export type RuleKind = "allow" | "deny" | "ask";
export type Origin = "global" | "project";

export type PermissionFeature =
	| "tool_allowlist"
	| "tool_denylist"
	| "tool_ask"
	| "hooks"
	| "sandbox_mode"
	| "approval_policy"
	| "project_trust"
	| "additional_directories";

export interface Rule {
	pattern: string;
	kind: RuleKind;
	/** null/undefined ⇒ applies to every capable harness */
	harnesses?: string[] | null;
	/** Populated by the resolver. Absent in unresolved payloads. */
	origin?: Origin;
}

export interface Hook {
	event: string;
	matcher: string;
	command: string;
	harnesses?: string[] | null;
	origin?: Origin;
}

export interface NormalizedPermissions {
	allow: Rule[];
	deny: Rule[];
	ask: Rule[];
	hooks: Hook[];
	/** Present when the engine collapsed duplicate raw registry rows for display. */
	duplicate_collapsed?: number;
	sandbox_mode: string | null;
	approval_policy: string | null;
	project_trust: boolean | null;
	additional_dirs: string[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	extras: Record<string, any>;
	_unmanaged: string[];
}

export interface AdoptionEntry {
	pattern: string;
	kind: RuleKind;
	source_file: string;
}

/** Payload returned by `permissions_show` for the global scope when discovery
 *  is pending. `null`/absent otherwise. */
export type AdoptionRequired = Record<string, AdoptionEntry[]> | null;

export interface PermissionsShowGlobal extends NormalizedPermissions {
	adoption_required?: AdoptionRequired;
}

export type PermissionsShow = NormalizedPermissions | PermissionsShowGlobal;

export type Capabilities = Record<string, PermissionFeature[]>;

export interface ValidateResult {
	ok: boolean;
	error: string | null;
}

export interface DoctorFinding {
	code: string;
	severity: "danger" | "warning";
	explanation: string;
	detail: string;
	scope_kind: "global" | "project";
	scope_label: string;
	harness_id?: string | null;
}

export interface DoctorReport {
	findings: DoctorFinding[];
	danger_count: number;
}

export type DisableMode = "restore" | "detach";

export interface DisableEntry {
	scope_kind: "global" | "project";
	scope_label: string;
	harness_id: string;
	target_file: string;
	backup_path: string | null;
	sidecar_path: string;
	action: "restore" | "detach" | "clear";
	will_write: boolean;
	applied?: boolean;
}

/** A scope the engine reports it touched (for query invalidation). */
export interface ScopeRef {
	kind: "global" | "project";
	name?: string;
}

export interface DisableResult {
	mode: DisableMode;
	apply: boolean;
	entries: DisableEntry[];
	/** Every scope a (possibly cross-scope) disable touched. */
	scopes_touched?: ScopeRef[];
}

export interface AdoptResult {
	scope_kind: "global" | "project";
	harness_id: string | null;
	action: "import" | "replace" | "skip";
	imported: number;
	backup_path: string | null;
	unmanaged_after: string[];
}

/** A collapsed, affinity-free importable rule from cross-harness discovery. */
export interface ImportMergedCandidate {
	pattern: string;
	kind: RuleKind;
	harnesses: string[] | null;
	sources: { harness: string; source: string }[];
}

/** A same-command/divergent-decision conflict needing a user choice. */
export interface ImportConflict {
	pattern: string;
	/** kind → harness ids advocating that decision. */
	options: Record<string, string[]>;
}

/** A Codex rule shape the registry cannot represent (read-only). */
export interface ImportUnimportable {
	source: string | null;
	harness: string | null;
	reason: string | null;
	file: string | null;
}

export interface ImportCandidateSet {
	scope_kind: "global" | "project";
	project: string | null;
	merged: ImportMergedCandidate[];
	conflicts: ImportConflict[];
	un_importable: ImportUnimportable[];
}

export interface ImportDecision {
	pattern: string;
	action: "import" | "keep" | "drop";
	kind?: RuleKind;
	harnesses?: string[] | null;
}

export interface ImportApplyResult {
	imported: number;
	dropped: number;
	kept: number;
}

export interface RiskSchemaEntry {
	code: string;
	severity: "danger" | "warning";
	explanation: string;
}

export interface RiskFinding {
	code: string;
	severity: "danger" | "warning";
	explanation: string;
	detail: string;
}

export type Scope = { kind: "global" } | { kind: "project"; name: string };

export function scopeKey(scope: Scope): string {
	return scope.kind === "global" ? "global" : `project:${scope.name}`;
}

export function scopeLabel(scope: Scope): string {
	return scope.kind === "global" ? "Global" : scope.name;
}

export function emptyPermissions(): NormalizedPermissions {
	return {
		allow: [],
		deny: [],
		ask: [],
		hooks: [],
		sandbox_mode: null,
		approval_policy: null,
		project_trust: null,
		additional_dirs: [],
		extras: {},
		_unmanaged: [],
	};
}

/** Feature → kind helper. Lets us map a rule kind to its capability key. */
export function kindFeature(kind: RuleKind): PermissionFeature {
	return kind === "allow"
		? "tool_allowlist"
		: kind === "deny"
			? "tool_denylist"
			: "tool_ask";
}

/** Parse a registry `Bash(<cmd...>:*)` pattern → prefix tokens, or null.
 *  Mirrors `permission_adapters._bash_prefix_tokens` so the UI can predict
 *  Codex command-rule translatability without a backend round-trip. */
export function bashPrefixTokens(pattern: string): string[] | null {
	const m = /^Bash\((.*)\)$/.exec(pattern.trim());
	if (!m) return null;
	let inner = m[1].trim();
	if (inner.endsWith(":*")) inner = inner.slice(0, -2);
	else if (inner.endsWith("*")) inner = inner.slice(0, -1).replace(/:+$/, "");
	inner = inner.trim();
	if (!inner || inner === "*") return null;
	const toks = inner.split(/\s+/).filter(Boolean);
	return toks.length ? toks : null;
}

/** kind → Codex decision (allow→allow, ask→prompt, deny→forbidden). */
export function codexDecision(
	kind: RuleKind,
): "allow" | "prompt" | "forbidden" {
	return kind === "allow" ? "allow" : kind === "ask" ? "prompt" : "forbidden";
}

/** Per-harness constraint on which rule *patterns* a capability actually
 *  covers. Codex's `tool_*` support is Bash-prefix-only (D6); every other
 *  harness covers any pattern its capability set advertises. Mirrors the
 *  backend's per-rule translatability check so the UI doesn't over-promise. */
const HARNESS_PATTERN_SUPPORT: Record<
	string,
	(rule: { kind: RuleKind; pattern: string }) => boolean
> = {
	codex: (rule) => bashPrefixTokens(rule.pattern) !== null,
};

/** Whether a harness can honor a *specific* rule, accounting for the
 *  capability set AND any per-harness pattern caveat (e.g. Codex Bash-only). */
export function harnessSupportsRule(
	harnessId: string,
	rule: { kind: RuleKind; pattern: string },
	capabilities: Capabilities,
): boolean {
	const feature = kindFeature(rule.kind);
	if (!(capabilities[harnessId] ?? []).includes(feature)) return false;
	const caveat = HARNESS_PATTERN_SUPPORT[harnessId];
	return caveat ? caveat(rule) : true;
}

/** Strip resolver provenance + null defaults before posting via permissions_set.
 *  The engine accepts the full block shape; `origin` is a read-only resolver
 *  decoration that should never round-trip back. */
export function stripResolverFields(
	p: NormalizedPermissions,
): NormalizedPermissions {
	const stripRule = (r: Rule): Rule => {
		const out: Rule = { pattern: r.pattern, kind: r.kind };
		if (r.harnesses !== undefined && r.harnesses !== null)
			out.harnesses = [...r.harnesses];
		return out;
	};
	const stripHook = (h: Hook): Hook => {
		const out: Hook = {
			event: h.event,
			matcher: h.matcher,
			command: h.command,
		};
		if (h.harnesses !== undefined && h.harnesses !== null)
			out.harnesses = [...h.harnesses];
		return out;
	};
	return {
		allow: p.allow.map(stripRule),
		deny: p.deny.map(stripRule),
		ask: p.ask.map(stripRule),
		hooks: p.hooks.map(stripHook),
		sandbox_mode: p.sandbox_mode,
		approval_policy: p.approval_policy,
		project_trust: p.project_trust,
		additional_dirs: [...p.additional_dirs],
		extras: { ...p.extras },
		_unmanaged: [...p._unmanaged],
	};
}
