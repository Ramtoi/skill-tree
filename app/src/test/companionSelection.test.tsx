// D8's query-param selection contract (plan 2): a companion row's name links
// to `/harness/:id?agent=<name>` (agents) or the current permissions screen's
// `?focus=<kind>:<pattern>` (rules). Both consumers select, scroll/open,
// strip the param, and carry a referrer in history state (`lib/queryFocus.ts`
// semantics) — modeled on the Sources `?focus=` deep link, extended here to
// `SubagentManager` and `PermissionsEditor`.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation } from "react-router-dom";

import { SubagentManager } from "@/components/subagents/SubagentManager";
import { PermissionsEditor } from "@/components/PermissionsEditor";
import { fromNav, skillBackTarget } from "@/lib/backTarget";
import { renderWithProviders, makeQueryClient, primeRegistry, sampleRegistry } from "./helpers";
import type { NormalizedPermissions } from "@/types/permissions";

type InitialRoute = string | { pathname: string; search?: string; state?: unknown };

/** Renders the router state alongside whatever screen is under test — proves
 *  the param actually stripped and (for the agent case) that a navigation
 *  away actually happened, not just that a callback fired. */
function LocationProbe() {
	const loc = useLocation();
	return (
		<div
			data-testid="loc"
			data-path={loc.pathname}
			data-search={loc.search}
			data-state={JSON.stringify(loc.state ?? null)}
		/>
	);
}

// ─── SubagentManager: `?agent=<name>` (S5 — user-scope agents only) ─────────

const USER_LIST = {
	scope: "user",
	project: null,
	agents_dir: "/home/test/.claude/agents",
	settings_path: "/home/test/.claude/settings.json",
	agents: [
		{
			name: "code-reviewer",
			file: "code-reviewer.md",
			relpath: "code-reviewer.md",
			description: "Reviews code.",
			model: "sonnet",
			tools_mode: "allowlist",
			tools: ["Read"],
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

const SHOW_CODE_REVIEWER = {
	name: "code-reviewer",
	scope: "user",
	file: "code-reviewer.md",
	exists: true,
	safe: {
		name: "code-reviewer",
		description: "Reviews code.",
		model: "sonnet",
		tools_mode: "allowlist",
		tools: ["Read"],
		disallowed_tools: [],
		allow_skill_discovery: true,
		skills: [],
		color: "blue",
	},
	advanced_yaml: "",
	body: "You review code.",
	disabled: false,
	validation: { valid: true, warnings: [] },
};

function mockSubagentInvoke(extra?: (cmd: string, args?: unknown) => unknown) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (extra) {
			const v = extra(cmd, args);
			if (v !== undefined) return v;
		}
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return [
					{
						id: "claude-code",
						label: "Claude Code",
						installed: true,
						on_globally: true,
						used_by_projects: [],
					},
				];
			case "subagent_list":
				return USER_LIST;
			case "subagent_show":
				return SHOW_CODE_REVIEWER;
			case "subagent_attachable_skills":
				return [];
			case "subagent_skill_usage":
				return {};
			default:
				return undefined;
		}
	}) as never);
}

function renderManager(initialRoute: InitialRoute) {
	const client = makeQueryClient();
	primeRegistry(client);
	return renderWithProviders(
		<Routes>
			<Route
				path="/harness/claude-code"
				element={
					<>
						<SubagentManager harness="claude-code" initialScope="user" initialProject={null} />
						<LocationProbe />
					</>
				}
			/>
			<Route path="*" element={<LocationProbe />} />
		</Routes>,
		{ client, initialRoute },
	);
}

