import { it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "./helpers";
import { ApplyToDialog } from "@/components/snippets/ApplyToDialog";
import type { AgentDocFile, AgentDocsListing } from "@/types/agentDocs";
import type { Registry } from "@/types";
import type { SnippetLocation } from "@/types/snippets";

// `ApplyToDialog` (props `snippetName, locations, onClose, onApply, busy`) has
// no test that opens it today.

const REGISTRY: Registry = {
	version: "1",
	hub_path: "~/skill-hub",
	bootstrap: { completed_at: "2026-05-20T18:33:00Z", version: 1 },
	skills: {},
	projects: { "test-project": { path: "/path/to/test-project", bundles: [], enabled: [] } },
	bundles: {},
	sources: {},
	permissions_global: {
		allow: [],
		deny: [],
		ask: [],
		hooks: [],
		sandbox_mode: "workspace-write",
		approval_policy: "on-failure",
		additional_dirs: [],
		_unmanaged: [],
	},
};

function agentDocFile(rel: string, name: string, overrides: Partial<AgentDocFile> = {}): AgentDocFile {
	return {
		rel,
		name,
		label: rel,
		absolute_path: `/path/to/test-project/${rel}`,
		exists: true,
		is_known: true,
		is_discovered: false,
		is_symlink: false,
		symlink_to: null,
		symlink_target_in_project: false,
		can_read: true,
		can_write: true,
		size: 100,
		modified_at: null,
		hash: null,
		error: null,
		...overrides,
	};
}

const LISTING: AgentDocsListing = {
	project_path: "/path/to/test-project",
	root: {
		name: "",
		path: "",
		dirs: [{ name: "docs", path: "docs", dirs: [], files: [agentDocFile("docs/AGENT.md", "AGENT.md")] }],
		files: [agentDocFile("AGENTS.md", "AGENTS.md"), agentDocFile("CLAUDE.md", "CLAUDE.md")],
	},
	instruction_sets: [],
	required_formats: [],
	policy: { requires_claude: false, requires_agent: true, strategy: "symlink", canonical: "AGENTS.md", derived: null },
	all_rels: ["AGENTS.md", "CLAUDE.md", "docs/AGENT.md"],
	instruction_rels: ["AGENTS.md"],
	external_imports: [],
	ignored_count: 0,
	include_ignored: false,
};

function installMocks() {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return REGISTRY;
		if (cmd === "list_agent_docs") {
			void args;
			return LISTING;
		}
		return undefined;
	}) as never);
}

function applyLocation(rel: string, overrides: Partial<SnippetLocation> = {}): SnippetLocation {
	return {
		project: "test-project",
		rel,
		path: `/path/to/test-project/${rel}`,
		snippet: "my-snippet",
		version: "1",
		applied_sha: "abc123",
		status: "applied",
		...overrides,
	} as SnippetLocation;
}

it("lists the locations: an already-applied target is marked and disabled", async () => {
	installMocks();
	renderWithProviders(
		<ApplyToDialog
			snippetName="my-snippet"
			locations={[applyLocation("AGENTS.md")]}
			onClose={() => {}}
			onApply={() => {}}
		/>,
	);

	// Wait for the listing fetch to resolve — a nested-only row proves it, since
	// the two `KNOWN_ROOTS` rows render on the very first paint regardless.
	await screen.findByText("docs/AGENT.md");

	const agentsRow = screen.getByText("AGENTS.md").closest("label")!;
	expect(within(agentsRow).getByText("already applied here")).toBeVisible();
	expect(within(agentsRow).getByRole("radio")).toBeDisabled();

	// CLAUDE.md isn't applied, so it becomes the canonical pick instead.
	const claudeRow = screen.getByText("CLAUDE.md").closest("label")!;
	expect(within(claudeRow).getByText("canonical root")).toBeVisible();
	expect(within(claudeRow).getByRole("radio")).not.toBeDisabled();
});

it("a pick calls onApply(project, rel) with the chosen pair", async () => {
	installMocks();
	const onApply = vi.fn();
	renderWithProviders(
		<ApplyToDialog snippetName="my-snippet" locations={[]} onClose={() => {}} onApply={onApply} />,
	);

	const pickRow = (await screen.findByText("docs/AGENT.md")).closest("label")!;
	fireEvent.click(within(pickRow).getByRole("radio"));

	fireEvent.click(screen.getByRole("button", { name: /Apply to docs\/AGENT\.md/ }));
	expect(onApply).toHaveBeenCalledWith("test-project", "docs/AGENT.md");
});

it("busy disables the apply action and shows the applying label", async () => {
	installMocks();
	const onApply = vi.fn();
	renderWithProviders(
		<ApplyToDialog snippetName="my-snippet" locations={[]} onClose={() => {}} onApply={onApply} busy />,
	);

	await screen.findByText("CLAUDE.md");
	const applyButton = screen.getByRole("button", { name: "Applying…" });
	expect(applyButton).toBeDisabled();

	fireEvent.click(applyButton);
	expect(onApply).not.toHaveBeenCalled();
});

it("has role=dialog with aria-modal, and its close control (Cancel, and the backdrop) call onClose", async () => {
	installMocks();
	const onClose = vi.fn();
	renderWithProviders(
		<ApplyToDialog snippetName="my-snippet" locations={[]} onClose={onClose} onApply={() => {}} />,
	);

	const dialog = await screen.findByRole("dialog", { name: "Apply my-snippet" });
	expect(dialog).toHaveAttribute("aria-modal", "true");

	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(onClose).toHaveBeenCalledTimes(1);

	// Clicking the backdrop (outside the dialog box) also closes it — the
	// dialog itself stops the click from reaching the backdrop (`stopEvent`),
	// which is why `dialog` above never triggers this.
	fireEvent.click(dialog.parentElement!);
	expect(onClose).toHaveBeenCalledTimes(2);
});
