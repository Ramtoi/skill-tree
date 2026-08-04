import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Routes, Route, useParams } from "react-router-dom";

import { Harnesses } from "@/screens/Harnesses";
import { HarnessConfig } from "@/screens/HarnessConfig";
import { SubagentEditor } from "@/screens/SubagentEditor";
import { SkillPreloadedBy } from "@/components/subagents/SkillPreloadedBy";
import { subagentKeys } from "@/hooks/useSubagents";
import { useAppStore, type HarnessStatus } from "@/store";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeHarnesses(): HarnessStatus[] {
	return [
		{
			id: "claude-code",
			label: "Claude Code",
			installed: true,
			on_globally: true,
			used_by_projects: [],
			path: "/usr/bin/claude",
			version: "1.0",
			agents: {
				supported: true,
				format: "md",
				agents_dir: "~/.claude/agents",
				project_agents_dir: ".claude/agents",
			},
		},
		{
			id: "codex",
			label: "Codex",
			installed: true,
			on_globally: false,
			used_by_projects: ["example-app"],
			path: "/usr/bin/codex",
			version: "0.142.2",
			agents: {
				supported: true,
				format: "toml",
				agents_dir: "~/.codex/agents",
				project_agents_dir: ".codex/agents",
			},
		},
		{
			id: "pi",
			label: "Pi",
			installed: true,
			on_globally: false,
			used_by_projects: [],
			path: "/usr/bin/pi",
			version: "0.1",
			agents: {
				supported: false,
				format: null,
				agents_dir: null,
				project_agents_dir: null,
			},
		},
	];
}

const codexList = {
	harness: "codex",
	scope: "user",
	project: null,
	agents_dir: "/home/test/.codex/agents",
	settings_path: "",
	agents: [
		{
			name: "pr_explorer",
			file: "pr_explorer.toml",
			relpath: "pr_explorer.toml",
			description: "Read-only codebase explorer.",
			model: "gpt-5.3-codex-spark",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: ["brainstorm"],
			color: "",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
			sandbox_mode: "read-only",
			model_reasoning_effort: "medium",
			nickname_candidates: [],
		},
		{
			name: "release_captain",
			file: "release_captain.toml",
			relpath: "release_captain.toml",
			description: "Inherits the session sandbox.",
			model: "",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: [],
			color: "",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
			sandbox_mode: "",
			model_reasoning_effort: "",
			nickname_candidates: [],
		},
	],
	builtins: [
		{ name: "default", model: "inherit", description: "Default Codex agent.", disabled: false, builtin: true },
		{ name: "worker", model: "inherit", description: "Implementation worker.", disabled: false, builtin: true },
		{ name: "explorer", model: "inherit", description: "Exploration agent.", disabled: false, builtin: true },
	],
};

const codexShow = {
	name: "pr_explorer",
	scope: "user",
	harness: "codex",
	file: "/home/test/.codex/agents/pr_explorer.toml",
	exists: true,
	safe: {
		name: "pr_explorer",
		description: "Read-only codebase explorer.",
		model: "gpt-5.3-codex-spark",
		tools_mode: "all",
		tools: [],
		disallowed_tools: [],
		allow_skill_discovery: true,
		skills: ["brainstorm"],
		color: "",
		sandbox_mode: "read-only",
		model_reasoning_effort: "medium",
		nickname_candidates: [],
	},
	advanced_yaml: 'custom_key = "kept"\n',
	advanced_format: "toml",
	foreign_skill_entries: [
		{ path: "/somewhere/else/SKILL.md", enabled: false },
	],
	body: "Stay in exploration mode.",
	disabled: false,
	validation: { valid: true, warnings: [] },
};

function mockCodex(impl?: (cmd: string, args?: unknown) => unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (impl) {
			const v = impl(cmd, args);
			if (v !== undefined) return v;
		}
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return makeHarnesses();
			case "subagent_list":
				return codexList;
			case "subagent_show":
				return codexShow;
			case "subagent_attachable_skills":
				return [
					{
						name: "brainstorm",
						description: "Brainstorm with experts.",
						resolved: true,
						invocable: true,
						project_only: false,
						attachable: true,
						reason: "",
					},
				];
			case "subagent_skill_usage":
				return {};
			case "subagent_set_disabled":
				return { ok: true, disabled: (args as { disabled: boolean }).disabled };
			case "subagent_save":
				return { ok: true, name: "pr_explorer", file: "x", warnings: [], renamed_from: null };
			case "subagent_delete":
				return { ok: true };
			default:
				return undefined;
		}
	}) as never);
}

