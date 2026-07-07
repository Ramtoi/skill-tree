import type { AgentDocFolder } from "@/types/agentDocs";

export interface CompactAgentDocTreeNode {
	name: string;
	path: string;
	displayName: string;
	displayPath: string;
	fullPathTitle: string;
	dirs: CompactAgentDocTreeNode[];
	files: AgentDocFolder["files"];
}

function hasInstructionSet(node: AgentDocFolder): boolean {
	return node.files.some((file) => file.exists);
}

function toCompactNode(
	node: AgentDocFolder,
	inheritedName = "",
): CompactAgentDocTreeNode {
	let current = node;
	const names = [inheritedName || node.name].filter(Boolean);

	while (
		!hasInstructionSet(current) &&
		current.files.length === 0 &&
		current.dirs.length === 1
	) {
		current = current.dirs[0];
		names.push(current.name);
	}

	const displayName = names.join("/") || current.name;
	return {
		name: current.name,
		path: current.path,
		displayName,
		displayPath: current.path,
		fullPathTitle: current.path,
		files: current.files,
		dirs: current.dirs
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((child) => toCompactNode(child)),
	};
}

export function compactAgentDocTree(
	root: AgentDocFolder,
): CompactAgentDocTreeNode {
	return {
		name: root.name,
		path: root.path,
		displayName: root.name,
		displayPath: root.path,
		fullPathTitle: root.path,
		files: root.files,
		dirs: root.dirs
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((child) => toCompactNode(child)),
	};
}
