// ─── Hook library data layer (hooks-surface D7) ──────────────────────────────
// Canonical @tanstack/react-query surface for the Hooks screens, mirroring
// useRemotes.ts. Every mutation invalidates BOTH ["hooks"] (the library +
// per-hook views) and ["registry"] — attach/detach touch `hooks_global` /
// `projects.<n>.hooks`, and new/edit/delete rewrite the top-level `hooks:` map,
// all of which other registry-driven surfaces (project workspace, palette) read.
// All Tauri calls route through @/lib/ipc (house rule; enforced by the import
// guard test).

import { useMutation, useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import type { HubResult } from "@/types";

// ─── JSON shapes (mirror hub.py's `_hook_def_dict` + cmd_hook_* --json) ────────

/** A hook's script action (hook-editor-redesign D3). Mutually exclusive with a
 *  non-empty `command`; absent for command hooks. `body` is populated by
 *  `hook show --json` for MANAGED scripts only (read from disk, null if the file
 *  is missing); `path` is the project-relative path for REPO scripts only. */
export interface HookScriptSpec {
	source: "managed" | "repo";
	path?: string | null;
	interpreter: string;
	args?: string | null;
	body?: string | null;
}

/** One hook's definition, shared by list rows and `show`. */
export interface HookDefinition {
	name: string;
	provenance: "user" | "builtin";
	event: string;
	command: string;
	description: string;
	tools: string[];
	matcher: string;
	timeout: number | null;
	harnesses: string[] | null;
	settings: Record<string, unknown>;
	/** Absent on command hooks (and on every pre-script registry). */
	script?: HookScriptSpec | null;
}

/** Compact action discriminator on `hook list --json` rows. */
export type HookAction = "command" | "script:managed" | "script:repo";

/** A library row = a definition + its attach summary. */
export interface HookRow extends HookDefinition {
	attached_global: boolean;
	attached_projects: string[];
	/** Optional: older CLIs omit it; the UI derives from `script` as a fallback. */
	action?: HookAction;
	/** The command line the harness actually receives after sync, at the
	 *  GLOBAL scope — computed read-only, never written. `null` on error;
	 *  absent on older CLIs. A built-in row must show this instead of
	 *  `command`, which is only a template. */
	baked_command?: string | null;
}

/** Per-harness capability verdict (probe cache / `hook list` reach map). */
export type HookVerdict =
	| "supported"
	| "feature_off"
	| "unsupported"
	| "not_installed";

/** `hub hook list --json`. `reach` is verdict-only; full reasons come from
 *  `useHookCapabilities()`. */
export interface HookListResult {
	hooks: HookRow[];
	reach: Record<string, string>;
}

/** Per-attached-project existence of a REPO script path (`show --json`). */
export interface HookScriptProject {
	project: string;
	path_exists: boolean;
}

/** One file inside a built-in hook's dir (`code_home()/hooks/<name>/`). `body`
 *  is `null` when the file was unreadable or over 512 KiB. */
export interface HookBuiltinFile {
	name: string;
	path: string;
	body: string | null;
}

/** A provenance-`builtin` hook's readable source, for `HookShow.builtin`. */
export interface HookBuiltinInfo {
	dir: string;
	files: HookBuiltinFile[];
}

/** One `command_script.locations[]` entry — a candidate script path resolved
 *  against a project (or, for `absolute`/`home`, the one machine-wide path). */
export interface HookCommandScriptLocation {
	/** `null` for `absolute`/`home` kinds. */
	project: string | null;
	path: string;
	exists: boolean;
	/** `null` when `exists` is false, or when the file was unreadable/too big. */
	body: string | null;
	/** Why `body` is null despite `exists: true` (`"unreadable"` |
	 *  `"too_large"`), why a relative token never resolved into the project
	 *  (`"outside_project"` — a `..` token), or why the path itself could not
	 *  be expanded (`"unresolvable"` — e.g. a `~nosuchuser/...` token). `null`
	 *  otherwise. */
	reason: string | null;
}

/** The script a plain COMMAND hook's command line references, when it
 *  references one — the FIRST script-path token in the command
 *  (`risks.candidate_script_paths`). `null` for built-ins and script-backed
 *  hooks (`HookShow.command_script`). */
export interface HookCommandScript {
	token: string;
	kind: "absolute" | "home" | "relative";
	locations: HookCommandScriptLocation[];
}

/** A hand-written `<interpreter> <repo-relative path> [args]` command hook,
 *  recast as the fields `hub hook edit --script-source repo …` needs. `null`
 *  when the command is not that shape, or the path is not convertible
 *  (absolute / `~`-anchored / traversing — a repo script is per-project by
 *  definition). See `HookShow.repo_script_conversion`. */
export interface HookRepoScriptConversion {
	interpreter: "bash" | "python3";
	path: string;
	args: string;
}

/** `hub hook show --json` = the definition + resolved per-project settings. */
export interface HookShow extends HookRow {
	project_settings: Record<string, Record<string, unknown>>;
	reach: Record<string, string>;
	/** Repo scripts only: one entry per attached project. */
	script_projects?: HookScriptProject[];
	/** The command line the harness actually receives after sync, at the
	 *  GLOBAL scope — computed read-only, never written. `null` on error. */
	baked_command?: string | null;
	/** Provenance-`builtin` hooks only: its readable dir + files. `null` for a
	 *  user hook. */
	builtin?: HookBuiltinInfo | null;
	/** The script a plain command hook's command line references. `null` for
	 *  built-ins, script-backed hooks, and a command with no script token. */
	command_script?: HookCommandScript | null;
	/** A hand-written repo-script command, ready to convert. `null` when not
	 *  convertible. */
	repo_script_conversion?: HookRepoScriptConversion | null;
}

/** `hub hook script show <name> --json` — the managed script's body on disk. */
export interface HookScriptShow {
	name?: string;
	source?: string;
	interpreter?: string;
	/** ABSOLUTE path of the managed script file (what a delete would remove). */
	path?: string;
	/** null when the file is missing (the hook is baked-skipped at sync time). */
	body?: string | null;
}

/** One harness entry in the capability cache (verdict + reason + extra badge
 *  data). Mirrors harness_probe.HookCapability.to_dict(). */
export interface HookCapabilityEntry {
	harness_id: string;
	verdict: HookVerdict;
	reason: string;
	extra: Record<string, unknown>;
}

/** The whole `state/harness-capabilities.json` payload, or null when the probe
 *  has never run (no sync yet). */
export interface HookCapabilitiesCache {
	schema_version: number;
	probed_at: string;
	harnesses: Record<string, HookCapabilityEntry>;
}

/** One `hub hook doctor --json` finding, attributed to exactly one hook (never
 *  by parsing `detail` — the backend calls `detect_hook_risks`/
 *  `detect_hook_script_risks` once per hook so `hook` is authoritative). */
export interface HookDoctorFinding {
	hook: string;
	scope: string;
	harness: string;
	code: string;
	severity: "danger" | "warning" | "info";
	explanation: string;
	detail: string;
}

/** `hub hook doctor --json`. `--json` mode always exits 0 — a danger finding is
 *  data, not a failed read (see docs/HOOKS.md §Doctor findings). */
export interface HookDoctorResult {
	findings: HookDoctorFinding[];
	danger_count: number;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function useHookList() {
	return useQuery({
		queryKey: qk.hooks.list(),
		queryFn: () => invoke<HookListResult>("hook_list"),
	});
}

export function useHook(name: string | undefined) {
	return useQuery({
		queryKey: qk.hooks.show(name ?? ""),
		queryFn: () => invoke<HookShow>("hook_show", { name }),
		enabled: !!name && name !== "new",
	});
}

/** Cached per-harness hook capability (verdict + reason). Read straight from the
 *  probe cache — NEVER probes on render. `staleTime` long: the cache only
 *  changes on a `hub sync`. Returns null until the first sync. */
export function useHookCapabilities() {
	return useQuery({
		queryKey: qk.hooks.capabilities(),
		queryFn: () => invoke<HookCapabilitiesCache | null>("hook_capabilities"),
		staleTime: 60_000,
		refetchOnWindowFocus: false,
	});
}

/** Read-only risk scan over every attached hook. `staleTime`/`refetchOnWindowFocus`
 *  mirror `usePermissionsDoctor` — health only actually changes on a sync, which
 *  `invalidateRegistry` already invalidates this query for. */
export function useHookDoctor() {
	return useQuery({
		queryKey: qk.hooks.doctor(),
		queryFn: () => invoke<HookDoctorResult>("hook_doctor"),
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
}

/** The managed script body for `name`. Enabled only when the hook actually IS a
 *  managed-script hook — `hub hook script show` errors for every other kind, and
 *  a rejected query would paint a spurious error on a plain command hook. */
export function useHookScript(name: string | undefined, enabled: boolean) {
	return useQuery({
		queryKey: qk.hooks.script(name ?? ""),
		queryFn: () => invoke<HookScriptShow | null>("hook_script_show", { name }),
		enabled: !!name && name !== "new" && enabled,
	});
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/** Invalidate every query a hook mutation can touch. */
export async function invalidateHooks() {
	await queryClient.invalidateQueries({ queryKey: qk.hooks.all() });
	await invalidateRegistry(queryClient);
}

/** Script flags shared by new + edit, mapping 1:1 onto the CLI's
 *  `--script-source/-interpreter/-path/-args/-body-file` group. `scriptSource:
 *  ""` is the explicit CLEAR sentinel on edit (drop the script block). */
export interface HookScriptInput {
	scriptSource?: "" | "managed" | "repo";
	scriptInterpreter?: string;
	scriptPath?: string;
	scriptArgs?: string;
	/** Managed only: seeds/overwrites the script file (Rust writes a temp file
	 *  and passes `--script-body-file`). */
	scriptBody?: string;
}

export interface HookNewInput extends HookScriptInput {
	name: string;
	event: string;
	/** Empty when the hook uses a script instead of a shell command. */
	command?: string;
	description?: string;
	tools?: string[];
	matcher?: string;
	timeout?: number | null;
	harnesses?: string[] | null;
}

/** Shared marshalling for the optional script flags (identical on new + edit).
 *  `undefined` → null → the Rust bridge omits the flag entirely. */
function scriptArgsPayload(input: HookScriptInput) {
	return {
		scriptSource: input.scriptSource ?? null,
		scriptInterpreter: input.scriptInterpreter ?? null,
		scriptPath: input.scriptPath ?? null,
		scriptArgs: input.scriptArgs ?? null,
		scriptBody: input.scriptBody ?? null,
	};
}

export function useHookNew() {
	return useMutation({
		mutationFn: (input: HookNewInput) =>
			invoke<HubResult>("hook_new", {
				name: input.name,
				event: input.event,
				command: input.command ?? null,
				description: input.description ?? null,
				tools: input.tools ?? null,
				matcher: input.matcher ?? null,
				timeout: input.timeout ?? null,
				harnesses: input.harnesses ?? null,
				...scriptArgsPayload(input),
			}),
		onSuccess: invalidateHooks,
	});
}

export interface HookEditInput extends HookScriptInput {
	name: string;
	event?: string;
	command?: string;
	description?: string;
	tools?: string[];
	matcher?: string;
	timeout?: number | null;
	harnesses?: string[] | null;
}

export function useHookEdit() {
	return useMutation({
		mutationFn: (input: HookEditInput) =>
			invoke<HubResult>("hook_edit", {
				name: input.name,
				event: input.event ?? null,
				command: input.command ?? null,
				description: input.description ?? null,
				tools: input.tools ?? null,
				matcher: input.matcher ?? null,
				// The Rust bridge takes a raw string here (not a number) so an
				// explicit clear ("") is distinguishable from "field not touched"
				// (undefined -> null -> omitted --timeout flag). `null` means
				// "the field is now empty" -> send "" to clear; a number means
				// "set to this value" -> stringify it; `undefined` means the
				// caller never mentioned timeout -> don't touch it.
				timeout:
					input.timeout === undefined
						? null
						: String(input.timeout ?? ""),
				harnesses: input.harnesses ?? null,
				...scriptArgsPayload(input),
			}),
		onSuccess: invalidateHooks,
	});
}

/** Overwrite a MANAGED script's body. The Rust bridge writes the body to a temp
 *  file and passes `--body-file` (the CLI never takes a body on argv — a script
 *  is arbitrary text and would not survive argument quoting). */
export function useHookScriptSave() {
	return useMutation({
		mutationFn: (vars: { name: string; body: string }) =>
			invoke<HubResult>("hook_script_save", vars),
		onSuccess: invalidateHooks,
	});
}

export function useHookDelete() {
	return useMutation({
		mutationFn: (vars: { name: string; confirm: boolean }) =>
			invoke<HubResult>("hook_delete", vars),
		onSuccess: invalidateHooks,
	});
}

export interface HookScopeInput {
	name: string;
	global?: boolean;
	project?: string;
}

export function useHookAttach() {
	return useMutation({
		mutationFn: (vars: HookScopeInput) =>
			invoke<HubResult>("hook_attach", {
				name: vars.name,
				global: !!vars.global,
				project: vars.project ?? null,
			}),
		onSuccess: invalidateHooks,
	});
}

export function useHookDetach() {
	return useMutation({
		mutationFn: (vars: HookScopeInput) =>
			invoke<HubResult>("hook_detach", {
				name: vars.name,
				global: !!vars.global,
				project: vars.project ?? null,
			}),
		onSuccess: invalidateHooks,
	});
}

export function useHookSetSettings() {
	return useMutation({
		mutationFn: (vars: {
			name: string;
			settings: Record<string, unknown>;
			global?: boolean;
			project?: string;
		}) =>
			invoke<HubResult>("hook_set_settings", {
				name: vars.name,
				settings: vars.settings,
				global: !!vars.global,
				project: vars.project ?? null,
			}),
		onSuccess: invalidateHooks,
	});
}
