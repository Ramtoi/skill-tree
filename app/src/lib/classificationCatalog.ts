import { asciiIdentity } from "@/lib/skillClassification";

export type ClassificationListField = "classes" | "outputs";

export interface ClassificationCatalogEntry {
	value: string;
	label: string;
	description: string;
	aliases: readonly string[];
}

const classEntries: readonly ClassificationCatalogEntry[] = [
	{ value: "research", label: "Research", description: "Questions, discovery, diagnosis, and evidence gathering.", aliases: ["discovery", "research", "diagnosis", "triage", "learning"] },
	{ value: "planning", label: "Planning", description: "Framing decisions, shaping outcomes, and making plans.", aliases: ["framing", "ideation", "planning", "specification"] },
	{ value: "design", label: "Design", description: "Interfaces, architecture, and experience decisions.", aliases: ["architecture", "design"] },
	{ value: "implementation", label: "Build", description: "Hands-on setup, debugging, and code changes.", aliases: ["implementation", "debugging", "setup"] },
	{ value: "review", label: "Review", description: "Checks, tests, verification, and review work.", aliases: ["review", "testing", "verification"] },
	{ value: "delivery", label: "Delivery", description: "Branch, release, and deployment operations.", aliases: ["delivery"] },
	{ value: "coordination", label: "Coordination", description: "Routing work, handoffs, and continuity.", aliases: ["coordination", "orchestration", "continuity"] },
	{ value: "writing", label: "Writing", description: "Text, documentation, prompts, and explanations.", aliases: ["writing", "documentation", "explanation", "prompting"] },
];

const outputEntries: readonly ClassificationCatalogEntry[] = [
	{ value: "prompt", label: "Prompt", description: "A reusable instruction for another agent or session.", aliases: ["prompt", "execution prompt", "handoff prompt", "agent brief", "agent instructions", "bounded assignments", "handoff"] },
	{ value: "plan", label: "Plan", description: "An executable plan that guides future work.", aliases: ["plan", "durable technical plan", "executable plan", "spec", "vision brief"] },
	{ value: "change", label: "Change", description: "A bounded implementation or regression fix.", aliases: ["code change", "verified bounded change", "regression test"] },
	{ value: "report", label: "Report", description: "Findings and recommendations for a decision.", aliases: ["review", "research report", "cited findings", "evidence-backed findings", "workflow audit", "prioritized recommendations", "deployment report"] },
	{ value: "evidence", label: "Evidence", description: "Proof that a behavior or acceptance condition holds.", aliases: ["acceptance evidence", "accepted evidence", "journey evidence", "regression evidence", "root cause and regression evidence", "visual proof"] },
	{ value: "document", label: "Document", description: "Written text, instructions, decisions, or saved context.", aliases: ["decision record", "durable decision record", "deferred observation", "design ledger", "design rationale", "interface rationale", "discussion log", "glossary", "issue", "issue update", "task checkpoint", "revised text"] },
	{ value: "prototype", label: "Prototype", description: "An isolated experiment for settling choices.", aliases: ["prototype"] },
	{ value: "visual", label: "Visual", description: "A diagram, chart, or visual explanation.", aliases: ["visualization"] },
	{ value: "release", label: "PR / release", description: "A reviewable PR or authorized release.", aliases: ["PR", "reviewable PR", "PR or authorized release"] },
];

export const CLASSIFICATION_CATALOG: Record<ClassificationListField, readonly ClassificationCatalogEntry[]> = {
	classes: classEntries,
	outputs: outputEntries,
};

export function classificationCatalogEntry(field: ClassificationListField, value: string): ClassificationCatalogEntry | undefined {
	const identity = asciiIdentity(value.trim());
	return CLASSIFICATION_CATALOG[field].find((entry) => asciiIdentity(entry.value) === identity);
}

export function classificationLabel(field: ClassificationListField, value: string): string {
	return classificationCatalogEntry(field, value)?.label ?? value;
}

export function searchClassificationCatalog(field: ClassificationListField, query: string): ClassificationCatalogEntry[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [...CLASSIFICATION_CATALOG[field]];
	return CLASSIFICATION_CATALOG[field].filter((entry) => [entry.value, entry.label, entry.description, ...entry.aliases]
		.some((term) => term.toLocaleLowerCase().includes(needle)));
}

export function classificationAliasMatches(entry: ClassificationCatalogEntry, query: string): string[] {
	const needle = query.trim().toLocaleLowerCase();
	return needle ? entry.aliases.filter((alias) => alias.toLocaleLowerCase().includes(needle)) : [];
}
