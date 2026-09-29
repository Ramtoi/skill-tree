import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SubagentEditor } from "@/screens/SubagentEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
	mockCommands,
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

function mockInvoke(overrides?: Partial<Record<string, unknown>>) {
	mockCommands({
		read_registry: sampleRegistry,
		harness_list: harnesses,
		subagent_show: showAgent,
		subagent_attachable_skills: [],
		subagent_skill_usage: {},
		...overrides,
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

describe("SubagentEditor details-attention (collapsed tab)", () => {
	it("has no attention signal in the valid (clean) state", async () => {
		const { container } = renderEditor();
		await screen.findByRole("button", { name: /Rename agent name: code-reviewer/i });
		const shell = container.querySelector(".doc-editor-shell");
		expect(shell?.getAttribute("data-details-attention")).toBeNull();
	});

	// The name field moved to the header (always visible, never collapsed), so
	// a raw client-invalid keystroke no longer needs the collapsed-tab dot —
	// InlineName surfaces it inline, in place. What DOES still live behind the
	// collapsed Details tab is the server rename-collision error (B2), which
	// `draft.errors` already folds into the same attention signal.
	it("raises an error-level attention signal when the save is rejected (e.g. name collision)", async () => {
		mockInvoke({
			subagent_save: {
				ok: false,
				warnings: [],
				errors: [
					{
						field: "name",
						level: "error",
						message: "cannot rename to 'code-reviewer': an agent with that name already exists",
						value: "code-reviewer",
					},
				],
			},
		});
		const { container } = renderEditor();
		// The header's name field falls back to the route name before the
		// draft's hydrate effect runs, so it is not a safe "loaded" signal —
		// wait on the description, which only the hydrated draft ever sets.
		const desc = await screen.findByDisplayValue("Reviews code.");
		await userEvent.type(desc, " x");
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));

		await waitFor(() =>
			expect(
				container
					.querySelector(".doc-editor-shell")
					?.getAttribute("data-details-attention"),
			).toBe("error"),
		);
	});
});
