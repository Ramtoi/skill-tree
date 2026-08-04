import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Routes, Route } from "react-router-dom";

import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { SkillEditor } from "@/screens/SkillEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const projectAgents = {
	scope: "project",
	project: "example-app",
	agents_dir: "/Users/dev/example-app/.claude/agents",
	settings_path: "/Users/dev/example-app/.claude/settings.json",
	agents: [
		{
			name: "proj-reviewer",
			file: "proj-reviewer.md",
			relpath: "proj-reviewer.md",
			description: "Project reviewer.",
			model: "sonnet",
			tools_mode: "allowlist",
			tools: ["Read", "Glob", "Grep"],
			disallowed_tools: [],
			skills: [],
			color: "blue",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
		},
	],
	builtins: [],
};

const userAgents = {
	scope: "user",
	project: null,
	agents_dir: "/home/test/.claude/agents",
	settings_path: "/home/test/.claude/settings.json",
	agents: [
		{
			name: "user-helper",
			file: "user-helper.md",
			relpath: "user-helper.md",
			description: "User helper.",
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
		},
		{
			name: "already-has-it",
			file: "already-has-it.md",
			relpath: "already-has-it.md",
			description: "Already preloads brainstorm.",
			model: "",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: ["brainstorm"],
			color: "",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
		},
	],
	builtins: [],
};

const userAgentShow = {
	name: "user-helper",
	scope: "user",
	file: "user-helper.md",
	exists: true,
	safe: {
		name: "user-helper",
		description: "User helper.",
		model: "",
		tools_mode: "all",
		tools: [],
		disallowed_tools: [],
		allow_skill_discovery: true,
		skills: [],
		color: "",
	},
	advanced_yaml: "",
	body: "Help the user.",
	disabled: false,
	validation: { valid: true, warnings: [] },
};

/** brainstorm attachable in user scope; NOT attachable in project scope. */
function attachableFor(scope: string) {
	if (scope === "user") {
		return [
			{
				name: "brainstorm",
				description: "Brainstorm.",
				resolved: true,
				invocable: true,
				project_only: false,
				attachable: true,
				reason: "",
			},
		];
	}
	return [
		{
			name: "brainstorm",
			description: "Brainstorm.",
			resolved: false,
			invocable: true,
			project_only: false,
			attachable: false,
			reason: "does not resolve in this project scope",
		},
	];
}

function mock(impl?: (cmd: string, args?: unknown) => unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (impl) {
			const v = impl(cmd, args);
			if (v !== undefined) return v;
		}
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return [];
			case "subagent_list": {
				const a = args as { scope?: string };
				return a?.scope === "project" ? projectAgents : userAgents;
			}
			case "subagent_attachable_skills": {
				const a = args as { scope?: string };
				return attachableFor(a?.scope ?? "user");
			}
			case "subagent_skill_usage":
				return {};
			case "subagent_show":
				return userAgentShow;
			case "subagent_save":
				return { ok: true, name: "user-helper", file: "x", warnings: [], renamed_from: null };
			case "read_skill_document":
				return {
					name: "brainstorm",
					description: "Brainstorm a feature.",
					body: "# Brainstorm\nBody.",
				};
			case "path_exists":
				return false;
			case "project_scan_candidates":
				return [];
			default:
				return undefined;
		}
	}) as never);
}

beforeEach(() => {
	mock();
});

// ── 4.1 — Project Sub-Agents tab ─────────────────────────────────────────────

describe("Project Sub-Agents tab", () => {
	const RoutedProject = (
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>
	);

	it("lists the project's agents (scope=project) after switching to the tab", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedProject, {
			client,
			initialRoute: "/project/example-app",
		});
		// Switch from the default loadout view to the Sub-Agents tab.
		await userEvent.click(
			await screen.findByRole("tab", { name: /Sub-Agents/i }),
		);
		expect(await screen.findByText("proj-reviewer")).toBeInTheDocument();
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_list", {
				scope: "project",
				project: "example-app",
			}),
		);
	});

	it("hides the User/Project scope switcher in the project tab", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedProject, {
			client,
			initialRoute: "/project/example-app",
		});
		await userEvent.click(
			await screen.findByRole("tab", { name: /Sub-Agents/i }),
		);
		await screen.findByText("proj-reviewer");
		// The list scope switcher uses role=tab; project tab locks scope → none.
		expect(screen.queryByRole("tab", { name: /^User$/i })).toBeNull();
	});
});

