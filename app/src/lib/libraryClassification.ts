import type { Skill, SkillClassification } from "@/types";
import { asciiIdentity, compareClassContributions, type ClassificationContribution } from "@/lib/skillClassification";

export type ClassificationScope = "assigned" | "references";
export type ClassificationGroup = "scope" | "source" | "class" | "mode";

export interface LibraryClassificationSummary {
	classes: ClassificationContribution[];
	outputs: ClassificationContribution[];
}

export interface ClassificationOccurrence {
	skillName: string;
	groupKey: string;
	occurrenceKey: string;
}

export function classificationValues(
	skill: Skill,
	summary: LibraryClassificationSummary | undefined,
	scope: ClassificationScope,
): LibraryClassificationSummary {
	if (scope === "references" && summary) return summary;
	return {
		classes: (skill.classification?.classes ?? []).map<ClassificationContribution>((value) => ({ value, provenance: "assigned", contributors: [] })).sort(compareClassContributions),
		outputs: (skill.classification?.outputs ?? []).map((value) => ({ value, provenance: "assigned", contributors: [] })),
	};
}

export function classValues(
	skill: Skill,
	summary: LibraryClassificationSummary | undefined,
	scope: ClassificationScope,
): string[] {
	return classificationValues(skill, summary, scope).classes.map((item) => item.value);
}

export function passesClassification(
	skill: Skill,
	summary: LibraryClassificationSummary | undefined,
	classFilter: string | null,
	modeFilter: SkillClassification["working_mode"] | "all",
	scope: ClassificationScope,
): boolean {
	const values = classValues(skill, summary, scope);
	if (classFilter && !values.some((value) => asciiIdentity(value) === asciiIdentity(classFilter))) return false;
	if (modeFilter !== "all" && skill.classification?.working_mode !== modeFilter) return false;
	return true;
}

export function groupedClassificationEntries(
	entries: Array<[string, Skill]>,
	group: ClassificationGroup,
): Array<{ key: string; label: string; items: Array<[string, Skill]> }> {
	const groups = new Map<string, Array<[string, Skill]>>();
	for (const entry of entries) {
		const [, skill] = entry;
		const values = group === "class"
			? skill.classification?.classes ?? []
			: group === "mode"
				? [skill.classification?.working_mode ?? "unspecified"]
				: ["all"];
		for (const value of values.length ? values : ["__unclassified__"]) {
			const key = group === "class" ? (values.length === 0 ? "__unclassified__" : `class:${asciiIdentity(value)}`) : value;
			const items = groups.get(key) ?? [];
			items.push(entry);
			groups.set(key, items);
		}
	}
	const modeOrder = ["inline", "delegator", "mixed", "unspecified"];
	return [...groups.entries()]
		.sort(([a], [b]) => group === "mode" ? (modeOrder.indexOf(a) - modeOrder.indexOf(b)) : a === "__unclassified__" ? 1 : b === "__unclassified__" ? -1 : a < b ? -1 : a > b ? 1 : 0)
		.map(([key, items]) => ({ key, label: key === "__unclassified__" ? "UNCLASSIFIED" : key === "unspecified" ? "UNSPECIFIED" : key.replace(/^class:/, "").toUpperCase(), items }));
}
