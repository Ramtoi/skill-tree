import { invoke } from "@/lib/ipc";

// ─── D2 JSON contract types (mirror subagents.py / subagents.rs) ──────────────

export type SubagentScope = "user" | "project";
export type ToolsMode = "all" | "allowlist" | "denylist";

/** The harnesses that expose a sub-agent concept (D1 capability). `claude-code`
 *  is the back-compat default across every invoke wrapper. */
export type SubagentHarness = "claude-code" | "codex";

/** Sub-agent capability of a harness, mirrored from `harness_list`'s `agents`
 *  object (Rust `AgentsCapability`, from `emit_schema()`). Drives the Configure /
 *  Sub-Agents affordance gating. */
export interface AgentsCapability {
	supported: boolean;
	format: string | null;
	agents_dir: string | null;
	project_agents_dir: string | null;
}

/** Codex `sandbox_mode` enum. Empty string = inherit from the session (D4). */
export const CODEX_SANDBOX_MODES = [
	"",
	"read-only",
	"workspace-write",
	"danger-full-access",
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Codex `model_reasoning_effort` choices. Empty string = inherit. */
export const CODEX_REASONING_EFFORTS = [
	"",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** Allowed `color:` enum values (D3). Empty string = no color. */
export const AGENT_COLORS = [
	"red",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
	"pink",
	"cyan",
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number] | "";

/** Model aliases offered in the guided select (plus inherit + custom id). */
export const MODEL_ALIASES = [
	"inherit",
	"sonnet",
	"opus",
	"haiku",
	"fable",
] as const;

/** The "Read-only" tool preset (D6 / UX). */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** The built-in tool surface offered as Custom-mode checkboxes. Unknown tokens
 *  loaded from disk are merged in by the editor so nothing is ever dropped. */
export const KNOWN_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"Bash",
	"WebFetch",
	"WebSearch",
	"Task",
	"TodoWrite",
	"NotebookEdit",
	"Skill",
] as const;

/** Detail attached to a blocking `skills` save-error when a newly-attached skill
 *  does not resolve in the agent's scope (D5 phase 1). Drives the consequence
 *  prompt: `scope_fix` says whether provisioning enables it for the project
 *  (`project-enable`) or flips it global (`make-global`); `consequence` is the
 *  human sentence shown before the scope-widening confirm. */
export interface NeedsProvisioning {
	skill: string;
	scope_fix: "project-enable" | "make-global";
	consequence: string;
}

export interface SubagentWarning {
	field: string;
	level: "warn" | "error";
	message: string;
	value?: unknown;
	/** Present only on a blocking `skills` error for an unresolved, newly-attached
	 *  registry skill (D5). Absent for plain warnings + non-registry skills. */
	needs_provisioning?: NeedsProvisioning;
}

/** Result of `subagent_provision_skill` (D5 phase 2). Success carries the
 *  verified on-disk `path`; refusals carry `error`. An affinity refusal also
 *  carries `{affinity, widen_available}` so the UI can offer a second, distinct
 *  "Widen affinity" confirm; a remote-quarantine refusal is a dead stop. */
export interface ProvisionResult {
	ok: boolean;
	skill?: string;
	mode?: "make-global" | "project-enable";
	path?: string;
	widened_affinity?: boolean;
	error?: string;
	affinity?: string[];
	widen_available?: boolean;
}

export interface SubagentListItem {
	name: string;
	file: string;
	relpath: string;
	description: string;
	model: string;
	tools_mode: ToolsMode;
	tools: string[];
	disallowed_tools: string[];
	skills: string[];
	color: AgentColor;
	disabled: boolean;
	builtin: boolean;
	valid: boolean;
	warnings: SubagentWarning[];
	/** Cross-harness link presence (D3). `null`/absent ⇒ plain standalone agent. */
	link?: SubagentLink | null;
	// ── Codex-only (present only when harness === "codex") ──────────────────
	sandbox_mode?: CodexSandboxMode;
	model_reasoning_effort?: string;
	nickname_candidates?: string[];
}

export interface SubagentBuiltin {
	name: string;
	model: string;
	description: string;
	disabled: boolean;
	builtin: boolean;
}

export interface SubagentListResult {
	/** `claude-code` | `codex`. Absent on pre-multi-harness payloads. */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	agents_dir: string;
	settings_path: string;
	agents: SubagentListItem[];
	builtins: SubagentBuiltin[];
	/** Non-blocking notice when the link sidecar was unreadable (D3). */
	links_warning?: string | null;
}

export interface SubagentSafe {
	name: string;
	description: string;
	model: string;
	tools_mode: ToolsMode;
	tools: string[];
	disallowed_tools: string[];
	allow_skill_discovery: boolean;
	skills: string[];
	color: AgentColor;
	// ── Codex-only (present only when harness === "codex") ──────────────────
	sandbox_mode?: CodexSandboxMode;
	model_reasoning_effort?: string;
	nickname_candidates?: string[];
}

/** A `skills.config` entry the Codex serializer preserves verbatim but does not
 *  treat as hub-managed (foreign path or `enabled = false`). Read-only in the UI. */
export interface ForeignSkillEntry {
	path: string;
	enabled: boolean;
}

/** Cross-harness link state for one agent (D3 linked twins). Present on list
 *  items and `show`; `null` for a plain standalone agent. `suggested` marks a
 *  same-name pair that exists in two harnesses but was never explicitly linked;
 *  `twin_lost` marks a sidecar-linked pair whose twin file has gone missing. */
export interface SubagentLink {
	linked: boolean;
	harnesses: string[];
	twin_lost: boolean;
	suggested: boolean;
}

/** One shared-core field that diverges between a linked agent's twin files.
 *  `values` maps harness id → that file's value for the field. */
export interface SubagentDriftField {
	field: "description" | "instructions" | "skills";
	values: Record<string, unknown>;
}

/** `subagent_link_status` payload: all recorded links (with twin-lost + drift)
 *  plus same-name suggestions across the scope. */
export interface LinkStatusResult {
	links: Array<{
		name: string;
		harnesses: string[];
		twin_lost: boolean;
		drift: SubagentDriftField[];
	}>;
	suggestions: Array<{ name: string; harnesses: string[] }>;
	links_warning?: string;
}

export interface SubagentShow {
	name: string;
	scope: SubagentScope;
	harness?: SubagentHarness;
	file: string;
	exists: boolean;
	safe: SubagentSafe;
	advanced_yaml: string;
	/** `"yaml"` (claude) | `"toml"` (codex). Drives the Advanced-panel label. */
	advanced_format?: "yaml" | "toml";
	/** Codex `skills.config` entries preserved read-only. Always `[]` for claude. */
	foreign_skill_entries?: ForeignSkillEntry[];
	body: string;
	disabled: boolean;
	validation: { valid: boolean; warnings: SubagentWarning[] } | null;
	/** Cross-harness link presence (D3). `null`/absent ⇒ plain standalone agent. */
	link?: SubagentLink | null;
	/** Per-field shared-core drift between the linked twin files (D3). `null`/
	 *  absent ⇒ no drift (or not linked). */
	drift?: SubagentDriftField[] | null;
	/** Non-blocking notice when the link sidecar was unreadable. */
	links_warning?: string | null;
}

export interface SubagentSavePayload {
	/** Target harness. Rides in the stdin JSON like `scope`; omitted ⇒ claude-code. */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	original_name: string | null;
	safe: SubagentSafe;
	advanced_yaml: string;
	body: string;
}

export interface SubagentSaveResult {
	ok: boolean;
	name?: string | null;
	file?: string | null;
	warnings: SubagentWarning[];
	renamed_from?: string | null;
	/** True when a linked-twin save also co-wrote the shared core into the twin
	 *  file (D3). `twin_harness` names the harness that was co-written. */
	cowrote_twin?: boolean;
	twin_harness?: string | null;
	/** Present only on `{ok:false}`. */
	errors?: SubagentWarning[];
}

/** One option in the attach-skills picker (`subagent_attachable_skills`). */
export interface AttachableSkill {
	name: string;
	description: string;
	resolved: boolean;
	invocable: boolean;
	project_only: boolean;
	attachable: boolean;
	reason: string;
}

/** Reverse index: skill name → agents that preload it (across harnesses). */
export type SkillUsage = Record<
	string,
	Array<{
		agent: string;
		scope: SubagentScope;
		project: string | null;
		/** Owning harness. Absent on pre-multi-harness payloads ⇒ claude-code. */
		harness?: SubagentHarness;
	}>
>;

// ─── Typed invoke wrappers ────────────────────────────────────────────────────

/** The `harnessId` invoke arg is OMITTED for `claude-code` so the shipped Claude
 *  call site stays byte-identical (`{scope, project}`); Codex adds `harnessId`. */
function harnessArg(harnessId?: SubagentHarness): { harnessId?: SubagentHarness } {
	return harnessId && harnessId !== "claude-code" ? { harnessId } : {};
}

export function listSubagents(
	scope: SubagentScope,
	project?: string | null,
	harnessId?: SubagentHarness,
): Promise<SubagentListResult> {
	return invoke<SubagentListResult>("subagent_list", {
		scope,
		project: project ?? null,
		...harnessArg(harnessId),
	});
}

export function showSubagent(
	scope: SubagentScope,
	name: string,
	project?: string | null,
	harnessId?: SubagentHarness,
): Promise<SubagentShow> {
	return invoke<SubagentShow>("subagent_show", {
		scope,
		name,
		project: project ?? null,
		...harnessArg(harnessId),
	});
}

export function saveSubagent(
	payload: SubagentSavePayload,
): Promise<SubagentSaveResult> {
	return invoke<SubagentSaveResult>("subagent_save", { payload });
}

/** `linkAction` (D3): for a linked agent, `"this"` deletes only this harness's
 *  file and unlinks the pair; `"both"` deletes every linked twin. Omitted for
 *  standalone agents (the backend defaults to `"this"`). */
export function deleteSubagent(
	scope: SubagentScope,
	name: string,
	project?: string | null,
	harnessId?: SubagentHarness,
	linkAction?: "this" | "both",
): Promise<{ ok: boolean; errors?: SubagentWarning[] }> {
	return invoke<{ ok: boolean; errors?: SubagentWarning[] }>("subagent_delete", {
		scope,
		name,
		project: project ?? null,
		...(linkAction ? { linkAction } : {}),
		...harnessArg(harnessId),
	});
}

// ─── Linked twins (D3) — user scope only in this release ──────────────────────

/** Link the same-named agent across harnesses. When the agent is missing in a
 *  target harness, `copyFrom` projects its shared core there (model NOT carried —
 *  resets to inherit). Returns `{ok:false, error}` on a clean rejection. */
export function linkSubagent(
	name: string,
	copyFrom?: SubagentHarness,
): Promise<{
	ok: boolean;
	name?: string;
	harnesses?: string[];
	drift?: SubagentDriftField[];
	error?: string;
}> {
	return invoke("subagent_link", { name, copyFrom: copyFrom ?? null });
}

/** Remove the link sidecar entry; both native files are left untouched. */
export function unlinkSubagent(
	name: string,
): Promise<{ ok: boolean; name: string; unlinked: boolean }> {
	return invoke("subagent_unlink", { name });
}

/** All recorded links (twin-lost + drift) + same-name suggestions for the scope. */
export function linkStatus(): Promise<LinkStatusResult> {
	return invoke("subagent_link_status", {});
}

/** Resolve per-field drift: `decisions` maps a shared-core field → the winner
 *  harness id whose value is written into the loser file(s). */
export function resolveDrift(
	name: string,
	decisions: Record<string, SubagentHarness>,
): Promise<{
	ok: boolean;
	name?: string;
	drift?: SubagentDriftField[];
	error?: string;
}> {
	return invoke("subagent_resolve_drift", { name, decisions });
}

export function setSubagentDisabled(
	scope: SubagentScope,
	name: string,
	disabled: boolean,
	project?: string | null,
	harnessId?: SubagentHarness,
): Promise<{ ok: boolean; disabled: boolean }> {
	return invoke<{ ok: boolean; disabled: boolean }>("subagent_set_disabled", {
		scope,
		name,
		disabled,
		project: project ?? null,
		...harnessArg(harnessId),
	});
}

export function attachableSkills(
	scope: SubagentScope,
	project?: string | null,
	harnessId?: SubagentHarness,
): Promise<AttachableSkill[]> {
	return invoke<AttachableSkill[]>("subagent_attachable_skills", {
		scope,
		project: project ?? null,
		...harnessArg(harnessId),
	});
}

export function skillUsage(): Promise<SkillUsage> {
	return invoke<SkillUsage>("subagent_skill_usage");
}

/** Provision an attached skill so an agent's `skills:` reference resolves (D5
 *  phase 2). `global` flips the skill to `scope: global` (every installed
 *  harness); otherwise it enables + resyncs the skill for `project`. Pass the
 *  agent's `harnessId` (affinity + verify target) and `widenAffinity` to clear a
 *  `harnesses:` restriction that excludes it. */
export function provisionSkill(args: {
	skill: string;
	global: boolean;
	project?: string | null;
	harnessId?: SubagentHarness;
	widenAffinity?: boolean;
}): Promise<ProvisionResult> {
	return invoke<ProvisionResult>("subagent_provision_skill", {
		skill: args.skill,
		global: args.global,
		project: args.project ?? null,
		harnessId: args.harnessId ?? "claude-code",
		widenAffinity: args.widenAffinity ?? false,
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** One-word human summary of a list item's tool access (for the card). */
export function toolAccessSummary(item: SubagentListItem): string {
	if (item.tools_mode === "all") return "All tools";
	if (item.tools_mode === "denylist") {
		const n = item.disallowed_tools.length;
		return `All except ${n} tool${n === 1 ? "" : "s"}`;
	}
	// allowlist
	const tools = item.tools.filter((t) => t !== "Skill");
	const ro =
		tools.length === READ_ONLY_TOOLS.length &&
		READ_ONLY_TOOLS.every((t) => tools.includes(t));
	if (ro) return "Read-only";
	const n = item.tools.length;
	return `${n} tool${n === 1 ? "" : "s"}`;
}

/** One-word capability summary for a Codex list card. Codex scopes capability by
 *  `sandbox_mode`, not per-tool rules — an empty mode inherits the session's. */
export function sandboxSummary(item: {
	sandbox_mode?: CodexSandboxMode | string;
}): string {
	const mode = item.sandbox_mode ?? "";
	return mode === "" ? "Inherit sandbox" : mode;
}

/** The guided tool-access radio choices. `denylist` agents round-trip via the
 *  advanced panel — the editor surfaces a note instead of silently re-mapping. */
export type ToolAccessChoice = "all" | "readonly" | "custom" | "denylist";

export function toolAccessChoice(safe: {
	tools_mode: ToolsMode;
	tools: string[];
}): ToolAccessChoice {
	if (safe.tools_mode === "all") return "all";
	if (safe.tools_mode === "denylist") return "denylist";
	const tools = safe.tools.filter((t) => t !== "Skill");
	const ro =
		tools.length === READ_ONLY_TOOLS.length &&
		READ_ONLY_TOOLS.every((t) => tools.includes(t));
	return ro ? "readonly" : "custom";
}
