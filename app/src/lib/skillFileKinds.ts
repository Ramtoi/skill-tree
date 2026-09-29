/**
 * The shapes a skill's files take under the Agent Skills layout: `SKILL.md`
 * plus three optional folders — `references/` (read on demand), `scripts/`
 * (run by the agent) and `assets/` (used by the skill's output). The add-file
 * sheet offers them as kinds; anything else is a free path.
 */
export type SkillFileKind = "reference" | "script" | "asset" | "other";

export interface SkillFileKindMeta {
	label: string;
	/** Folder the kind lives in, without the trailing slash; `null` for a free path. */
	folder: string | null;
	/** Placeholder for the part the author types (after the folder). */
	placeholder: string;
	/** One line on what the harness does with a file of this kind. */
	consequence: string;
}

export const SKILL_FILE_KINDS: readonly SkillFileKind[] = [
	"reference",
	"script",
	"asset",
	"other",
];

export const SKILL_FILE_KIND_META: Record<SkillFileKind, SkillFileKindMeta> = {
	reference: {
		label: "Reference",
		folder: "references",
		placeholder: "notes.md",
		consequence:
			"Read on demand when SKILL.md points the agent at it. Docs, schemas, worked examples.",
	},
	script: {
		label: "Script",
		folder: "scripts",
		placeholder: "run.sh",
		consequence:
			"Run by the agent, so keep it self-contained. Shell, Python or Node.",
	},
	asset: {
		label: "Asset",
		folder: "assets",
		placeholder: "template.md",
		consequence:
			"Used by what the skill produces: templates, images, data files.",
	},
	other: {
		label: "Other",
		folder: null,
		placeholder: "references/notes.md",
		consequence: "Any path inside the skill folder.",
	},
};

/** The kind whose folder a typed path starts with, else `null`. */
export function kindForRel(rel: string): SkillFileKind | null {
	for (const kind of SKILL_FILE_KINDS) {
		const folder = SKILL_FILE_KIND_META[kind].folder;
		if (folder && rel.startsWith(`${folder}/`)) return kind;
	}
	return null;
}

/**
 * Re-home a value the author typed into the name field. A pasted full path
 * (`scripts/run.sh`) moves the kind and strips the folder; an absolute path
 * turns the kind off so the validator can say why it is refused. Anything
 * else stays as typed under the current kind.
 */
export function absorbTypedPath(
	kind: SkillFileKind,
	typed: string,
): { kind: SkillFileKind; rest: string } {
	const detected = kindForRel(typed);
	if (detected) {
		return {
			kind: detected,
			rest: typed.slice(SKILL_FILE_KIND_META[detected].folder!.length + 1),
		};
	}
	if (typed.startsWith("/") || /^[A-Za-z]:/.test(typed)) {
		return { kind: "other", rest: typed };
	}
	return { kind, rest: typed };
}

/** The full relative path a kind + name pair stands for. */
export function relForKind(kind: SkillFileKind, rest: string): string {
	const folder = SKILL_FILE_KIND_META[kind].folder;
	return folder ? `${folder}/${rest}` : rest;
}
