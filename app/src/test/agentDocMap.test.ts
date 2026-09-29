import { describe, expect, it } from "vitest";
import type {
	AgentDocFile,
	AgentDocFolder,
	AgentDocFormatKind,
	AgentDocInstructionSet,
} from "@/types/agentDocs";
import {
	ancestorDirs,
	buildAgentDocMap,
	setRels,
	type AgentDocMapNode,
} from "@/lib/agentDocMap";

function set(
	relativeDir: string,
	label: string,
	id = relativeDir || "root",
): AgentDocInstructionSet {
	const emptyFormat = (format: AgentDocFormatKind) => ({
		format,
		rel: `${relativeDir ? `${relativeDir}/` : ""}${
			format === "CLAUDE" ? "CLAUDE.md" : "AGENTS.md"
		}`,
		exists: false,
		file: null,
		is_symlink: false,
		target_kind: "none" as const,
		required_by_harnesses: [],
		warnings: [],
		title: null,
	});
	return {
		id,
		relative_dir: relativeDir,
		display_path: relativeDir || "root",
		full_path_title: `/p/${relativeDir}`,
		label,
		label_source: "heading",
		verdict: "canonical",
		flags: [],
		formats: { CLAUDE: emptyFormat("CLAUDE"), AGENT: emptyFormat("AGENT") },
		legacy: [],
		appendix: null,
		required_formats: [],
		warnings: [],
	};
}

function file(rel: string, over: Partial<AgentDocFile> = {}): AgentDocFile {
	return {
		rel,
		name: rel.split("/").pop() ?? rel,
		label: rel,
		absolute_path: `/p/${rel}`,
		exists: true,
		is_known: false,
		is_discovered: true,
		is_symlink: false,
		symlink_to: null,
		symlink_target_in_project: false,
		can_read: true,
		can_write: true,
		size: 10,
		modified_at: 1,
		hash: "h",
		error: null,
		...over,
	};
}

/** Assemble a folder tree from flat rels, the way the backend ships one. */
function folders(rels: string[]): AgentDocFolder {
	const root: AgentDocFolder = { name: "", path: "", dirs: [], files: [] };
	for (const rel of rels) {
		const parts = rel.split("/");
		let cursor = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const path = parts.slice(0, i + 1).join("/");
			let next = cursor.dirs.find((d) => d.path === path);
			if (!next) {
				next = { name: parts[i], path, dirs: [], files: [] };
				cursor.dirs.push(next);
			}
			cursor = next;
		}
		cursor.files.push(file(rel));
	}
	return root;
}

const EMPTY: AgentDocFolder = { name: "", path: "", dirs: [], files: [] };

function child(node: AgentDocMapNode, name: string): AgentDocMapNode {
	const hit = node.children.find((c) => c.name === name);
	if (!hit) throw new Error(`no child ${name} in [${node.children.map((c) => c.name)}]`);
	return hit;
}

describe("buildAgentDocMap — instruction sets", () => {
	it("groups same-directory sets and sorts them by label", () => {
		const tree = buildAgentDocMap({
			root: EMPTY,
			sets: [
				set("components", "Image", "components#image"),
				set("components", "Auth", "components#auth"),
			],
			allMarkdown: false,
		});
		expect(tree.children).toHaveLength(1);
		const components = tree.children[0];
		expect(components.name).toBe("components");
		expect(components.path).toBe("components");
		expect(components.sets.map((s) => s.label)).toEqual(["Auth", "Image"]);
	});

	it("places root-level sets on the root node", () => {
		const tree = buildAgentDocMap({
			root: EMPTY,
			sets: [set("", "Project Instructions"), set("core/canvas", "Canvas")],
			allMarkdown: false,
		});
		expect(tree.sets.map((s) => s.label)).toEqual(["Project Instructions"]);
		expect(tree.children[0].name).toBe("core/canvas");
	});

	it("compacts single-child spines down to the branch point", () => {
		const tree = buildAgentDocMap({
			root: EMPTY,
			sets: [
				set("app/src/main/java/com/foo/presentation/board", "AI Module"),
				set("app/src/main/java/com/foo/presentation/capture", "Capture"),
			],
			allMarkdown: false,
		});
		expect(tree.children).toHaveLength(1);
		const presentation = tree.children[0];
		expect(presentation.name).toBe("app/src/main/java/com/foo/presentation");
		expect(presentation.path).toBe("app/src/main/java/com/foo/presentation");
		expect(presentation.children.map((c) => c.name)).toEqual([
			"board",
			"capture",
		]);
	});

	it("does not collapse a folder that owns an instruction set", () => {
		const tree = buildAgentDocMap({
			root: EMPTY,
			sets: [set("a", "A-self"), set("a/b", "B-leaf")],
			allMarkdown: false,
		});
		const a = tree.children[0];
		expect(a.name).toBe("a");
		expect(a.sets.map((s) => s.label)).toEqual(["A-self"]);
		expect(a.children.map((c) => c.name)).toEqual(["b"]);
	});
});

