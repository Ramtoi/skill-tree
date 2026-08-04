// ─── Hook event + tool catalog (TS mirror of tool_catalog.py) ─────────────────
// The backend (hooks-surface D3) owns the canonical event vocabulary + per-harness
// support sets and the tool vocabulary in `tool_catalog.py`. That module is not
// exposed over a CLI/Tauri command, so the editor mirrors the small pinned
// constants here (same pattern as lib/permissionsRisks.ts duplicating risk
// predicates). Keep in lockstep with tool_catalog.py:
//   * CANONICAL_EVENTS  — the 14 Claude-family hook events (task-0 pinned)
//   * _CODEX_EVENTS      — the 10-event codex subset
//   * CANONICAL_TOOLS    — seeded from subagents.KNOWN_TOOLS
// A golden Vitest test (hookCatalog.test.ts) pins the event lists.

import type { Registry } from "@/types";

/** Canonical event vocabulary (ordered), mirroring tool_catalog.CANONICAL_EVENTS. */
export const CANONICAL_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"Notification",
	"PreCompact",
	"PostCompact",
	"FileChanged",
] as const;

export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

/** Codex's 10-event subset (tool_catalog._CODEX_EVENTS). */
const CODEX_EVENTS = new Set<string>([
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"UserPromptSubmit",
	"SubagentStart",
	"SubagentStop",
	"Stop",
]);

/** Per-harness event support. Only the two harnesses hub writes hooks to in v1
 *  carry a support set; every other harness supports no hook events (no adapter). */
const EVENT_SUPPORT: Record<string, Set<string>> = {
	"claude-code": new Set(CANONICAL_EVENTS),
	codex: CODEX_EVENTS,
};

/** True iff `harnessId` understands hook `event` (mirrors event_supported). */
export function eventSupported(event: string, harnessId: string): boolean {
	return EVENT_SUPPORT[harnessId]?.has(event) ?? false;
}

/** Canonical built-in tool tokens offered in the picker. Mirrors the edit family
 *  + common matcher targets; the raw `matcher` field is the escape hatch for
 *  anything outside this set. (subagents.KNOWN_TOOLS is the Python seed.) */
// Kept in lockstep with subagents.KNOWN_TOOLS (via tool_catalog.CANONICAL_TOOLS)
// — a pinned test (hookHelpers.test.ts) asserts this list's size against a
// golden count so a future addition there doesn't silently drift here again.
export const CANONICAL_TOOLS = [
	"Agent",
	"AskUserQuestion",
	"Artifact",
	"Bash",
	"BashOutput",
	"CronCreate",
	"CronDelete",
	"CronList",
	"DesignSync",
	"Edit",
	"EnterPlanMode",
	"EnterWorktree",
	"ExitPlanMode",
	"ExitWorktree",
	"Glob",
	"Grep",
	"KillShell",
	"ListMcpResourcesTool",
	"LSP",
	"Monitor",
	"MultiEdit",
	"NotebookEdit",
	"NotebookRead",
	"PushNotification",
	"ReadMcpResourceDirTool",
	"ReadMcpResourceTool",
	"Read",
	"RemoteTrigger",
	"ScheduleWakeup",
	"SendMessage",
	"Skill",
	"SlashCommand",
	"Task",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskUpdate",
	"TeamCreate",
	"TeamDelete",
	"TodoWrite",
	"ToolSearch",
	"WaitForMcpServers",
	"WebFetch",
	"WebSearch",
	"Write",
] as const;

/** Server-level MCP matcher tokens (`mcp__<server>`) derived from the registry's
 *  mcp-server skills. Mirrors tool_catalog.mcp_tool_names. */
export function mcpToolTokens(registry: Registry | undefined): string[] {
	if (!registry?.skills) return [];
	return Object.entries(registry.skills)
		.filter(([, cfg]) => cfg?.type === "mcp-server")
		.map(([name]) => `mcp__${name}`)
		.sort();
}

/** Full picker vocabulary: canonical tools + dynamic MCP tokens, deduped/sorted. */
export function hookToolVocabulary(registry: Registry | undefined): string[] {
	const tokens = new Set<string>(CANONICAL_TOOLS);
	for (const t of mcpToolTokens(registry)) tokens.add(t);
	return Array.from(tokens).sort();
}
