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

/** One factual line per event — the `Select`'s per-option hint (side-panels
 *  wave 4): what picking it means, not when to use it. Typed against
 *  `CanonicalEvent` (AUDIT m7) so a missing or misspelled key is a compile
 *  error instead of a silent `undefined` hint the golden `CANONICAL_EVENTS`
 *  test can't see. */
export const EVENT_HINTS: Record<CanonicalEvent, string> = {
	PreToolUse: "Runs before a tool call; can block it.",
	PostToolUse: "Runs after a tool call finishes.",
	PostToolUseFailure: "Runs after a tool call fails.",
	PermissionRequest: "Runs when a permission prompt would show.",
	UserPromptSubmit: "Runs when the user submits a prompt.",
	SessionStart: "Runs when a session starts.",
	SessionEnd: "Runs when a session ends.",
	Stop: "Runs when the agent finishes responding.",
	SubagentStart: "Runs when a sub-agent starts.",
	SubagentStop: "Runs when a sub-agent finishes.",
	Notification: "Runs on a harness notification.",
	PreCompact: "Runs before the transcript is compacted.",
	PostCompact: "Runs after the transcript is compacted.",
	// Not "watched" (AUDIT m7) — nothing in tool_catalog.py or docs/HOOKS.md
	// describes a watch list; say only what is actually true.
	FileChanged: "Runs when a file changes on disk.",
};

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

// ─── Tool GROUPS (hook-editor-redesign D2) ────────────────────────────────────
// The flat ~50-checkbox vocabulary above is the MODEL; the picker needs
// progressive disclosure. "Common" is a curated shortcut list (the tools a hook
// realistically matches on), and the remaining groups partition EVERYTHING else
// so no token is unreachable. Membership is by explicit set, and "Other" is the
// catch-all — a tool added to CANONICAL_TOOLS with no group lands in Other
// rather than silently disappearing from the picker (pinned by a test).

/** The curated first group. Kept short on purpose: this is the 90% list. */
export const COMMON_TOOLS = [
	"Edit",
	"Write",
	"MultiEdit",
	"Bash",
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"Task",
	"Agent",
] as const;

/** Explicit membership for the non-Common groups (order = display order). */
const GROUP_MEMBERS: { id: string; label: string; tools: string[] }[] = [
	{
		id: "files",
		label: "Files",
		tools: ["NotebookEdit", "NotebookRead", "LSP"],
	},
	{
		id: "execution",
		label: "Execution",
		tools: [
			"BashOutput",
			"KillShell",
			"Monitor",
			"RemoteTrigger",
			"ScheduleWakeup",
			"CronCreate",
			"CronDelete",
			"CronList",
		],
	},
	{
		id: "agents",
		label: "Tasks & agents",
		tools: [
			"AskUserQuestion",
			"EnterPlanMode",
			"ExitPlanMode",
			"EnterWorktree",
			"ExitWorktree",
			"SendMessage",
			"Skill",
			"SlashCommand",
			"TaskCreate",
			"TaskGet",
			"TaskList",
			"TaskOutput",
			"TaskStop",
			"TaskUpdate",
			"TeamCreate",
			"TeamDelete",
			"TodoWrite",
		],
	},
	{ id: "web", label: "Web", tools: ["WebSearch"] },
	{
		id: "mcp",
		label: "MCP servers",
		tools: [
			"ListMcpResourcesTool",
			"ReadMcpResourceTool",
			"ReadMcpResourceDirTool",
			"WaitForMcpServers",
		],
	},
];

export interface ToolGroup {
	id: string;
	label: string;
	tools: string[];
}

/**
 * The picker's grouped vocabulary: `Common` first (curated), then
 * Files / Execution / Tasks & agents / Web / MCP servers (incl. the registry's
 * dynamic `mcp__*` tokens) / Other. Groups with no members are omitted, and the
 * union of every group is EXACTLY `hookToolVocabulary(registry)`.
 */
export function hookToolGroups(registry: Registry | undefined): ToolGroup[] {
	const vocab = hookToolVocabulary(registry);
	const remaining = new Set(vocab);
	const groups: ToolGroup[] = [];

	const take = (id: string, label: string, wanted: string[]) => {
		const tools = wanted.filter((t) => remaining.has(t));
		for (const t of tools) remaining.delete(t);
		if (tools.length) groups.push({ id, label, tools });
	};

	take("common", "Common", [...COMMON_TOOLS]);
	for (const g of GROUP_MEMBERS) {
		if (g.id === "mcp") {
			// Server tokens are dynamic, so they join the static MCP helpers.
			take(g.id, g.label, [...g.tools, ...mcpToolTokens(registry)]);
		} else {
			take(g.id, g.label, g.tools);
		}
	}
	// Whatever the explicit sets missed is still reachable.
	take("other", "Other", Array.from(remaining).sort());
	return groups;
}