describe("buildAgentDocMap — one tree for sets and files", () => {
	it("renders a set and a plain file side by side in the default mode", () => {
		// The originating bug: an imported, non-agent-basename file had no
		// renderer in the default map at all.
		const tree = buildAgentDocMap({
			root: folders(["CLAUDE.md", "docs/agent/rules.md"]),
			sets: [set("", "Project Instructions")],
			allMarkdown: false,
		});
		expect(tree.sets.map((s) => s.label)).toEqual(["Project Instructions"]);
		// CLAUDE.md is represented BY the set, so it does not also get a row.
		expect(tree.files).toEqual([]);
		const docsAgent = child(tree, "docs/agent");
		expect(docsAgent.files.map((f) => f.rel)).toEqual(["docs/agent/rules.md"]);
	});

	it("does not collapse a directory whose only content is a file row", () => {
		const tree = buildAgentDocMap({
			root: folders(["a/b/note.md"]),
			sets: [],
			allMarkdown: true,
		});
		expect(tree.children.map((c) => c.name)).toEqual(["a/b"]);
	});

	it("keeps a missing known file visible when no set claims its directory", () => {
		const tree = buildAgentDocMap({
			root: folders([".claude/CLAUDE.md"]),
			sets: [set("", "Project Instructions")],
			allMarkdown: false,
		});
		expect(child(tree, ".claude").files.map((f) => f.rel)).toEqual([
			".claude/CLAUDE.md",
		]);
	});

	it("gives a directory ONE key in both modes", () => {
		const root = folders(["docs/agent/rules.md", "docs/agent/CLAUDE.md"]);
		const sets = [set("docs/agent", "Agent rules")];
		const def = buildAgentDocMap({ root, sets, allMarkdown: false });
		const all = buildAgentDocMap({ root, sets: [], allMarkdown: true });
		expect(child(def, "docs/agent").path).toBe("docs/agent");
		expect(child(all, "docs/agent").path).toBe("docs/agent");
	});
});

describe("buildAgentDocMap — folder content hint is mode-aware", () => {
	const root = folders(["docs/notes/plain.md"]);

	it("all-Markdown mode hints a folder of ordinary docs", () => {
		const tree = buildAgentDocMap({ root, sets: [], allMarkdown: true });
		expect(child(tree, "docs/notes").hasContentHint).toBe(true);
	});

	it("default mode does not hint a folder of ordinary docs", () => {
		const tree = buildAgentDocMap({ root, sets: [], allMarkdown: false });
		expect(child(tree, "docs/notes").hasContentHint).toBe(false);
	});

	it("default mode hints a folder holding an import target", () => {
		const withImport: AgentDocFolder = {
			name: "",
			path: "",
			files: [],
			dirs: [
				{
					name: "docs",
					path: "docs",
					dirs: [],
					files: [file("docs/rules.md", { is_import: true })],
				},
			],
		};
		const tree = buildAgentDocMap({
			root: withImport,
			sets: [],
			allMarkdown: false,
		});
		expect(child(tree, "docs").hasContentHint).toBe(true);
	});

	it("default mode hints a folder holding a nested agent doc", () => {
		const tree = buildAgentDocMap({
			root: folders(["core/canvas/CLAUDE.md"]),
			sets: [],
			allMarkdown: false,
		});
		expect(child(tree, "core/canvas").hasContentHint).toBe(true);
	});
});

describe("buildAgentDocMap — existence roll-up", () => {
	it("marks a folder of missing files as having nothing on disk", () => {
		const root: AgentDocFolder = {
			name: "",
			path: "",
			files: [],
			dirs: [
				{
					name: ".claude",
					path: ".claude",
					dirs: [],
					files: [file(".claude/CLAUDE.md", { exists: false })],
				},
			],
		};
		const tree = buildAgentDocMap({ root, sets: [], allMarkdown: false });
		expect(child(tree, ".claude").hasExistingFile).toBe(false);
	});

	it("counts a set's existing format as content on disk", () => {
		const s = set("nested", "Nested");
		s.formats.CLAUDE.exists = true;
		const tree = buildAgentDocMap({ root: EMPTY, sets: [s], allMarkdown: false });
		expect(child(tree, "nested").hasExistingFile).toBe(true);
	});
});

describe("setRels / ancestorDirs", () => {
	it("lists every row a set stands in for, existing or not", () => {
		const s = set("docs", "Docs");
		s.legacy = [file("docs/AGENT.md")];
		expect(setRels(s).sort()).toEqual(
			["docs/AGENT.md", "docs/AGENTS.md", "docs/CLAUDE.md"].sort(),
		);
	});

	it("returns every ancestor directory of each rel, plus the root", () => {
		expect([...ancestorDirs(["a/b/c.md"])].sort()).toEqual(["", "a", "a/b"]);
	});

	it("includes the root for a top-level file", () => {
		expect([...ancestorDirs(["CLAUDE.md"])]).toEqual([""]);
	});

	it("contains every compacted node's key so a Set lookup replaces a walk", () => {
		const tree = buildAgentDocMap({
			root: folders(["a/b/c/deep.md"]),
			sets: [],
			allMarkdown: true,
		});
		const dirs = ancestorDirs(["a/b/c/deep.md"]);
		expect(dirs.has(child(tree, "a/b/c").path)).toBe(true);
	});
});