const RoutedHarness = (
	<Routes>
		<Route path="/harness/:id" element={<HarnessConfig />} />
	</Routes>
);

beforeEach(() => {
	mockCodex();
	useAppStore.setState({ harnesses: makeHarnesses(), mutating: false });
});

// ── Capability gating ──────────────────────────────────────────────────────────

describe("Capability-gated harness config", () => {
	it("shows Configure on the codex card but not on pi (agents.supported)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		const { container } = renderWithProviders(<Harnesses />, { client });
		const cards = Array.from(container.querySelectorAll(".harness-card"));
		const cardFor = (label: string) =>
			cards.find((c) => within(c as HTMLElement).queryByText(label)) as HTMLElement;
		await waitFor(() =>
			expect(
				within(cardFor("Codex")).getByRole("button", { name: /Configure/i }),
			).toBeInTheDocument(),
		);
		expect(
			within(cardFor("Pi")).queryByRole("button", { name: /Configure/i }),
		).toBeNull();
		// No configure affordance at all on the unsupported card.
		expect(cardFor("Pi").querySelector(".harness-card-configure")).toBeNull();
	});

	it("renders the Sub-Agents manager for codex at /harness/codex", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		expect(await screen.findByText("pr_explorer")).toBeInTheDocument();
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"subagent_list",
				expect.objectContaining({ scope: "user", harnessId: "codex" }),
			),
		);
	});

	it("shows the honest 'coming soon' empty state for a known non-supporting harness (pi)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/pi",
		});
		// F19: a known harness with no built config surface reads as "coming soon",
		// not a generic empty dead-end.
		expect(
			await screen.findByText(/Configuration coming soon/i),
		).toBeInTheDocument();
	});

	it("codex scope switcher disables the Project pill with the trust hint", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		await screen.findByText("pr_explorer");
		const projectTab = screen.getByRole("tab", { name: /Project/i });
		expect(projectTab).toBeDisabled();
		expect(
			screen.getByText(/Codex project agents ship later/i),
		).toBeInTheDocument();
	});
});

// ── Codex list ─────────────────────────────────────────────────────────────────

describe("Codex sub-agents list", () => {
	it("summarizes capability from sandbox_mode instead of tool access", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		const card = (await screen.findByText("pr_explorer")).closest(
			".subagent-card",
		) as HTMLElement;
		expect(within(card).getByText("read-only")).toBeInTheDocument();
		const inheritCard = screen
			.getByText("release_captain")
			.closest(".subagent-card") as HTMLElement;
		expect(
			within(inheritCard).getByText("Inherit sandbox"),
		).toBeInTheDocument();
		// The Claude tool-access summary never renders for codex.
		expect(screen.queryByText("All tools")).toBeNull();
	});

	it("codex built-ins have NO disable toggle, only a read-only hint", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		await screen.findByText("pr_explorer");
		const row = screen
			.getByText("default")
			.closest(".subagent-builtin-row") as HTMLElement;
		expect(within(row).queryByRole("checkbox")).toBeNull();
		expect(within(row).getByText(/read-only/i)).toBeInTheDocument();
	});

	it("disable toggle targets codex (harnessId) and invalidates the codex key", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		const card = (await screen.findByText("pr_explorer")).closest(
			".subagent-card",
		) as HTMLElement;
		const spy = vi.spyOn(client, "invalidateQueries");
		await userEvent.click(within(card).getByRole("checkbox"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_set_disabled", {
				scope: "user",
				name: "pr_explorer",
				disabled: true,
				project: null,
				harnessId: "codex",
			}),
		);
		// The refetch hits the CODEX list key, not the claude one.
		await waitFor(() =>
			expect(spy).toHaveBeenCalledWith(
				expect.objectContaining({
					queryKey: ["subagents", "codex", "user", null],
				}),
			),
		);
	});
});

// ── Codex editor ───────────────────────────────────────────────────────────────

function renderCodexEditor(client = makeQueryClient()) {
	primeRegistry(client);
	return renderWithProviders(
		<SubagentEditor
			harness="codex"
			scope="user"
			project={null}
			name="pr_explorer"
			onBack={vi.fn()}
		/>,
		{ client },
	);
}

