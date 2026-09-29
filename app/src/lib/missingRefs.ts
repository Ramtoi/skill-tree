// The equip-time skill-refs guardrail (design D-equip-guardrail, plans/3-project.md).
// Evidence-based, not predictive: every read here comes from the last `hub sync`
// report's `missing_refs` field (PR1), because the rule needs a skill's body text
// and the registry does not carry it. Pure module — no React import; `async`
// appears only on `announceMissingRefs`, which awaits the caller's fresh-report
// fetch (`queryClient.fetchQuery({ queryKey: qk.syncReport(), queryFn: syncReportQueryFn, staleTime: 0 })`).

import type { MissingRef, SyncReportEnvelope } from "./syncFreshness";
import { projectRecord } from "./syncFreshness";
import { plural } from "@/lib/plural";

export type { MissingRef };

/** Every `{skill, refs}` pair the last sync report recorded for one project.
 *  `[]` for an absent envelope, an unknown project, or a report predating the
 *  field — never throws. */
export function projectMissingRefs(
	projectName: string,
	env: SyncReportEnvelope | null | undefined,
): MissingRef[] {
	return projectRecord(projectName, env)?.missing_refs ?? [];
}

/** The missing ref names for one skill, from an already-resolved record list
 *  (e.g. `projectMissingRefs(...)`). `[]` when the skill is not flagged. */
export function missingRefsIn(records: MissingRef[], skillName: string): string[] {
	return records.find((r) => r.skill === skillName)?.refs ?? [];
}

/** The Loadout badge predicate: does this resolved record list flag `skillName`? */
export function skillMissesRefs(records: MissingRef[], skillName: string): boolean {
	return missingRefsIn(records, skillName).length > 0;
}

/** Alphabetical, at most three named, then `+N more`. No backticks — the
 *  identifier-in-mono typography rule applies to rendered UI, not to a plain
 *  toast title string. */
function formatRefsList(refs: readonly string[]): string {
	const sorted = Array.from(new Set(refs)).sort((a, b) => a.localeCompare(b));
	if (sorted.length <= 3) return sorted.join(", ");
	return `${sorted.slice(0, 3).join(", ")}, +${sorted.length - 3} more`;
}

/** The single-skill toast title: `<skillName> references <refs…>`. */
export function refsSentence(skillName: string, refs: readonly string[]): string {
	return `${skillName} references ${formatRefsList(refs)}`;
}

export interface RefsGuardrailToastAction {
	label: string;
	onClick: () => void | Promise<void>;
}

export interface RefsGuardrailToastInput {
	kind?: "info";
	title: string;
	body?: string;
	duration?: number;
	action?: RefsGuardrailToastAction;
}

export interface RefsGuardrailDeps {
	toast: { push: (t: RefsGuardrailToastInput) => void };
	/** One `hub enable <skill> --project <p> --with-refs` per flagged skill —
	 *  never one call per ref (grill B2). */
	equipRefs: (skill: string, project: string) => Promise<void>;
	/** The FRESH sync report — a `fetchQuery` with `staleTime: 0`, never a
	 *  cache peek (grill B1: `invalidateQueries` only refetches active
	 *  observers, so a peek can return the pre-equip envelope). */
	readEnv: () => Promise<SyncReportEnvelope | null>;
}

/** Read the fresh report and return flagged records without emitting UI. */
export async function collectMissingRefs(
	skillNames: string[],
	projectName: string,
	deps: Pick<RefsGuardrailDeps, "readEnv">,
): Promise<MissingRef[]> {
	try {
		const env = await deps.readEnv();
		return projectMissingRefs(projectName, env).filter(
			(r) => skillNames.includes(r.skill) && r.refs.length > 0,
		);
	} catch {
		return [];
	}
}

/**
 * Reads the fresh sync report and, if any of `skillNames` was just equipped
 * with a missing reference, pushes ONE aggregate `info` toast with an
 * `Equip N` action that runs `equipRefs` for each flagged skill in sequence.
 * Never throws: an absent envelope, an unknown project, a report predating
 * `missing_refs`, or a `readEnv` rejection all resolve to `[]` with no toast —
 * a warning that cannot be trusted is worse than silence.
 */
export async function announceMissingRefs(
	skillNames: string[],
	projectName: string,
	deps: RefsGuardrailDeps,
	opts?: { subject?: string },
): Promise<MissingRef[]> {
	const flagged = await collectMissingRefs(skillNames, projectName, deps);
	if (flagged.length === 0) return [];

	const allRefs = Array.from(new Set(flagged.flatMap((r) => r.refs))).sort(
		(a, b) => a.localeCompare(b),
	);

	const onClick = async () => {
		for (const rec of flagged) {
			await deps.equipRefs(rec.skill, projectName);
		}
	};

	if (flagged.length === 1) {
		const [rec] = flagged;
		deps.toast.push({
			kind: "info",
			title: refsSentence(rec.skill, rec.refs),
			body: `Not equipped on ${projectName}.`,
			duration: 8000,
			action: { label: `Equip ${allRefs.length}`, onClick },
		});
	} else {
		// A named subject (a bundle apply) is grammatically singular ("android
		// references …"); the default plural subject keeps "skills reference"
		// agreement.
		const refWord = plural(allRefs.length, "skill");
		const title = opts?.subject
			? `${opts.subject} references ${allRefs.length} ${refWord}`
			: `${flagged.length} skills reference ${allRefs.length} ${refWord}`;
		deps.toast.push({
			kind: "info",
			title,
			body: `${formatRefsList(allRefs)} · not equipped on ${projectName}`,
			duration: 8000,
			action: { label: `Equip ${allRefs.length}`, onClick },
		});
	}

	return flagged;
}
