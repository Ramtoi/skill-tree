import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";

import { SubagentEditor } from "@/screens/SubagentEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
	mockCommands,
} from "./helpers";

// The sub-agent editor used to carry a hand-rolled five-button copy of the
// markdown toolbar on its own strip, with a "system prompt" caption at the
// strip's right. It now mounts the shared `MarkdownToolbar` (full verb set)
// through the shell's `toolbar` slot and says "system prompt" from the footer.

const harnesses = [
	{
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		agents: { supported: true },
	},
];

const showAgent = {
	name: "code-reviewer",
	scope: "user",
	file: "code-reviewer.md",
	exists: true,
	safe: {
		name: "code-reviewer",
		description: "Reviews code.",
		model: "sonnet",
		tools_mode: "allowlist",
		tools: ["Read", "Glob", "Grep", "Skill"],
		disallowed_tools: [],
		allow_skill_discovery: true,
		skills: [],
		color: "blue",
	},
	advanced_yaml: "",
	body: "You review code.",
	disabled: false,
	drift: [],
	link: null,
	validation: { valid: true, warnings: [] },
};

function mockInvoke() {
	mockCommands({
		read_registry: sampleRegistry,
		harness_list: harnesses,
		subagent_show: showAgent,
		subagent_attachable_skills: [],
		subagent_skill_usage: {},
	});
}

function renderEditor() {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<SubagentEditor
			scope="user"
			project={null}
			name="code-reviewer"
			onBack={vi.fn()}
		/>,
		{ client },
	);
}

beforeEach(() => {
	mockInvoke();
});

describe("SubagentEditor toolbar", () => {
	beforeEach(() => mockInvoke());

	it("mounts the shared markdown toolbar on the editor bar", async () => {
		const { container } = renderEditor();
		await screen.findByTitle("Bold");
		// The full shared verb set, not the old five-button subset.
		expect(screen.getByTitle("Numbered list")).toBeInTheDocument();
		expect(screen.getByTitle("Link")).toBeInTheDocument();
		const group = screen.getByRole("group", { name: "Markdown formatting" });
		expect(container.querySelector(".doc-editor-bar-left")!.contains(group)).toBe(true);
	});

	it("names the document from the footer, not a toolbar strip", async () => {
		const { container } = renderEditor();
		await screen.findByTitle("Bold");
		const caption = screen.getByText("system prompt");
		expect(container.querySelector(".doc-editor-foot")!.contains(caption)).toBe(true);
	});
});
