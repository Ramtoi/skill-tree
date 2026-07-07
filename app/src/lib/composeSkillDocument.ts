// ─── Synthesized SKILL.md document (frontmatter + body) ───────────────────────
// Mirrors `build_skill_document` in registry.rs so the token estimate and the
// frontmatter-aware diff compare the exact bytes the hub writes to disk. Lifted
// out of SkillEditor so the diff can feed `composeSkillDocument(savedMeta,
// savedBody)` vs `composeSkillDocument(currentMeta, body)` — making metadata
// edits (name/description) show in the diff even though they aren't in the body.

export interface SkillDocMeta {
	name: string;
	description: string;
}

export function composeSkillDocument(meta: SkillDocMeta, body: string): string {
	const description = meta.description ?? "";
	const indented = description.trim()
		? description
				.trimEnd()
				.split("\n")
				.map((line) => (line === "" ? "  " : `  ${line}`))
				.join("\n")
		: "  ";
	const fm = `---\nname: ${meta.name.trim()}\ndescription: |\n${indented}\n---\n\n`;
	return fm + body.trimEnd() + "\n";
}
