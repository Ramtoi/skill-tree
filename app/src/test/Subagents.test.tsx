import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Routes, Route } from "react-router-dom";

import { HarnessConfig } from "@/screens/HarnessConfig";
import { SubagentEditor } from "@/screens/SubagentEditor";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const userList = {
	scope: "user",
	project: null,
	agents_dir: "/home/test/.claude/agents",
	settings_path: "/home/test/.claude/settings.json",
	agents: [
		{
			name: "code-reviewer",
			file: "code-reviewer.md",
			relpath: "code-reviewer.md",
			description: "Reviews code for bugs.",
			model: "sonnet",
			tools_mode: "allowlist",
			tools: ["Read", "Glob", "Grep"],
			disallowed_tools: [],
			skills: ["brainstorm"],
			color: "blue",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
		},
		{
			name: "broken-agent",
			file: "broken-agent.md",
			relpath: "broken-agent.md",
			description: "Has a warning.",
			model: "",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: [],
			color: "",
			disabled: true,
			builtin: false,
			valid: true,
			// warn-level only → dot should render (warn tone)
			warnings: [{ field: "skills", level: "warn", message: "unresolved skill" }],
		},
		{
			name: "info-only-agent",
			file: "info.md",
			relpath: "info.md",
			description: "Info only.",
			model: "",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: [],
			color: "",
			disabled: false,
			builtin: false,
			valid: true,
			// `info` level should NOT trigger the validity dot
			warnings: [{ field: "model", level: "info", message: "inherits" }],
		},
	],
	builtins: [
		{
			name: "Explore",
			model: "haiku",
			description: "Read-only search agent.",
			disabled: false,
			builtin: true,
		},
	],
};

const projectList = {
	...userList,
	scope: "project",
	project: "example-app",
	agents: [
		{
			...userList.agents[0],
			name: "proj-agent",
			description: "Project-scoped agent.",
		},
	],
	builtins: [],
};

const harnesses = [
	{
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		used_by_projects: [],
		version: "1.0",
		path: "/usr/bin/claude",
	},
];

function mockSubagents(impl?: (cmd: string, args?: unknown) => unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (impl) {
			const v = impl(cmd, args);
			if (v !== undefined) return v;
		}
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return harnesses;
			case "subagent_list": {
				const a = args as { scope?: string };
				return a?.scope === "project" ? projectList : userList;
			}
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
					{
						name: "no-invoke-skill",
						description: "Cannot be preloaded.",
						resolved: true,
						invocable: false,
						project_only: false,
						attachable: false,
						reason: "disable-model-invocation is set",
					},
				];
			case "subagent_skill_usage":
				return {};
			case "subagent_set_disabled":
				return { ok: true, disabled: (args as { disabled: boolean }).disabled };
			case "subagent_save":
				return { ok: true, name: "code-reviewer", file: "x", warnings: [], renamed_from: null };
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
	mockSubagents();
});

// ── List ───────────────────────────────────────────────────────────────────────

describe("Sub-agents list", () => {
	it("renders file-based agents and the built-ins strip", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/claude-code",
		});
		expect(await screen.findByText("code-reviewer")).toBeInTheDocument();
		expect(screen.getByText("Read-only")).toBeInTheDocument();
		// built-in strip
		expect(screen.getByText("Explore")).toBeInTheDocument();
		expect(screen.getByText(/Built-in agents/i)).toBeInTheDocument();
	});

	it("the validity dot reflects warn/error but NOT info-level warnings", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		const { container } = renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/claude-code",
		});
		await screen.findByText("code-reviewer");
		// broken-agent has a warn → exactly one warn dot; info-only-agent has none.
		const dots = container.querySelectorAll(".subagent-validity-dot");
		expect(dots.length).toBe(1);
		expect(dots[0].getAttribute("data-tone")).toBe("warn");
	});

	it("switches to project scope and lists project agents", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/claude-code",
		});
		await screen.findByText("code-reviewer");
		await userEvent.click(screen.getByRole("tab", { name: /Project/i }));
		expect(await screen.findByText("proj-agent")).toBeInTheDocument();
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_list", {
				scope: "project",
				project: "example-app",
			}),
		);
	});

	it("disable toggle invokes subagent_set_disabled with correct args", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/claude-code",
		});
		const card = (await screen.findByText("code-reviewer")).closest(
			".subagent-card",
		) as HTMLElement;
		// The switch is "checked = !disabled"; unchecking it disables the agent.
		const cb = within(card).getByRole("checkbox");
		await userEvent.click(cb);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_set_disabled", {
				scope: "user",
				name: "code-reviewer",
				disabled: true,
				project: null,
			}),
		);
	});

	it("built-in disable toggle targets the built-in by name", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(RoutedHarness, {
			client,
			initialRoute: "/harness/claude-code",
		});
		const row = (await screen.findByText("Explore")).closest(
			".subagent-builtin-row",
		) as HTMLElement;
		await userEvent.click(within(row).getByRole("checkbox"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_set_disabled", {
				scope: "user",
				name: "Explore",
				disabled: true,
				project: null,
			}),
		);
	});
});

