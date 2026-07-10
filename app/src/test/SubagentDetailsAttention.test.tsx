import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { SubagentEditor } from "@/screens/SubagentEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// B4b-02: at narrow widths the SubagentEditor's Details side panel collapses to
// a vertical tab. A blocking state living in that panel (invalid name, drift,
// provision prompt) must surface on the collapsed tab. DocumentEditorShell drives
// the tab dot from `data-details-attention` on `.doc-editor-shell`; here we assert
// SubagentEditor computes + passes that signal from an invalid name.

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
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return harnesses;
			case "subagent_show":
				return showAgent;
			case "subagent_attachable_skills":
				return [];
			case "subagent_skill_usage":
				return {};
			default:
				return undefined;
		}
	}) as never);
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

describe("SubagentEditor details-attention (collapsed tab)", () => {
	it("has no attention signal in the valid (clean) state", async () => {
		const { container } = renderEditor();
		await screen.findByDisplayValue("code-reviewer");
		const shell = container.querySelector(".doc-editor-shell");
		expect(shell?.getAttribute("data-details-attention")).toBeNull();
	});

	it("raises an error-level attention signal when the name is invalid", async () => {
		const { container } = renderEditor();
		const nameInput = (await screen.findByDisplayValue(
			"code-reviewer",
		)) as HTMLInputElement;

		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "Bad Name!");

		await waitFor(() =>
			expect(
				container
					.querySelector(".doc-editor-shell")
					?.getAttribute("data-details-attention"),
			).toBe("error"),
		);

		// Correcting the name clears the signal.
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "good-name");
		await waitFor(() =>
			expect(
				container
					.querySelector(".doc-editor-shell")
					?.getAttribute("data-details-attention"),
			).toBeNull(),
		);
	});
});
