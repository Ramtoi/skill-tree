import type { AgentDocFile, AgentDocInstructionSet } from "@/types/agentDocs";
import { setRels, type AgentDocMapNode } from "@/lib/agentDocMap";
import { editableRelForSet, KNOWN_RELS } from "./agentDocHelpers";
import { FileRow, FolderRow, InstructionSetRow, UnifiedFileRow } from "./AgentDocRows";

export interface MapTreeProps {
	node: AgentDocMapNode;
	depth: number;
	/** When set, the root AGENTS.md + CLAUDE.md pair renders as one unified
	 *  row in this mode. Derived from the scanner verdict, never from raw
	 *  file flags. */
	unifyRootMode: "symlink" | "import" | null;
	selected: string;
	selectedSetId: string | null;
	dirtyRels: Set<string>;
	/** Directories holding a dirty descendant — precomputed, so a folder row
	 *  costs a Set lookup instead of an unbounded subtree walk per keystroke. */
	dirtyDirs: Set<string>;
	externalEditTarget: string | null;
	onSelectFile: (rel: string) => void;
	onSelectSet: (set: AgentDocInstructionSet) => void;
	toggleExpanded: (path: string, currentlyOpen: boolean) => void;
	/** Folders with no recorded choice start open in the instruction map (a
	 *  handful of sets) and closed while browsing (potentially thousands); a
	 *  filter opens the path to its matches. One helper, shared with the
	 *  metadata-resolution pass so the two cannot disagree about what is on
	 *  screen. */
	isNodeOpen: (path: string) => boolean;
	/** Null when no filter is active. */
	match: { rels: Set<string>; dirs: Set<string> } | null;
}

export function MapTree(props: MapTreeProps) {
	const {
		node,
		depth,
		unifyRootMode,
		selected,
		selectedSetId,
		dirtyRels,
		dirtyDirs,
		externalEditTarget,
		onSelectFile,
		onSelectSet,
		toggleExpanded,
		isNodeOpen,
		match,
	} = props;

	let files = node.files;
	let sets = node.sets;
	let children = node.children;
	if (match) {
		files = files.filter((f) => match.rels.has(f.rel));
		sets = sets.filter((s) => setRels(s).some((r) => match.rels.has(r)));
		children = children.filter((c) => match.dirs.has(c.path));
	}

	let unifiedItem: {
		files: AgentDocFile[];
		primary: AgentDocFile;
		mode: "symlink" | "import";
	} | null = null;

	if (depth === 0 && unifyRootMode) {
		const claude = files.find((f) => f.rel === "CLAUDE.md");
		const agent = files.find((f) => f.rel === "AGENTS.md");
		if (claude?.exists && agent?.exists) {
			unifiedItem = {
				files: [agent, claude],
				primary: agent,
				mode: unifyRootMode,
			};
			files = files.filter(
				(f) => f.rel !== "CLAUDE.md" && f.rel !== "AGENTS.md",
			);
		}
	}

	return (
		<>
			{sets.map((set) => {
				const editRel = editableRelForSet(set);
				return (
					<InstructionSetRow
						key={`s:${set.id}`}
						set={set}
						selected={selectedSetId === set.id}
						dirty={dirtyRels.has(editRel)}
						externallyChanged={externalEditTarget === editRel}
						onSelect={onSelectSet}
						depth={depth + 1}
						showPath={false}
					/>
				);
			})}
			{unifiedItem && (
				<UnifiedFileRow
					key={`u:${unifiedItem.primary.rel}`}
					files={unifiedItem.files}
					mode={unifiedItem.mode}
					primary={unifiedItem.primary}
					depth={depth + 1}
					selected={
						unifiedItem.primary.rel === selected ||
						unifiedItem.files.some((f) => f.rel === selected)
					}
					dirty={dirtyRels.has(unifiedItem.primary.rel)}
					externallyChanged={
						externalEditTarget === unifiedItem.primary.rel &&
						unifiedItem.primary.exists
					}
					onSelect={onSelectFile}
				/>
			)}
			{files.map((f) => (
				<FileRow
					key={`f:${f.rel}`}
					file={f}
					depth={depth + 1}
					selected={f.rel === selected}
					dirty={dirtyRels.has(f.rel)}
					externallyChanged={externalEditTarget === f.rel && f.exists}
					onSelect={onSelectFile}
				/>
			))}
			{children.map((child) => {
				// A filter reveals its matches wherever they live: a folder on a
				// match path opens unless the user explicitly closed it while
				// filtering, and that choice survives clearing the filter.
				const isOpen = isNodeOpen(child.path);
				const subIsKnown = KNOWN_RELS.some((k) =>
					k.startsWith(`${child.path}/`),
				);
				return (
					<div key={`d:${child.path}`}>
						<FolderRow
							name={child.name}
							path={child.path}
							depth={depth + 1}
							expanded={isOpen}
							onToggle={toggleExpanded}
							allMissing={!child.hasExistingFile}
							isKnown={subIsKnown}
							hasDescendantDirty={dirtyDirs.has(child.path)}
							hasContentHint={child.hasContentHint}
						/>
						{isOpen && (
							<MapTree
								{...props}
								node={child}
								depth={depth + 1}
							/>
						)}
					</div>
				);
			})}
		</>
	);
}
