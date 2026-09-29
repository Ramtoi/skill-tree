import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	makeQueryClient,
	makeDeferred,
	primeRegistry,
	sampleRegistry,
} from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { Snippets } from "@/screens/Snippets";
import { HookEditor } from "@/screens/HookEditor";
import { SubagentEditor } from "@/screens/SubagentEditor";
import { SkillEditor } from "@/screens/SkillEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { GlobalPermissions } from "@/screens/GlobalPermissions";
import { useAppStore, type HarnessStatus } from "@/store";

/**
 * C4 — THE HEADER IS NOT PART OF THE PAYLOAD.
 *
 * Screens used to return a bare body while their query was in flight (or had
 * missed), so entering them painted content at y=0 for a frame and then dropped
 * everything 57px once the data landed. The chrome says "where am I" and "how
 * do I get out" — both are MORE useful while you are waiting, not less. These
 * tests pin the header into every one of those branches.
 */

/** Compose a per-command mock over setup.ts's default. */
function mockCommands(over: Record<string, (args?: unknown) => unknown>) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd in over) return Promise.resolve(over[cmd](args));
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

/** Make one command hang forever, so its pending branch stays observable. */
function hang(command: string) {
	const gate = makeDeferred();
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === command) return gate.promise;
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
	return gate;
}

beforeEach(() => {
	vi.mocked(invoke).mockClear();
});

describe("header presence in loading / not-found branches (C4)", () => {
	it("Library keeps its header while the registry is still loading", async () => {
		hang("read_registry");
		const { container } = renderWithProviders(<SkillLibrary />, {
			client: makeQueryClient(),
		});
		await screen.findByText("Loading library");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		// Same identity column + reserved crumb line as the loaded screen.
		expect(header!.querySelector('[data-testid="screen-header-glyph"]')).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-crumbs"]')).toBeTruthy();
		expect(header!.textContent).toContain("Library");
	});

	it("Library keeps its header when the registry read fails", async () => {
		mockCommands({
			read_registry: () => {
				throw new Error("registry.yaml is unreadable");
			},
		});
		const { container } = renderWithProviders(<SkillLibrary />, {
			client: makeQueryClient(),
		});
		await screen.findByText("Library unavailable");
		expect(container.querySelector('[data-testid="screen-header"]')).toBeTruthy();
		expect(
			container.querySelector('[data-testid="screen-header-glyph"]'),
		).toBeTruthy();
	});

	it("Snippets keeps its header while the library list is in flight", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		hang("hub_cmd");
		const { container } = renderWithProviders(<Snippets />, { client });
		await screen.findByText("Loading snippets");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.textContent).toContain("Snippets");
		expect(header!.querySelector('[data-testid="screen-header-crumbs"]')).toBeTruthy();
	});

	it("HookEditor keeps its header (and the way back) while the hook loads", async () => {
		hang("hook_show");
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/lsp-report", client: makeQueryClient() },
		);
		await waitFor(() =>
			expect(container.querySelector('[data-testid="screen-header"]')).toBeTruthy(),
		);
		const header = container.querySelector('[data-testid="screen-header"]')!;
		// The escape hatch is present BEFORE the payload — a pending screen is
		// exactly when a user is most likely to want out.
		expect(header.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header.textContent).toContain("lsp-report");
	});

	it("SubagentEditor keeps its header when the agent does not exist", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		mockCommands({
			read_registry: () => sampleRegistry,
			subagent_show: () => ({ exists: false }),
		});
		const { container } = renderWithProviders(
			<SubagentEditor
				scope="user"
				project={null}
				name="ghost-agent"
				onBack={vi.fn()}
			/>,
			{ client },
		);
		await screen.findByText("Sub-agent not found");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("ghost-agent");
	});
});

/**
 * The second wave (F1): the six branches that still returned a bare EmptyState
 * — or, worse, `null` / an inline-styled centring div — after the first pass.
 * Same technique: hang or fail the one command the branch waits on, then assert
 * `.main-header` is on screen *while* the branch's own text is.
 */
