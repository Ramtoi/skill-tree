import type { SnippetMarkerDiagnostic } from "@/types/snippets";

export interface AgentDocFile {
	rel: string;
	name: string;
	label: string;
	absolute_path: string;
	exists: boolean;
	is_known: boolean;
	is_discovered: boolean;
	is_symlink: boolean;
	symlink_to: string | null;
	symlink_target_in_project: boolean;
	can_read: boolean;
	can_write: boolean;
	size: number | null;
	modified_at: number | null;
	hash: string | null;
	error: string | null;
	/** Reached through the `@` import graph. Claude Code only — no other
	 *  configured harness implements `@` imports. */
	is_import?: boolean;
	/** Rels of the agent docs that declare this import, deduped by canonical
	 *  target so symlinked root twins attribute once. */
	imported_by?: string[];
	/** Where the target resolved. Absent on non-imported rows. */
	import_class?: AgentDocImportClass | null;
	/** True when the project's effective harnesses would not load this import. */
	import_unreachable?: boolean;
	/** True when the target is not a Markdown file — listed, opened read-only. */
	is_non_markdown?: boolean;
	/** Raw import paths declared by THIS file that do not exist. */
	unresolved_imports?: string[];
}

/** Where an `@` import target resolved.
 *  - `in_project` — inside the project root, editable as usual
 *  - `external` — outside it (`@~/.claude/…` is the documented pattern);
 *    present but not editable, NEVER an unresolved-import error
 *  - `beyond_depth` — past the documented four-hop limit; not loaded context */
export type AgentDocImportClass = "in_project" | "external" | "beyond_depth";

export interface AgentDocFolder {
	name: string;
	path: string;
	dirs: AgentDocFolder[];
	files: AgentDocFile[];
}

export type AgentDocFormatKind = "CLAUDE" | "AGENT";

/** Canonical-status verdict per directory — the one shared model (design D2),
 *  produced by the Rust scanner and pinned against agent_docs.py by the
 *  fixture corpus. The frontend never re-derives these from raw file flags. */
export type AgentDocVerdict =
	| "none"
	| "canonical"
	| "claude_only"
	| "agents_only"
	| "derived_drift"
	| "replaced_derived"
	| "conflict"
	| "pointer_plus_content"
	| "empty";

/** Composed deviation flags. A directory can be `canonical` + `legacy`. */
export type AgentDocFlag = "legacy" | "broken_link" | "external_link";

export interface AgentDocFormatRecord {
	format: AgentDocFormatKind;
	rel: string;
	exists: boolean;
	file: AgentDocFile | null;
	is_symlink: boolean;
	target_kind:
		| "none"
		| "missing"
		| "sibling"
		| "external"
		| "broken"
		| "unknown";
	required_by_harnesses: string[];
	warnings: string[];
	title: string | null;
}

export interface AgentDocInstructionSet {
	id: string;
	relative_dir: string;
	display_path: string;
	full_path_title: string;
	label: string;
	label_source: string;
	verdict: AgentDocVerdict;
	flags: AgentDocFlag[];
	formats: Record<AgentDocFormatKind, AgentDocFormatRecord>;
	/** Legacy `AGENT.md` artifacts in this directory — never satisfy a format. */
	legacy: AgentDocFile[];
	/** Appendix text when `verdict === "pointer_plus_content"`. */
	appendix: string | null;
	required_formats: AgentDocFormatKind[];
	warnings: string[];
}

/** Effective canonical-root policy resolved by the scanner. */
export interface AgentDocPolicyInfo {
	requires_claude: boolean;
	requires_agent: boolean;
	strategy: AgentDocRootStrategy;
	canonical: "CLAUDE.md" | "AGENTS.md" | null;
	derived: "CLAUDE.md" | null;
}

export interface AgentDocsListing {
	project_path: string;
	root: AgentDocFolder;
	instruction_sets: AgentDocInstructionSet[];
	required_formats: AgentDocFormatKind[];
	policy: AgentDocPolicyInfo;
	all_rels: string[];
	/** The files an agent actually loads: instruction files, the virtual known
	 *  roots, and resolved import targets. Eagerly sized, so the context
	 *  estimate does not drift upward as folders are expanded. */
	instruction_rels: string[];
	/** Import targets resolving OUTSIDE the project root.
	 *  `@~/.claude/my-project-instructions.md` is the documented way to share
	 *  preferences across worktrees, so these are real working configuration —
	 *  present, attributed, not editable. Kept off the rel namespace because
	 *  rels are what read/write confinement is expressed in. */
	external_imports: AgentDocFile[];
	/** `.md` files the project's own ignore rules withheld from the browse
	 *  index. Reported so a withheld file is a stated absence, not a silent
	 *  one — replacing a cap banner with an unannounced filter would keep the
	 *  silence and change only its cause. */
	ignored_count: number;
	/** Whether this listing was built with ignore rules switched off. */
	include_ignored: boolean;
}

export interface AgentDocContent {
	rel: string;
	absolute_path: string;
	content: string;
	size: number;
	modified_at: number | null;
	hash: string;
	is_symlink: boolean;
	symlink_to: string | null;
	oversized: boolean;
	/** True when this is a hub-derived root `CLAUDE.md` (symlink → AGENTS.md, or
	 *  a regular file whose body is `@AGENTS.md`). The editor renders a
	 *  read-only stub and redirects edits to `AGENTS.md`. */
	is_derived_pointer: boolean;
}

