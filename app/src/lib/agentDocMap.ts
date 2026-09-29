import type {
	AgentDocFile,
	AgentDocFolder,
	AgentDocInstructionSet,
} from "@/types/agentDocs";

/**
 * One tree for both browse modes.
 *
 * The map used to run two renderers over two structures — `InstructionSetTree`
 * over `AgentDocInstructionSet[]` in the default mode (directories and sets, no
 * file rows) and `FileTree` over the raw folder tree in all-Markdown mode. A
 * file the agent loads but whose basename is not an agent basename — an `@`
 * import target — had nowhere to render in the default map. The two structures
 * also disagreed about expansion keys and spine compaction, so the same
 * directory produced different keys per mode and a mode flip lost the tree
 * state. This builder produces the one node type both modes render.
 */
export interface AgentDocMapNode {
	/** Display segment. May contain slashes once a stub chain is compacted. */
	name: string;
	/**
	 * Expansion key: the directory path of the DEEPEST folder in a compacted
	 * chain, matching what both former renderers keyed on. One namespace, so an
	 * explicit expand/collapse survives a mode flip.
	 *
	 * It is not literally one key per directory in every case: compaction folds
	 * a chain only while a node has no files of its own, and browse mode adds
	 * files to directories the instruction map leaves empty. `docs/` holding a
	 * browse-only `README.md` and an imported `docs/agent/rules.md` is one
	 * `docs/agent` row by default and a `docs/` row with an `agent/` child while
	 * browsing. The LEAF keeps its key either way — what the flip does not carry
	 * is the intermediate row that only one mode has, and that row is new to the
	 * user in that mode anyway.
	 */
	path: string;
	/** Instruction sets whose `relative_dir` is this node's path. */
	sets: AgentDocInstructionSet[];
	/** File rows for this directory that no set in it already represents. */
	files: AgentDocFile[];
	children: AgentDocMapNode[];
	/** A file at or below this node exists on disk. */
	hasExistingFile: boolean;
	/** This directory holds a row whose size has not been resolved yet. */
	hasPendingMeta: boolean;
	/**
	 * Mode-aware folder hint: is there anything below worth expanding for in
	 * the mode currently displayed? Default mode counts instruction sets,
	 * agent-basename files, and import targets; all-Markdown counts any listed
	 * markdown file.
	 */
	hasContentHint: boolean;
}

/** Basenames the backend treats as agent-instruction files at any depth. */
export const AGENT_DOC_BASENAMES = new Set([
	"CLAUDE.md",
	"CLAUDE.local.md",
	"AGENTS.md",
	"AGENT.md",
]);

interface MutableNode {
	name: string;
	path: string;
	sets: AgentDocInstructionSet[];
	files: AgentDocFile[];
	children: Map<string, MutableNode>;
}

function makeNode(name: string, path: string): MutableNode {
	return { name, path, sets: [], files: [], children: new Map() };
}

function joinPath(parent: string, segment: string): string {
	return parent ? `${parent}/${segment}` : segment;
}

/** Every rel a set occupies, existing or not — the rows it stands in for. */
export function setRels(set: AgentDocInstructionSet): string[] {
	const out = [set.formats.CLAUDE.rel, set.formats.AGENT.rel];
	for (const l of set.legacy) out.push(l.rel);
	return out;
}

function ensureDir(root: MutableNode, dir: string): MutableNode {
	if (!dir) return root;
	let cursor = root;
	let acc = "";
	for (const seg of dir.split("/").filter(Boolean)) {
		acc = joinPath(acc, seg);
		let next = cursor.children.get(seg);
		if (!next) {
			next = makeNode(seg, acc);
			cursor.children.set(seg, next);
		}
		cursor = next;
	}
	return cursor;
}

function collectFolder(
	folder: AgentDocFolder,
	root: MutableNode,
	consumed: Set<string>,
	resolved?: Map<string, AgentDocFile>,
) {
	if (folder.files.length > 0) {
		const node = ensureDir(root, folder.path);
		for (const f of folder.files) {
			if (consumed.has(f.rel)) continue;
			const fill = resolved?.get(f.rel);
			node.files.push(
				fill ? { ...f, size: fill.size, modified_at: fill.modified_at } : f,
			);
		}
	}
	for (const d of folder.dirs) collectFolder(d, root, consumed, resolved);
}