describe("SubagentManager ?agent= deep link", () => {
	it("opens the editor after the list resolves, then strips the param", async () => {
		mockSubagentInvoke();
		renderManager({ pathname: "/harness/claude-code", search: "?agent=code-reviewer" });

		expect(
			await screen.findByRole("button", { name: /Rename agent name: code-reviewer/i }),
		).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId("loc").dataset.search).toBe(""));
		expect(screen.getByTestId("loc").dataset.path).toBe("/harness/claude-code");
	});

	it("back returns to the carried referrer when the link brought one", async () => {
		mockSubagentInvoke();
		renderManager({
			pathname: "/harness/claude-code",
			search: "?agent=code-reviewer",
			state: fromNav(skillBackTarget("orchestrate-advanced")).state,
		});

		await screen.findByRole("button", { name: /Rename agent name: code-reviewer/i });
		fireEvent.click(screen.getByRole("button", { name: "Back to orchestrate-advanced" }));
		await waitFor(() =>
			expect(screen.getByTestId("loc").dataset.path).toBe("/skill/orchestrate-advanced"),
		);
	});

	it("closes back to the list (no navigation) for an in-list open, never carrying a stale referrer", async () => {
		mockSubagentInvoke();
		renderManager({
			pathname: "/harness/claude-code",
			search: "",
			state: fromNav(skillBackTarget("orchestrate-advanced")).state,
		});

		fireEvent.click(await screen.findByText("code-reviewer"));
		await screen.findByRole("button", { name: /Rename agent name: code-reviewer/i });
		fireEvent.click(screen.getByRole("button", { name: "Back to Sub-agents" }));

		// Never navigated away — an in-list open carries no referrer, so close
		// falls back to the list on the SAME route.
		await screen.findByText("code-reviewer");
		expect(screen.getByTestId("loc").dataset.path).toBe("/harness/claude-code");
	});

	it("is a no-op for an unknown agent name — nothing opens, the param still strips", async () => {
		mockSubagentInvoke();
		renderManager({ pathname: "/harness/claude-code", search: "?agent=no-such-agent" });

		await screen.findByText("code-reviewer"); // the list, not the editor
		await waitFor(() => expect(screen.getByTestId("loc").dataset.search).toBe(""));
		expect(
			screen.queryByRole("button", { name: /Rename agent name/i }),
		).not.toBeInTheDocument();
	});
});

// ─── PermissionsEditor: `?focus=<kind>:<pattern>` ───────────────────────────

const PROJECT_PERMS: NormalizedPermissions = {
	allow: [],
	deny: [{ pattern: "Bash(git push --force:*)", kind: "deny", harnesses: null, origin: "project" }],
	ask: [],
	hooks: [],
	sandbox_mode: null,
	approval_policy: null,
	project_trust: null,
	additional_dirs: [],
	extras: {},
	_unmanaged: [],
};

const CAPS = {
	"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask", "hooks", "additional_directories"],
};

function mockPermissionsInvoke() {
	vi.mocked(invoke).mockImplementation(
		async (cmd: string): Promise<unknown> => {
			switch (cmd) {
				case "read_registry":
					return sampleRegistry;
				case "permissions_show":
					return PROJECT_PERMS;
				case "permissions_capabilities":
					return CAPS;
				case "permissions_risks_schema":
					return [];
				case "permissions_doctor":
					return { findings: [], danger_count: 0 };
				default:
					return undefined;
			}
		},
	);
}

function renderPermissions(initialRoute: InitialRoute) {
	const client = makeQueryClient();
	return renderWithProviders(
		<>
			<PermissionsEditor scope={{ kind: "project", name: "notes-vault" }} projectCount={1} />
			<LocationProbe />
		</>,
		{ client, initialRoute },
	);
}

describe("PermissionsEditor ?focus= deep link", () => {
	it("resolves a declared kind:pattern to the row's data-focus-key and focuses it, then strips the param", async () => {
		mockPermissionsInvoke();
		const { container } = renderPermissions({
			pathname: "/project/notes-vault",
			search: `?tab=permissions&focus=${encodeURIComponent(
				"deny:Bash(git push --force:*)",
			)}`,
		});

		await waitFor(() => {
			const row = container.querySelector('[data-focus-key="deny:0"] input');
			expect(document.activeElement).toBe(row);
		});
		// `focus=` strips; `tab=permissions` (an unrelated param) survives.
		await waitFor(() => expect(screen.getByTestId("loc").dataset.search).toBe("?tab=permissions"));
	});

	it("is a no-op for an unresolvable pattern — nothing focuses, the param still strips", async () => {
		mockPermissionsInvoke();
		renderPermissions({
			pathname: "/project/notes-vault",
			search: `?tab=permissions&focus=${encodeURIComponent(
				"deny:Bash(no-such-rule:*)",
			)}`,
		});

		await waitFor(() =>
			expect(screen.getByTestId("loc").dataset.search).toBe("?tab=permissions"),
		);
		expect(document.activeElement).not.toHaveAttribute("aria-label", "Pattern");
	});
});
