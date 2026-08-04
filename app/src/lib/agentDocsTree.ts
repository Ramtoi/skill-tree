import type { AgentDocInstructionSet } from "@/types/agentDocs";

export interface InstructionSetNode {
	// Display segment (after spine compaction this may contain slashes, e.g. "app/src/main/java")
	name: string;
	// Stable absolute path key for the `expanded` state Map.
	// Always equals the directory path under the project root with no leading/trailing slash.
	fullPath: string;
	// Sets whose `relative_dir` matches `fullPath` exactly.
	sets: AgentDocInstructionSet[];
	children: InstructionSetNode[];
}

interface MutableNode {
	name: string;
	fullPath: string;
	sets: AgentDocInstructionSet[];
	children: Map<string, MutableNode>;
}

function makeNode(name: string, fullPath: string): MutableNode {
	return { name, fullPath, sets: [], children: new Map() };
}

function joinPath(parent: string, segment: string): string {
	return parent ? `${parent}/${segment}` : segment;
}

function freeze(node: MutableNode): InstructionSetNode {
	const children = [...node.children.values()]
		.map(freeze)
		.sort((a, b) => a.name.localeCompare(b.name));
	const sets = [...node.sets].sort((a, b) => a.label.localeCompare(b.label));
	return { name: node.name, fullPath: node.fullPath, sets, children };
}

// Collapse single-child path spines so deep Java/Kotlin trees branch at meaningful folders.
// A node is folded into its only child while it has 0 sets and exactly 1 child.
// `keepRoot` prevents the synthetic root node from being absorbed into its lone child.
function compact(node: MutableNode, keepRoot: boolean): MutableNode {
	for (const [key, child] of node.children) {
		const folded = compact(child, false);
		node.children.set(key, folded);
	}
	if (keepRoot) return node;
	while (node.sets.length === 0 && node.children.size === 1) {
		const [onlyKey, only] = [...node.children.entries()][0];
		node.name = node.name ? `${node.name}/${only.name}` : only.name;
		node.fullPath = only.fullPath;
		node.sets = only.sets;
		node.children = only.children;
		void onlyKey;
	}
	return node;
}

/**
 * Build a directory tree of instruction sets from the flat list returned by the backend.
 *
 * The returned root represents the project itself (empty name/path) and may have its
 * own `sets` array for root-level instruction sets. Single-child folder spines are
 * collapsed so a path like `app/src/main/java/com/foo/presentation/board` becomes one
 * node when `presentation` is the first branch point.
 */
export function buildInstructionSetTree(
	sets: AgentDocInstructionSet[],
): InstructionSetNode {
	const root = makeNode("", "");
	for (const set of sets) {
		const dir = set.relative_dir ?? "";
		if (!dir) {
			root.sets.push(set);
			continue;
		}
		const segments = dir.split("/").filter(Boolean);
		let cursor = root;
		let acc = "";
		for (const seg of segments) {
			acc = joinPath(acc, seg);
			let next = cursor.children.get(seg);
			if (!next) {
				next = makeNode(seg, acc);
				cursor.children.set(seg, next);
			}
			cursor = next;
		}
		cursor.sets.push(set);
	}
	compact(root, true);
	return freeze(root);
}