/**
 * Fold a chain of pass-through directories — no files, no sets, exactly one
 * child — into a single row whose key is the deepest folder's path. An Android
 * `app/src/main/java/com/pkg/` package path is the textbook case.
 */
function compact(node: MutableNode, isRoot: boolean): MutableNode {
	for (const [key, child] of node.children) {
		node.children.set(key, compact(child, false));
	}
	if (isRoot) return node;
	while (
		node.files.length === 0 &&
		node.sets.length === 0 &&
		node.children.size === 1
	) {
		const only = [...node.children.values()][0];
		node.name = `${node.name}/${only.name}`;
		node.path = only.path;
		node.files = only.files;
		node.sets = only.sets;
		node.children = only.children;
	}
	return node;
}

const FILE_ORDER = ["AGENTS.md", "CLAUDE.md"];

function sortFiles(files: AgentDocFile[]): AgentDocFile[] {
	return [...files].sort((a, b) => {
		const ai = FILE_ORDER.indexOf(a.name);
		const bi = FILE_ORDER.indexOf(b.name);
		if (ai !== bi) {
			if (ai === -1) return 1;
			if (bi === -1) return -1;
			return ai - bi;
		}
		if (a.is_known !== b.is_known) return a.is_known ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

function freeze(node: MutableNode, allMarkdown: boolean): AgentDocMapNode {
	const children = [...node.children.values()]
		.map((c) => freeze(c, allMarkdown))
		.sort((a, b) => a.name.localeCompare(b.name));
	const files = sortFiles(node.files);
	const sets = [...node.sets].sort((a, b) => a.label.localeCompare(b.label));

	const hasExistingFile =
		files.some((f) => f.exists) ||
		sets.some((s) => s.formats.CLAUDE.exists || s.formats.AGENT.exists) ||
		children.some((c) => c.hasExistingFile);

	const ownHint = allMarkdown
		? files.length > 0
		: sets.length > 0 ||
			files.some(
				(f) => f.is_import || (f.exists && AGENT_DOC_BASENAMES.has(f.name)),
			);
	const hasContentHint = ownHint || children.some((c) => c.hasContentHint);
	const hasPendingMeta = files.some((f) => f.exists && f.size == null);

	return {
		name: node.name,
		path: node.path,
		sets,
		files,
		children,
		hasExistingFile,
		hasPendingMeta,
		hasContentHint,
	};
}

/**
 * Build the map tree. In the default mode a file already represented by an
 * instruction set in its own directory is dropped, so the root `CLAUDE.md` +
 * `AGENTS.md` pair renders as the set row rather than twice. In all-Markdown
 * mode `sets` is empty and every listed file gets a row.
 */
export function buildAgentDocMap(args: {
	root: AgentDocFolder;
	sets: AgentDocInstructionSet[];
	allMarkdown: boolean;
	/** Per-rel size/mtime resolved on demand for a displayed directory. */
	resolved?: Map<string, AgentDocFile>;
}): AgentDocMapNode {
	const { root: folder, sets, allMarkdown, resolved } = args;
	const consumed = new Set<string>();
	for (const s of sets) for (const rel of setRels(s)) consumed.add(rel);

	const root = makeNode("", "");
	for (const s of sets) ensureDir(root, s.relative_dir).sets.push(s);
	collectFolder(folder, root, consumed, resolved);
	compact(root, true);
	return freeze(root, allMarkdown);
}

/**
 * Directory paths that contain at least one of `rels`, including every
 * ancestor. Used for the per-folder dirty / filter-match roll-ups: a compacted
 * node's key is always a real ancestor directory of its descendants, so a
 * single `Set.has(node.path)` replaces the unbounded per-row subtree walks the
 * old renderer did on every render.
 */
export function ancestorDirs(rels: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const rel of rels) {
		const parts = rel.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? `${acc}/${parts[i]}` : parts[i];
			out.add(acc);
		}
		out.add("");
	}
	return out;
}
