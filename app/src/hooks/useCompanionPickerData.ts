// I8 (plan 2 §Approach 1/9, wave C): the "add existing" picker's two lists —
// zero new IPC. Agents are the union of every agent-capable harness's
// already-loaded `hub subagent list --harness <h> --json`, keyed by name, so
// an agent present on both harnesses appears once with both flags set (W13).
// Hooks are the hooks library (`["hooks","list"]`), minus whatever the skill
// being edited already ships INLINE — offering one of those as a `{ref}`
// would collide under the same name with the inline entry plan 1 already
// rejects (A18/C5).

import { useMemo } from "react";
import { useHookList } from "@/hooks/useHooks";
import { useSubagentList } from "@/hooks/useSubagents";
import type { SubagentHarness } from "@/lib/subagents";
import { isHookRef, type ShipsWith } from "@/lib/companions";

/** One agent the picker offers. `harnesses` lists every agent-capable
 *  harness this name exists on (`claude-code` first when present, so
 *  `sourceHarness` prefers the richer definition). `lossy` is true when the
 *  ONLY source is a harness whose copy drops fields (W13: a Codex-only agent
 *  has no `tools` and its tier falls back to `worker`) — the Sheet renders a
 *  hint from this, it never invents the words itself. */
export interface AgentPickerOption {
	name: string;
	description: string;
	harnesses: SubagentHarness[];
	/** The harness `CompanionsSetAgent.from` should name when this agent is
	 *  newly added this session. */
	sourceHarness: SubagentHarness;
	lossy: boolean;
}

/** One hook the picker offers as a reference candidate. */
export interface HookPickerOption {
	name: string;
	event: string;
	command: string;
}

export interface CompanionPickerData {
	agents: AgentPickerOption[];
	hooks: HookPickerOption[];
	/** True while any of the underlying lists hasn't resolved yet — the Sheet
	 *  shows the picker as soon as data trickles in rather than blocking on
	 *  this, but a caller that wants a spinner can read it. */
	loading: boolean;
}

/** Every agent-capable harness this release exposes a sub-agent surface for
 *  (mirrors `useSubagents.ts`'s own private `LINKED_HARNESSES`) — fixed at
 *  two, so each is its own hook call rather than a loop over the list. */
export function useCompanionPickerData(declared: ShipsWith): CompanionPickerData {
	const claudeAgents = useSubagentList("user", null, true, "claude-code");
	const codexAgents = useSubagentList("user", null, true, "codex");
	const hookListQuery = useHookList();

	const agents = useMemo(() => {
		const byName = new Map<string, AgentPickerOption>();
		const add = (harness: SubagentHarness, rows: { name: string; description: string }[]) => {
			for (const a of rows) {
				const existing = byName.get(a.name);
				if (existing) {
					existing.harnesses.push(harness);
				} else {
					byName.set(a.name, {
						name: a.name,
						description: a.description,
						harnesses: [harness],
						sourceHarness: harness,
						lossy: false,
					});
				}
			}
		};
		add("claude-code", claudeAgents.data?.agents ?? []);
		add("codex", codexAgents.data?.agents ?? []);
		for (const opt of byName.values()) {
			opt.sourceHarness = opt.harnesses.includes("claude-code") ? "claude-code" : opt.harnesses[0];
			opt.lossy = opt.sourceHarness !== "claude-code";
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [claudeAgents.data, codexAgents.data]);

	const hooks = useMemo(() => {
		const inlineNames = new Set(
			(declared.hooks ?? []).filter((h) => !isHookRef(h)).map((h) => h.name),
		);
		return (hookListQuery.data?.hooks ?? [])
			.filter((h) => !inlineNames.has(h.name))
			.map((h) => ({ name: h.name, event: h.event, command: h.command }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [hookListQuery.data, declared]);

	return {
		agents,
		hooks,
		loading: claudeAgents.isLoading || codexAgents.isLoading || hookListQuery.isLoading,
	};
}
