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
import type { HubResult } from "@/types";

// ─── JSON shapes (mirror hub.py's `_hook_def_dict` + cmd_hook_* --json) ────────

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
}

/** A library row = a definition + its attach summary. */
export interface HookRow extends HookDefinition {
	attached_global: boolean;
	attached_projects: string[];
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

/** `hub hook show --json` = the definition + resolved per-project settings. */
export interface HookShow extends HookRow {
	project_settings: Record<string, Record<string, unknown>>;
	reach: Record<string, string>;
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

// ─── Reads ────────────────────────────────────────────────────────────────────

export function useHookList() {
	return useQuery({
		queryKey: ["hooks", "list"],
		queryFn: () => invoke<HookListResult>("hook_list"),
	});
}

export function useHook(name: string | undefined) {
	return useQuery({
		queryKey: ["hooks", "show", name],
		queryFn: () => invoke<HookShow>("hook_show", { name }),
		enabled: !!name && name !== "new",
	});
}

/** Cached per-harness hook capability (verdict + reason). Read straight from the
 *  probe cache — NEVER probes on render. `staleTime` long: the cache only
 *  changes on a `hub sync`. Returns null until the first sync. */
export function useHookCapabilities() {
	return useQuery({
		queryKey: ["hooks", "capabilities"],
		queryFn: () => invoke<HookCapabilitiesCache | null>("hook_capabilities"),
		staleTime: 60_000,
		refetchOnWindowFocus: false,
	});
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/** Invalidate every query a hook mutation can touch. */
export async function invalidateHooks() {
	await queryClient.invalidateQueries({ queryKey: ["hooks"] });
	await queryClient.invalidateQueries({ queryKey: ["registry"] });
}

export interface HookNewInput {
	name: string;
	event: string;
	command: string;
	tools?: string[];
	matcher?: string;
	timeout?: number | null;
	harnesses?: string[] | null;
}

export function useHookNew() {
	return useMutation({
		mutationFn: (input: HookNewInput) =>
			invoke<HubResult>("hook_new", {
				name: input.name,
				event: input.event,
				command: input.command,
				tools: input.tools ?? null,
				matcher: input.matcher ?? null,
				timeout: input.timeout ?? null,
				harnesses: input.harnesses ?? null,
			}),
		onSuccess: invalidateHooks,
	});
}

export interface HookEditInput {
	name: string;
	event?: string;
	command?: string;
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
			}),
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
