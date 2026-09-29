import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";

import { PermissionsEditor } from "@/components/PermissionsEditor";
import { makeQueryClient } from "./helpers";
import type {
	Capabilities,
	NormalizedPermissions,
} from "@/types/permissions";

const EMPTY: NormalizedPermissions = {
	allow: [],
	deny: [],
	ask: [],
	hooks: [],
	sandbox_mode: null,
	approval_policy: null,
	project_trust: null,
	additional_dirs: [],
	extras: {},
	_unmanaged: [],
};

const CAPS_WITH_CODEX: Capabilities = {
	"claude-code": ["tool_allowlist", "hooks"],
	codex: ["tool_allowlist"],
};
const CAPS_NO_CODEX: Capabilities = {
	"claude-code": ["tool_allowlist", "hooks"],
};

function wire(caps: Capabilities, show: NormalizedPermissions = EMPTY) {
	const setPayloads: unknown[] = [];
	vi.mocked(invoke).mockImplementation(
		async (cmd: string, args?: unknown): Promise<unknown> => {
			switch (cmd) {
				case "permissions_show":
					return show;
				case "permissions_capabilities":
					return caps;
				case "permissions_risks_schema":
					return [];
				case "permissions_validate":
					return { ok: true, error: null };
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				case "permissions_set": {
					const a = args as { payload: NormalizedPermissions };
					setPayloads.push(a.payload);
					return { changed: true, normalized: a.payload };
				}
				default:
					return undefined;
			}
		},
	);
	return { setPayloads };
}

function renderProjectEditor() {
	const client = makeQueryClient();
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<PermissionsEditor
					scope={{ kind: "project", name: "alpha" }}
					projectCount={1}
					renderChrome={(chrome) => (
						<button
							type="button"
							data-testid="save"
							disabled={chrome.saveDisabled}
							onClick={chrome.save}
						>
							save
						</button>
					)}
				/>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

async function addRule(pattern: string) {
	fireEvent.click(await screen.findByRole("button", { name: "Add allow" }));
	const inputs = (await screen.findAllByLabelText(
		"Pattern",
	)) as HTMLInputElement[];
	const input = inputs[inputs.length - 1];
	fireEvent.change(input, { target: { value: pattern } });
}

describe("Codex-trust save-time confirm (F18)", () => {
	beforeEach(() => vi.mocked(invoke).mockReset());

	it("fires when saving a project draft with a translatable Bash rule + codex installed + trust ungranted", async () => {
		const { setPayloads } = wire(CAPS_WITH_CODEX);
		renderProjectEditor();
		await addRule("Bash(npm:*)");
		fireEvent.click(await screen.findByTestId("save"));
		// The confirm intercepts — the dialog appears and no write has happened yet.
		expect(
			await screen.findByText(/Grant Codex trust to this project\?/),
		).toBeInTheDocument();
		expect(setPayloads).toHaveLength(0);
		// Proceeding writes.
		fireEvent.click(screen.getByRole("button", { name: /Save & grant trust/ }));
		await waitFor(() => expect(setPayloads.length).toBeGreaterThan(0));
	});

	it("does NOT fire when codex is not installed", async () => {
		const { setPayloads } = wire(CAPS_NO_CODEX);
		renderProjectEditor();
		await addRule("Bash(npm:*)");
		fireEvent.click(await screen.findByTestId("save"));
		await waitFor(() => expect(setPayloads.length).toBeGreaterThan(0));
		expect(
			screen.queryByText(/Grant Codex trust to this project\?/),
		).toBeNull();
	});

	it("does NOT fire when the rule is not a translatable Bash rule", async () => {
		const { setPayloads } = wire(CAPS_WITH_CODEX);
		renderProjectEditor();
		await addRule("Read(src/**)");
		fireEvent.click(await screen.findByTestId("save"));
		await waitFor(() => expect(setPayloads.length).toBeGreaterThan(0));
		expect(
			screen.queryByText(/Grant Codex trust to this project\?/),
		).toBeNull();
	});

	it("does NOT fire when project trust is already granted", async () => {
		const { setPayloads } = wire(CAPS_WITH_CODEX, {
			...EMPTY,
			project_trust: true,
		});
		renderProjectEditor();
		await addRule("Bash(npm:*)");
		fireEvent.click(await screen.findByTestId("save"));
		await waitFor(() => expect(setPayloads.length).toBeGreaterThan(0));
		expect(
			screen.queryByText(/Grant Codex trust to this project\?/),
		).toBeNull();
	});
});
