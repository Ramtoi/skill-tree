import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { runHubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { DroppedSkill } from "@/types";

interface DroppedSkillsPayload {
	ok?: boolean;
	skills?: DroppedSkill[];
}

async function fetchDroppedSkills(): Promise<DroppedSkill[]> {
	const res = await runHubCmd(["source", "dropped", "--json"]);
	// Read-only, so there is no `_auto_sync()` chatter to defend against — but
	// `parseCliJson` (never a bare `JSON.parse`) is the one contract every CLI
	// reader honors, so a future change to this command degrades gracefully.
	const payload = parseCliJson<DroppedSkillsPayload>(res.output);
	return payload.skills ?? [];
}

/** Every `source_missing` skill across every source. Read-only — never
 *  mutates, never syncs. Stales alongside the registry (see `lib/invalidate.ts`
 *  — any write can flip a skill's `source_missing` flag). */
export function useDroppedSkills(): UseQueryResult<DroppedSkill[]> {
	return useQuery({
		queryKey: qk.droppedSkills(),
		queryFn: fetchDroppedSkills,
	});
}

async function fetchDroppedSkill(name: string): Promise<DroppedSkill | null> {
	const res = await runHubCmd([
		"source",
		"dropped",
		"--skill",
		name,
		"--content",
		"--json",
	]);
	const payload = parseCliJson<DroppedSkillsPayload>(res.output);
	return payload.skills?.[0] ?? null;
}

/** The one-skill `--content` variant, for the editor body of a dropped skill.
 *  `enabled` is the caller's own `skill.source_missing` check — there is
 *  nothing useful to read here for a normal skill. */
export function useDroppedSkill(
	name: string | undefined,
	enabled: boolean,
): UseQueryResult<DroppedSkill | null> {
	return useQuery({
		queryKey: qk.droppedSkill(name ?? ""),
		queryFn: () => fetchDroppedSkill(name ?? ""),
		enabled: !!name && enabled,
	});
}