describe("Codex sub-agent editor", () => {
	it("renders codex controls and hides Claude-only sections", async () => {
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		// Sandbox radio replaces tool access; no color swatches for codex.
		expect(screen.getByText(/Capability \(sandbox mode\)/i)).toBeInTheDocument();
		expect(screen.queryByText("Tool access")).toBeNull();
		expect(screen.queryByText("Appearance")).toBeNull();
		// Free-text model input carries the inherit placeholder.
		expect(
			screen.getByPlaceholderText(/inherit from session \(e\.g\. gpt-5\.3-codex\)/i),
		).toHaveValue("gpt-5.3-codex-spark");
		// Reasoning-effort select hydrated from the safe block.
		expect(screen.getByDisplayValue("medium")).toBeInTheDocument();
	});

	it("labels the advanced panel as raw TOML (advanced_format)", async () => {
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		expect(
			screen.getByRole("button", { name: /Advanced \(raw TOML\)/i }),
		).toBeInTheDocument();
		expect(screen.queryByText(/Advanced \(raw YAML\)/i)).toBeNull();
	});

	it("sandbox radio round-trips into the save payload with harness codex", async () => {
		const calls: unknown[] = [];
		mockCodex((cmd, args) => {
			if (cmd === "subagent_save") {
				calls.push(args);
				return { ok: true, name: "pr_explorer", file: "x", warnings: [], renamed_from: null };
			}
			return undefined;
		});
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		expect(screen.getByRole("radio", { name: /^Read-only$/i })).toBeChecked();
		await userEvent.click(
			screen.getByRole("radio", { name: /Workspace write/i }),
		);
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		await waitFor(() => expect(calls.length).toBe(1));
		const payload = (
			calls[0] as {
				payload: {
					harness?: string;
					safe: { sandbox_mode?: string; model_reasoning_effort?: string };
				};
			}
		).payload;
		expect(payload.harness).toBe("codex");
		expect(payload.safe.sandbox_mode).toBe("workspace-write");
		expect(payload.safe.model_reasoning_effort).toBe("medium");
	});

	it("styles danger-full-access as the loud option", async () => {
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		const danger = screen
			.getByRole("radio", { name: /Full access \(danger\)/i })
			.closest(".subagent-radio") as HTMLElement;
		expect(danger).toHaveAttribute("data-danger");
	});

	it("allows underscores in codex names (no client-side block)", async () => {
		const calls: unknown[] = [];
		mockCodex((cmd, args) => {
			if (cmd === "subagent_save") {
				calls.push(args);
				return { ok: true, name: "pr_probe_2", file: "x", warnings: [], renamed_from: "pr_explorer" };
			}
			return undefined;
		});
		renderCodexEditor();
		const nameInput = (await screen.findByDisplayValue(
			"pr_explorer",
		)) as HTMLInputElement;
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "pr_probe_2");
		expect(screen.queryByRole("alert")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		await waitFor(() => expect(calls.length).toBe(1));
		const payload = (calls[0] as { payload: { safe: { name: string } } }).payload;
		expect(payload.safe.name).toBe("pr_probe_2");
	});

	it("renders foreign skills.config entries read-only", async () => {
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		expect(screen.getByText("Other skill entries")).toBeInTheDocument();
		const row = screen
			.getByText("/somewhere/else/SKILL.md")
			.closest(".subagent-skill-row") as HTMLElement;
		expect(within(row).getByText("disabled")).toBeInTheDocument();
		// Read-only: no checkbox in the foreign-entry row.
		expect(within(row).queryByRole("checkbox")).toBeNull();
		expect(
			screen.getByText(/preserved on save but not editable here/i),
		).toBeInTheDocument();
	});

	it("shows the codex restart hint", async () => {
		renderCodexEditor();
		await screen.findByDisplayValue("pr_explorer");
		expect(
			screen.getByText(/Codex picks up agent file changes on the next session/i),
		).toBeInTheDocument();
	});
});

// ── New-agent sheet (codex context) ────────────────────────────────────────────