// ── 4.2 / 4.3 — Skill side: preloaded-by + attach ────────────────────────────

describe("Skill 'Preloaded by' + attach", () => {
	const RoutedSkill = (
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
			<Route path="/project/:name" element={<div>project page</div>} />
			<Route path="/harness/:id" element={<div>harness page</div>} />
		</Routes>
	);

	it("reflects the reverse skill-usage index", async () => {
		mock((cmd) =>
			cmd === "subagent_skill_usage"
				? {
						brainstorm: [
							{ agent: "code-reviewer", scope: "user", project: null },
							{ agent: "proj-reviewer", scope: "project", project: "example-app" },
						],
					}
				: undefined,
		);
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedSkill, {
			client,
			initialRoute: "/skill/brainstorm",
		});
		// Section header with the count.
		expect(await screen.findByRole("heading", { name: /Preloaded by/i })).toBeInTheDocument();
		expect(await screen.findByText("code-reviewer")).toBeInTheDocument();
		expect(screen.getByText("proj-reviewer")).toBeInTheDocument();
	});

	it("shows 'Not preloaded by any sub-agent' when empty", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedSkill, {
			client,
			initialRoute: "/skill/brainstorm",
		});
		expect(
			await screen.findByText(/Not preloaded by any sub-agent/i),
		).toBeInTheDocument();
	});

	it("attach calls subagent_save with the skill added to safe.skills", async () => {
		const calls: unknown[] = [];
		mock((cmd, args) => {
			if (cmd === "subagent_save") {
				calls.push(args);
				return { ok: true, name: "user-helper", file: "x", warnings: [], renamed_from: null };
			}
			return undefined;
		});
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedSkill, {
			client,
			initialRoute: "/skill/brainstorm",
		});
		await screen.findByRole("heading", { name: /Preloaded by/i });
		await userEvent.click(
			screen.getByRole("button", { name: /Attach to sub-agent/i }),
		);
		// user-helper is attachable (brainstorm resolves in user scope).
		const opt = await screen.findByRole("button", { name: /user-helper/i });
		await userEvent.click(opt);
		await waitFor(() => expect(calls.length).toBe(1));
		const payload = (calls[0] as { payload: { safe: { skills: string[] } } })
			.payload;
		expect(payload.safe.skills).toContain("brainstorm");
	});

	it("disables a non-attachable agent in the picker (project scope)", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedSkill, {
			client,
			initialRoute: "/skill/brainstorm",
		});
		await screen.findByRole("heading", { name: /Preloaded by/i });
		await userEvent.click(
			screen.getByRole("button", { name: /Attach to sub-agent/i }),
		);
		// proj-reviewer lives in project scope where brainstorm is NOT attachable.
		const projOpt = await screen.findByRole("button", {
			name: /proj-reviewer/i,
		});
		expect(projOpt).toBeDisabled();
		expect(within(projOpt).getByText(/not attachable/i)).toBeInTheDocument();
		// user-helper (user scope, attachable) is enabled.
		const userOpt = screen.getByRole("button", { name: /user-helper/i });
		expect(userOpt).not.toBeDisabled();
	});

	it("marks an agent that already preloads the skill as attached", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedSkill, {
			client,
			initialRoute: "/skill/brainstorm",
		});
		await screen.findByRole("heading", { name: /Preloaded by/i });
		await userEvent.click(
			screen.getByRole("button", { name: /Attach to sub-agent/i }),
		);
		const opt = await screen.findByRole("button", { name: /already-has-it/i });
		expect(opt).toBeDisabled();
		expect(within(opt).getByText(/^attached$/i)).toBeInTheDocument();
	});
});
