import type {
	SkillFileEntry,
	SkillFileKind,
	SkillFileUneditableReason,
} from "@/lib/skillFiles";

/** The document a skill *is*. Pinned first, outside every folder group, and
 *  never removed by the filter — under a naive sort it lands after
 *  `references/` and reads as a peer of its own leaves. */
export const SKILL_MD = "SKILL.md";

/** Rows past this count get an always-visible filter (the navigator's rule,
 *  COMPONENTS.md §Navigator > Filter — no `Show N more`, no cap). */
export { FILTER_THRESHOLD } from "@/lib/navRules";

export interface SkillFileNode {
	rel: string;
	/** Last path segment — what the row shows in full-strength mono. */
	label: string;
	/** Segments between the group dir and the file name (`deep/`), rendered dim.
	 *  Empty for the corpus's actual shape; the flat model never hides a file. */
	dimPrefix: string;
	entry: SkillFileEntry;
}

export interface SkillFileGroup {
	dir: string;
	files: SkillFileNode[];
}

export interface SkillFileTree {
	pinned: SkillFileNode | null;
	/** Root-level files other than SKILL.md, alphabetical. */
	root: SkillFileNode[];
	/** One group per top-level directory, alphabetical. */
	groups: SkillFileGroup[];
	/** Every visible row in render order — the index space `useListNav` walks. */
	order: SkillFileNode[];
}

function nodeFor(entry: SkillFileEntry): SkillFileNode {
	const segments = entry.rel.split("/");
	const label = segments[segments.length - 1];
	// Anything between the top-level group dir and the file name. Only reachable
	// for depth ≥ 2, which the live corpus never uses — it degrades, never hides.
	const dimPrefix =
		segments.length > 2 ? `${segments.slice(1, -1).join("/")}/` : "";
	return { rel: entry.rel, label, dimPrefix, entry };
}

const byRel = (a: SkillFileNode, b: SkillFileNode) =>
	a.rel.localeCompare(b.rel, undefined, { numeric: true });

/**
 * Group a flat listing into the navigator's shape: SKILL.md pinned, then root
 * files, then one level of folder groups. Not a tree — the live library holds
 * 71 files at root, 55 at depth 1 and **0** deeper, so per-node expand state
 * and indent arithmetic buy nothing.
 *
 * `filter` is a case-insensitive substring match on the rel path. SKILL.md is
 * exempt: it is the router every other file is subordinate to.
 */
export function buildSkillFileTree(
	entries: SkillFileEntry[],
	filter = "",
): SkillFileTree {
	const needle = filter.trim().toLowerCase();
	const matches = (rel: string) =>
		!needle || rel.toLowerCase().includes(needle);

	let pinned: SkillFileNode | null = null;
	const root: SkillFileNode[] = [];
	const groups = new Map<string, SkillFileNode[]>();

	for (const entry of entries) {
		if (entry.rel === SKILL_MD) {
			pinned = nodeFor(entry);
			continue;
		}
		if (!matches(entry.rel)) continue;
		const node = nodeFor(entry);
		const slash = entry.rel.indexOf("/");
		if (slash === -1) {
			root.push(node);
		} else {
			const dir = entry.rel.slice(0, slash);
			const bucket = groups.get(dir);
			if (bucket) bucket.push(node);
			else groups.set(dir, [node]);
		}
	}

	root.sort(byRel);
	const grouped: SkillFileGroup[] = [...groups.entries()]
		.map(([dir, files]) => ({ dir, files: files.sort(byRel) }))
		.sort((a, b) => a.dir.localeCompare(b.dir));

	const order: SkillFileNode[] = [];
	if (pinned) order.push(pinned);
	order.push(...root);
	for (const group of grouped) order.push(...group.files);

	return { pinned, root, groups: grouped, order };
}

/** Row glyph. Existing `icons.ts` keys only — COMPONENTS.md §Icons forbids
 *  inventing SVG, and kind is carried by shape, never by hue. */
export function skillFileIcon(
	kind: SkillFileKind,
	reason: SkillFileUneditableReason | null,
): string {
	if (reason === "symlink_outside") return "link";
	if (kind === "script") return "code";
	if (kind === "data") return "list";
	return "doc";
}

/** `data-kind` attribute value — the CSS hook for the dimmed binary glyph. */
export function skillFileKindAttr(
	kind: SkillFileKind,
	reason: SkillFileUneditableReason | null,
): string {
	if (reason === "symlink_outside") return "link";
	if (kind === "markdown") return "md";
	if (kind === "script") return "code";
	if (kind === "data") return "data";
	if (kind === "binary") return "binary";
	return "text";
}

/** True when the editor should mount CodeMirror for this row. */
export function isEditableEntry(entry: SkillFileEntry | undefined): boolean {
	return !!entry && entry.editable;
}

/** Markdown is the only language the editor has a grammar for (the app ships
 *  exactly one `@codemirror/lang-*` package); everything else is plain text. */
export function isMarkdownRel(rel: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(rel);
}

/** A new-file path is validated before it ever reaches the backend so the
 *  refusal is an inline `Field` error rather than a toast on a round trip.
 *  The backend re-checks; this is UX, not the security boundary. */
export function validateNewFileRel(raw: string): string | null {
	const rel = raw.trim();
	if (!rel) return "Enter a path inside the skill, e.g. references/notes.md";
	if (rel.includes("\\")) return "Use forward slashes.";
	if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel))
		return "Path must be relative to the skill folder.";
	if (rel.endsWith("/")) return "Path must name a file, not a folder.";
	const segments = rel.split("/");
	if (segments.some((s) => s === "" || s === "." || s === ".."))
		return "Path must stay inside the skill folder.";
	if (segments.length > 8) return "Path is nested too deeply.";
	return null;
}
