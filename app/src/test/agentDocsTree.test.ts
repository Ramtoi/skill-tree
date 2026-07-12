import { describe, expect, it } from "vitest";
import type {
	AgentDocFormatKind,
	AgentDocInstructionSet,
} from "@/types/agentDocs";
import { buildInstructionSetTree } from "@/lib/agentDocsTree";

function set(
	relativeDir: string,
	label: string,
	id = relativeDir || "root",
): AgentDocInstructionSet {
	const emptyFormat = (format: AgentDocFormatKind) => ({
		format,
		rel: `${relativeDir ? `${relativeDir}/` : ""}${format}.md`,
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
		formats: {
			CLAUDE: emptyFormat("CLAUDE"),
			AGENT: emptyFormat("AGENT"),
		},
		legacy: [],
		appendix: null,
		required_formats: [],
		warnings: [],
	};
}

describe("buildInstructionSetTree", () => {
	it("groups same-directory sets and sorts them by label", () => {
		const tree = buildInstructionSetTree([
			set("components", "Image", "components#image"),
			set("components", "Auth", "components#auth"),
		]);
		expect(tree.children).toHaveLength(1);
		const components = tree.children[0];
		expect(components.name).toBe("components");
		expect(components.fullPath).toBe("components");
		expect(components.sets.map((s) => s.label)).toEqual(["Auth", "Image"]);
	});

	it("places root-level sets on the root node", () => {
		const tree = buildInstructionSetTree([
			set("", "Project Instructions"),
			set("core/canvas", "Canvas AI Module"),
		]);
		expect(tree.sets.map((s) => s.label)).toEqual(["Project Instructions"]);
		expect(tree.children[0].name).toBe("core/canvas");
	});

	it("compacts single-child spines down to the branch point", () => {
		const tree = buildInstructionSetTree([
			set("app/src/main/java/com/foo/presentation/board", "AI Module"),
			set("app/src/main/java/com/foo/presentation/capture", "Capture"),
		]);
		// The deep spine collapses into one node leading to `presentation`
		// which then branches into board + capture.
		expect(tree.children).toHaveLength(1);
		const presentation = tree.children[0];
		expect(presentation.name).toBe(
			"app/src/main/java/com/foo/presentation",
		);
		expect(presentation.fullPath).toBe(
			"app/src/main/java/com/foo/presentation",
		);
		expect(presentation.children.map((c) => c.name)).toEqual([
			"board",
			"capture",
		]);
		expect(presentation.children[0].sets[0].label).toBe("AI Module");
	});

	it("does not collapse a folder that owns an instruction set", () => {
		const tree = buildInstructionSetTree([
			set("a", "A-self"),
			set("a/b", "B-leaf"),
		]);
		expect(tree.children).toHaveLength(1);
		const a = tree.children[0];
		expect(a.name).toBe("a");
		expect(a.sets.map((s) => s.label)).toEqual(["A-self"]);
		expect(a.children).toHaveLength(1);
		expect(a.children[0].name).toBe("b");
	});

	it("keeps siblings at the root unmerged", () => {
		const tree = buildInstructionSetTree([
			set("components", "C"),
			set("server", "S"),
		]);
		expect(tree.children.map((c) => c.name)).toEqual(["components", "server"]);
	});
});