describe("New codex sub-agent sheet", () => {
	it("hides the read-only preset and creates with harness codex", async () => {
		const calls: unknown[] = [];
		mockCodex((cmd, args) => {
			if (cmd === "subagent_save") {
				calls.push(args);
				return { ok: true, name: "triager", file: "x", warnings: [], renamed_from: null };
			}
			return undefined;
		});
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/codex",
		});
		await screen.findByText("pr_explorer");
		await userEvent.click(
			screen.getByRole("button", { name: /New sub-agent/i }),
		);
		// The read-only preset is claude-tools-specific → hidden for codex.
		expect(screen.queryByText(/Read-only reviewer/i)).toBeNull();
		await userEvent.type(screen.getByPlaceholderText("code-reviewer"), "triager");
		await userEvent.type(
			screen.getByPlaceholderText(/When this agent should be used/i),
			"Triage PRs.",
		);
		await userEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await waitFor(() => expect(calls.length).toBe(1));
		const payload = (
			calls[0] as { payload: { harness?: string; scope: string } }
		).payload;
		expect(payload.harness).toBe("codex");
		expect(payload.scope).toBe("user");
	});
});

// ── SkillPreloadedBy (harness badge + route) ───────────────────────────────────

function EchoHarness() {
	const { id } = useParams<{ id: string }>();
	return <div>harness page: {id}</div>;
}

describe("SkillPreloadedBy across harnesses", () => {
	it("badges entries by harness and routes to /harness/<id>", async () => {
		mockCodex((cmd) =>
			cmd === "subagent_skill_usage"
				? {
						brainstorm: [
							{ agent: "code-reviewer", scope: "user", project: null, harness: "claude-code" },
							{ agent: "pr_explorer", scope: "user", project: null, harness: "codex" },
						],
					}
				: undefined,
		);
		const client = makeQueryClient();
		primeRegistry(client);
		const { container } = renderWithProviders(
			<Routes>
				<Route
					path="/skill/:name"
					element={<SkillPreloadedBy skillName="brainstorm" />}
				/>
				<Route path="/harness/:id" element={<EchoHarness />} />
			</Routes>,
			{ client, initialRoute: "/skill/brainstorm" },
		);
		const codexRow = (await screen.findByText("pr_explorer")).closest(
			".skill-preload-row",
		) as HTMLElement;
		// Harness glyph badge on the row.
		expect(
			codexRow.querySelector('.harness-glyph[data-harness="codex"]'),
		).not.toBeNull();
		const claudeRow = screen
			.getByText("code-reviewer")
			.closest(".skill-preload-row") as HTMLElement;
		expect(
			claudeRow.querySelector('.harness-glyph[data-harness="claude-code"]'),
		).not.toBeNull();
		expect(container.querySelectorAll(".harness-glyph").length).toBeGreaterThanOrEqual(2);
		// Clicking the codex entry routes to ITS harness page (was hardcoded
		// /harness/claude-code before Wave 3).
		await userEvent.click(codexRow);
		expect(await screen.findByText("harness page: codex")).toBeInTheDocument();
	});

	it("defaults harness-less (legacy) entries to claude-code", async () => {
		mockCodex((cmd) =>
			cmd === "subagent_skill_usage"
				? {
						brainstorm: [{ agent: "old-agent", scope: "user", project: null }],
					}
				: undefined,
		);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(
			<Routes>
				<Route
					path="/skill/:name"
					element={<SkillPreloadedBy skillName="brainstorm" />}
				/>
				<Route path="/harness/:id" element={<EchoHarness />} />
			</Routes>,
			{ client, initialRoute: "/skill/brainstorm" },
		);
		const row = (await screen.findByText("old-agent")).closest(
			".skill-preload-row",
		) as HTMLElement;
		await userEvent.click(row);
		expect(
			await screen.findByText("harness page: claude-code"),
		).toBeInTheDocument();
	});
});

// ── Query keys carry the harness dimension ─────────────────────────────────────

describe("subagentKeys harness dimension", () => {
	it("defaults to claude-code and separates codex", () => {
		expect(subagentKeys.list("user", null)).toEqual([
			"subagents",
			"claude-code",
			"user",
			null,
		]);
		expect(subagentKeys.list("user", null, "codex")).toEqual([
			"subagents",
			"codex",
			"user",
			null,
		]);
		expect(subagentKeys.one("user", null, "a")).toEqual([
			"subagent",
			"claude-code",
			"user",
			null,
			"a",
		]);
		expect(subagentKeys.one("user", null, "a", "codex")).toEqual([
			"subagent",
			"codex",
			"user",
			null,
			"a",
		]);
		expect(subagentKeys.attachable("user", null, "codex")).toEqual([
			"subagent-attachable",
			"codex",
			"user",
			null,
		]);
	});
});
