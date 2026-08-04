import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type { ProjectSkillCandidate } from "@/components/ProjectLocalSkills";

/** Cross-project project-local skill candidate aggregate
 *  (`hub project scan-skills --json` via `local_skill_candidates`). Each entry
 *  is a hand-authored `.claude/skills/<name>/` dir detected but not adopted. */
export function useLocalCandidates() {
	return useQuery({
		queryKey: ["localCandidates"],
		queryFn: async () => {
			try {
				return await invoke<ProjectSkillCandidate[]>("local_skill_candidates");
			} catch {
				return [] as ProjectSkillCandidate[];
			}
		},
		staleTime: 30_000,
	});
}