export type AgentDocRootStrategy = "symlink" | "import";

export type AgentDocRootState =
	| "none"
	| "ok"
	| "needs_canonicalization"
	| "conflict";

export interface AgentDocRootStatus {
	project: string;
	state: AgentDocRootState;
	canonical: "CLAUDE.md" | "AGENTS.md" | null;
	derived: "CLAUDE.md" | null;
	strategy: AgentDocRootStrategy;
	reason: string;
	verdict?: AgentDocVerdict;
	flags?: AgentDocFlag[];
	nested_deviations?: number;
}

export interface AgentDocStrategyInfo {
	global: AgentDocRootStrategy;
	project: string | null;
	override_value: AgentDocRootStrategy | null;
	effective: AgentDocRootStrategy | null;
}

// ─── Fix plan (transactional; hub.py agent-docs fix) ─────────────────────────

export type AgentDocFixAction =
	| "promote"
	| "derive"
	| "rederive"
	| "collapse"
	| "remove_legacy_link"
	/** Opt-in: rename a user-authored AGENT.md → AGENTS.md when its directory
	 *  has no other instruction file (content preserved verbatim). */
	| "rename_legacy_file";

export interface AgentDocFixPrecondition {
	rel: string;
	kind: "file" | "symlink" | "missing";
	hash?: string | null;
	target?: string | null;
}

export interface AgentDocFixStep {
	id: number;
	dir: string;
	action: AgentDocFixAction;
	/** Opt-in steps (nested promotions) start unselected. */
	optional: boolean;
	selected: boolean;
	paths: string[];
	preconditions: AgentDocFixPrecondition[];
	details: string;
}

export interface AgentDocFixAttention {
	dir: string;
	verdict: AgentDocVerdict;
	details: string;
	appendix?: string | null;
}

export interface AgentDocFixFlagged {
	path: string;
	reason: string;
}

export interface AgentDocFixPlan {
	project?: string;
	strategy: AgentDocRootStrategy;
	policy: {
		requires_claude: boolean;
		requires_agent: boolean;
		canonical: string | null;
		derived: string | null;
	};
	steps: AgentDocFixStep[];
	attention: AgentDocFixAttention[];
	flagged: AgentDocFixFlagged[];
}

export interface AgentDocCommitResult {
	committed: boolean;
	sha: string | null;
	/** Skip/warn explanation: `no_changes` | `not_a_repo` | a git error. */
	reason: string | null;
}

export interface AgentDocFixApplyResult {
	project?: string;
	applied: boolean;
	error?: string;
	mismatches?: Array<{ step: number; rel: string }>;
	executed: Array<{
		id: number;
		dir: string;
		action: AgentDocFixAction;
		details?: string;
	}>;
	backups: string[];
	/** Files the fix actually touched (relative paths). */
	touched?: string[];
	/** Present when the opt-in commit ran. */
	commit?: AgentDocCommitResult;
	flagged?: AgentDocFixFlagged[];
	attention?: AgentDocFixAttention[];
}

export type AgentDocResolveOp = "keep_agents" | "keep_claude" | "absorb_appendix";

export interface AgentDocResolveResult {
	project?: string;
	applied: boolean;
	op?: AgentDocResolveOp;
	error?: string;
	backups?: string[];
	touched?: string[];
	commit?: AgentDocCommitResult;
}

export interface AgentDocWriteResult {
	written: AgentDocFile[];
	/** True when the write canonicalized the root pair (wrote AGENTS.md and
	 *  derived CLAUDE.md in one command). */
	derived: boolean;
	/** Final content after Hub's snippet-region reconciliation, if any. */
	content?: string;
	/** Present when this save requested publish-on-save. */
	publish?: AgentDocPublishResult | null;
}

export interface AgentDocPublishInfo {
	project: string;
	enabled: boolean;
	remote: string;
	branch: string;
}

export interface AgentDocPublishResult {
	project?: string | null;
	enabled: boolean;
	attempted: boolean;
	published: boolean;
	committed: boolean;
	sha: string | null;
	remote: string;
	branch: string;
	reason: string;
	message: string;
}

export interface AgentDocConflictPayload {
	rel: string;
	current_hash: string;
	current_size: number;
	modified_at: number | null;
}

export type AgentDocErrorKind =
	| "invalid_path"
	| "not_allowed_basename"
	| "outside_project"
	| "conflict"
	| "not_utf8"
	| "oversized"
	| "external_symlink"
	| "derived_pointer"
	| "snippet_markers"
	| "io_error";

export interface AgentDocErrorBody {
	kind: AgentDocErrorKind;
	message?: string;
	rel?: string;
	current_hash?: string;
	current_size?: number;
	modified_at?: number | null;
	size?: number;
	limit?: number;
	target?: string;
	diagnostics?: SnippetMarkerDiagnostic[];
	/** Set when `kind === "derived_pointer"`: the canonical real file that the
	 *  derived `CLAUDE.md` points at — the UI should redirect edits there. */
	canonical_rel?: "AGENTS.md";
}

export interface AgentDocMarkerIssue {
	rel: string;
	diagnostics: SnippetMarkerDiagnostic[];
}

export function parseAgentDocError(err: unknown): AgentDocErrorBody | null {
	if (typeof err !== "string") return null;
	try {
		const parsed = JSON.parse(err);
		if (parsed && typeof parsed === "object" && "kind" in parsed) {
			return parsed as AgentDocErrorBody;
		}
	} catch {
		/* not a structured error */
	}
	return null;
}