describe("header presence in the remaining headerless branches (C4)", () => {
	const CLAUDE: HarnessStatus = {
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		used_by_projects: [],
		global_doc: "/home/test/.claude/CLAUDE.md",
		global_doc_exists: true,
	};

	function renderSkillEditor(name: string, client = makeQueryClient()) {
		return renderWithProviders(
			<Routes>
				<Route path="/skill/:name" element={<SkillEditor />} />
			</Routes>,
			{ initialRoute: `/skill/${name}`, client },
		);
	}

	it("SkillEditor keeps its header when the registry read fails", async () => {
		mockCommands({
			read_registry: () => {
				throw new Error("registry.yaml is unreadable");
			},
		});
		const { container } = renderSkillEditor("brainstorm");
		await screen.findByText("Library unavailable");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-crumbs"]')).toBeTruthy();
		expect(header!.textContent).toContain("brainstorm");
	});

	it("SkillEditor keeps its header while the registry is in flight", async () => {
		hang("read_registry");
		const { container } = renderSkillEditor("brainstorm");
		await screen.findByText("Loading skill");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("brainstorm");
		// The old branch was an inline-styled centring div with no chrome and
		// no body class — the gutter came from nowhere.
		expect(container.querySelector(".main-body")).toBeTruthy();
	});

	it("SkillEditor keeps its header when the skill does not exist", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		mockCommands({ read_registry: () => sampleRegistry });
		const { container } = renderSkillEditor("ghost-skill", client);
		await screen.findByText("Skill not found");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("ghost-skill");
	});

	it("ProjectWorkspace keeps its header while the registry loads", async () => {
		hang("read_registry");
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ initialRoute: "/project/moon-base", client: makeQueryClient() },
		);
		await screen.findByText("Loading workspace");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		// Same identity variant as the loaded screen: the project dot.
		expect(header!.querySelector(".header-identity .project-dot")).toBeTruthy();
		expect(header!.textContent).toContain("moon-base");
		expect(header!.querySelector('[data-testid="screen-header-crumbs"]')).toBeTruthy();
	});

	it("Library bundle mode keeps its header (and the way back) for a missing bundle", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		mockCommands({ read_registry: () => sampleRegistry });
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/bundle/:name" element={<SkillLibrary />} />
			</Routes>,
			{ initialRoute: "/bundle/ghost-bundle", client },
		);
		await screen.findByText(/not found/);
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		// The happy path's `back` — a dead deep link used to offer only the
		// body button, and no crumb saying where "back" even was.
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("ghost-bundle");
	});

	it("HookEditor keeps its header when the hook does not exist", async () => {
		mockCommands({
			hook_show: () => {
				throw new Error("no such hook");
			},
		});
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/ghost-hook", client: makeQueryClient() },
		);
		await screen.findByText("Hook not found");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("ghost-hook");
	});

	it("HarnessDocEditor keeps its header while the doc read is in flight", async () => {
		useAppStore.setState({ harnesses: [CLAUDE], mutating: false });
		hang("global_doc_read");
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
			</Routes>,
			{ initialRoute: "/harness/claude-code/doc", client: makeQueryClient() },
		);
		// This branch used to `return null` — a blank main column, no chrome,
		// no way back, for the whole duration of a disk read.
		await screen.findByText("Loading instructions");
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(header!.querySelector('[data-testid="screen-header-back"]')).toBeTruthy();
		expect(header!.textContent).toContain("Claude Code");
	});

	it("GlobalPermissions keeps its chrome when the permissions read fails", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		mockCommands({
			read_registry: () => sampleRegistry,
			permissions_capabilities: () => ({ "claude-code": ["tool_allowlist"] }),
			permissions_show: () => {
				throw new Error("permissions.toml is unreadable");
			},
		});
		const { container } = renderWithProviders(<GlobalPermissions />, { client });
		await screen.findByText(/Failed to load permissions/);
		const header = container.querySelector('[data-testid="screen-header"]');
		expect(header).toBeTruthy();
		expect(
			header!.querySelector('[data-testid="screen-header-glyph"]'),
		).toBeTruthy();
		expect(header!.textContent).toContain("Permissions");
	});
});