// ── Editor ───────────────────────────────────────────────────────────────────

const showCodeReviewer = {
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
		skills: ["brainstorm"],
		color: "blue",
	},
	advanced_yaml: "hooks:\n  PreToolUse: echo hi\n",
	body: "You review code.",
	disabled: false,
	validation: { valid: true, warnings: [] },
};

function renderEditor(client = makeQueryClient(), onRenamed = vi.fn()) {
	primeRegistry(client);
	return {
		onRenamed,
		...renderWithProviders(
			<SubagentEditor
				scope="user"
				project={null}
				name="code-reviewer"
				onBack={vi.fn()}
				onRenamed={onRenamed}
			/>,
			{ client },
		),
	};
}

describe("Sub-agent editor", () => {
	it("blocks save on an invalid name without invoking subagent_save", async () => {
		mockSubagents((cmd) => (cmd === "subagent_show" ? showCodeReviewer : undefined));
		renderEditor();
		const nameInput = (await screen.findByDisplayValue(
			"code-reviewer",
		)) as HTMLInputElement;
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "Bad Name!");
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/lowercase/i);
		expect(invoke).not.toHaveBeenCalledWith(
			"subagent_save",
			expect.anything(),
		);
	});

	it("surfaces backend ok:false errors (e.g. non-invocable attached skill)", async () => {
		mockSubagents((cmd) => {
			if (cmd === "subagent_show") return showCodeReviewer;
			if (cmd === "subagent_save")
				return {
					ok: false,
					warnings: [],
					errors: [
						{
							field: "skills",
							level: "error",
							message: "no-invoke-skill cannot be preloaded",
						},
					],
				};
			return undefined;
		});
		renderEditor();
		await screen.findByDisplayValue("code-reviewer");
		// Make the form dirty so Save is enabled.
		const desc = screen.getByDisplayValue("Reviews code.");
		await userEvent.type(desc, " More.");
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		await waitFor(() =>
			expect(screen.getByText(/cannot be preloaded/i)).toBeInTheDocument(),
		);
	});

	it("includes advanced_yaml + safe fields in the save payload", async () => {
		const calls: unknown[] = [];
		mockSubagents((cmd, args) => {
			if (cmd === "subagent_show") return showCodeReviewer;
			if (cmd === "subagent_save") {
				calls.push(args);
				return { ok: true, name: "code-reviewer", file: "x", warnings: [], renamed_from: null };
			}
			return undefined;
		});
		renderEditor();
		await screen.findByDisplayValue("code-reviewer");
		const desc = screen.getByDisplayValue("Reviews code.");
		await userEvent.type(desc, " Updated.");
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		await waitFor(() => expect(calls.length).toBe(1));
		const payload = (calls[0] as { payload: { advanced_yaml: string; safe: { name: string } } }).payload;
		expect(payload.advanced_yaml).toContain("hooks:");
		expect(payload.safe.name).toBe("code-reviewer");
	});

	it("renders a non-invocable attachable skill as a blocked option", async () => {
		mockSubagents((cmd) => (cmd === "subagent_show" ? showCodeReviewer : undefined));
		renderEditor();
		await screen.findByDisplayValue("code-reviewer");
		const row = (await screen.findByText("no-invoke-skill")).closest(
			".subagent-skill-row",
		) as HTMLElement;
		expect(row).toHaveAttribute("data-blocked");
		// Its checkbox is disabled (not currently attached).
		expect(within(row).getByRole("checkbox")).toBeDisabled();
		expect(within(row).getByText(/not invocable/i)).toBeInTheDocument();
	});

	it("re-points the route on a rename (renamed_from)", async () => {
		const onRenamed = vi.fn();
		mockSubagents((cmd) => {
			if (cmd === "subagent_show") return showCodeReviewer;
			if (cmd === "subagent_save")
				return {
					ok: true,
					name: "reviewer-2",
					file: "x",
					warnings: [],
					renamed_from: "code-reviewer",
				};
			return undefined;
		});
		const client = makeQueryClient();
		renderEditor(client, onRenamed);
		const nameInput = (await screen.findByDisplayValue(
			"code-reviewer",
		)) as HTMLInputElement;
		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "reviewer-2");
		await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
		await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("reviewer-2"));
	});
});
