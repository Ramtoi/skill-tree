import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
} from "./helpers";
import { InvocationBadge } from "@/components/InvocationBadge";
import { ScopeBadge } from "@/components/Tag";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { SkillEditor } from "@/screens/SkillEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import {
	INVOCATION_CONSEQUENCE,
	INVOCATION_GLOBAL_OVERRIDE_REASON,
	INVOCATION_MCP_REASON,
	INVOCATION_EXTERNAL_REASON,
} from "@/lib/invocation";
import type { Registry } from "@/types";

// ─── InvocationBadge render rules ────────────────────────────────────────────

describe("InvocationBadge", () => {
	it("renders nothing for auto / absent (deviation-only)", () => {
		const { container: c1 } = renderWithProviders(<InvocationBadge />);
		expect(c1.querySelector(".invocation-badge")).toBeNull();
		const { container: c2 } = renderWithProviders(
			<InvocationBadge invocation="auto" />,
		);
		expect(c2.querySelector(".invocation-badge")).toBeNull();
	});

	it("renders an info badge for user-only with the consequence tooltip", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="user-only" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge).not.toBeNull();
		expect(badge!.getAttribute("data-channel")).toBe("info");
		expect(badge!.getAttribute("title")).toBe(INVOCATION_CONSEQUENCE["user-only"]);
	});

	it("renders a neutral badge for model-only", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="model-only" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge!.getAttribute("data-channel")).toBe("neutral");
		expect(badge!.getAttribute("title")).toBe(
			INVOCATION_CONSEQUENCE["model-only"],
		);
	});

	it("renders a warn badge for conflicted", () => {
		const { container } = renderWithProviders(
			<InvocationBadge invocation="conflicted" />,
		);
		const badge = container.querySelector(".invocation-badge");
		expect(badge!.getAttribute("data-channel")).toBe("warn");
		expect(badge!.getAttribute("title")).toMatch(/contradiction/i);
	});

	it("never uses the brand violet channel", () => {
		for (const inv of ["user-only", "model-only", "conflicted"]) {
			const { container } = renderWithProviders(
				<InvocationBadge invocation={inv} />,
			);
			const badge = container.querySelector(".invocation-badge");
			expect(badge!.getAttribute("data-channel")).not.toBe("violet");
		}
	});
});

// ─── ScopeBadge reach tooltips ───────────────────────────────────────────────

describe("ScopeBadge reach tooltips", () => {
	it("shows the full per-project reach sentence for portable (not the bare word)", () => {
		const { container } = renderWithProviders(<ScopeBadge scope="portable" />);
		const badge = container.querySelector(".scope-badge")!;
		expect(badge.getAttribute("title")).toMatch(/Per-project — equip it where/);
		expect(badge.getAttribute("title")).toMatch(/intent label/);
		expect(badge.getAttribute("title")).not.toBe("PORTABLE");
	});

	it("shows the everywhere sentence for global without the intent note", () => {
		const { container } = renderWithProviders(<ScopeBadge scope="global" />);
		const title = container.querySelector(".scope-badge")!.getAttribute("title");
		expect(title).toMatch(/Everywhere — active in every project/);
		expect(title).not.toMatch(/intent label/);
	});

	it("frames project scope as intent-only per-project", () => {
		const { container } = renderWithProviders(
			<ScopeBadge scope="project-specific" />,
		);
		const title = container.querySelector(".scope-badge")!.getAttribute("title");
		expect(title).toMatch(/built for one specific project/);
		expect(title).toMatch(/intent label/);
	});
});

// ─── Library invocation filter facet ─────────────────────────────────────────

const libraryRegistry: Registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"triggered-user": {
			version: "1.0.0",
			description: "user only skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			invocation: "user-only",
		},
		"triggered-auto": {
			version: "1.0.0",
			description: "auto skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
		},
		"triggered-conflicted": {
			version: "1.0.0",
			description: "conflicted skill",
			source: "",
			type: "claude-skill",
			scope: "global",
			upstream: null,
			invocation: "conflicted",
		},
	},
	projects: {},
	bundles: {},
} as unknown as Registry;

describe("SkillLibrary invocation filter facet", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === "read_registry") return libraryRegistry;
			if (cmd === "local_skill_candidates") return [];
			if (cmd === "harness_list") return [];
			if (cmd === "hub_cmd")
				return { success: true, output: '{"sources":[],"errors":[]}' };
			return undefined;
		}) as never);
	});

	it("badges the deviating row and leaves the auto row quiet", () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		const userRow = screen
			.getByText("triggered-user")
			.closest(".resource-row")!;
		const autoRow = screen
			.getByText("triggered-auto")
			.closest(".resource-row")!;
		expect(userRow.querySelector(".invocation-badge")).not.toBeNull();
		expect(autoRow.querySelector(".invocation-badge")).toBeNull();
	});

	it("filters the list to the chosen effective library mode", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		// Both visible before filtering.
		expect(screen.getByText("triggered-auto")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
		await userEvent.click(screen.getByRole("button", { name: "User-only" }));

		expect(screen.getByText("triggered-user")).toBeInTheDocument();
		expect(screen.queryByText("triggered-auto")).toBeNull();
	});

	it("the auto facet matches skills with no invocation key", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
		await userEvent.click(screen.getByRole("button", { name: "Auto" }));

		expect(screen.getByText("triggered-auto")).toBeInTheDocument();
		expect(screen.queryByText("triggered-user")).toBeNull();
	});

	it("the auto facet excludes conflicted skills (conflicted is its own facet)", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
		await userEvent.click(screen.getByRole("button", { name: "Auto" }));

		expect(screen.getByText("triggered-auto")).toBeInTheDocument();
		expect(screen.queryByText("triggered-conflicted")).toBeNull();
	});

	it("the conflicted facet shows only conflicted skills", async () => {
		const client = makeQueryClient();
		client.setQueryData(["registry"], libraryRegistry);
		client.setQueryData(["localCandidates"], []);
		renderWithProviders(<SkillLibrary />, { client });

		await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
		await userEvent.click(screen.getByRole("button", { name: "Conflicted" }));

		expect(screen.getByText("triggered-conflicted")).toBeInTheDocument();
		expect(screen.queryByText("triggered-auto")).toBeNull();
		expect(screen.queryByText("triggered-user")).toBeNull();
	});
});

// ─── SkillEditor Triggering picker ───────────────────────────────────────────

const editorRegistry: Registry = {
	version: "1",
	hub_path: "~",
	skills: {
		"local-skill": {
			version: "1.0.0",
			description: "a local skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "local",
		},
		"ext-skill": {
			version: "1.0.0",
			description: "external skill",
			source: "",
			type: "claude-skill",
			scope: "portable",
			upstream: "git@github.com:org/skills.git",
			managed: "external",
			origin: { source: "org", source_type: "git", path: "skills/ext-skill", ref: "a" },
		},
		"mcp-skill": {
			version: "1.0.0",
			description: "an mcp server",
			source: "",
			type: "mcp-server",
			scope: "global",
			upstream: null,
			managed: "local",
		},
	},
	projects: {},
	bundles: {},
} as unknown as Registry;

function setupEditorInvoke(calls: string[][]) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return editorRegistry;
		if (cmd === "read_skill_document") {
			const { name } = (args as { name: string }) ?? { name: "" };
			return {
				name,
				description: editorRegistry.skills[name]?.description ?? "",
				body: `# ${name}\nhello`,
			};
		}
		if (cmd === "check_python") return true;
		if (cmd === "harness_list") return [];
		if (cmd === "subagent_skill_usage") return {};
		if (cmd === "hub_cmd") {
			calls.push((args as { args?: string[] })?.args ?? []);
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
}

function renderEditor(initialRoute: string, client = makeQueryClient()) {
	client.setQueryData(["python"], {
		ok: true,
		reason: "none",
		detail: null,
		python: "/usr/bin/python3",
	});
	client.setQueryData(["registry"], editorRegistry);
	return renderWithProviders(
		<Routes>
			<Route path="/skill/:name" element={<SkillEditor />} />
		</Routes>,
		{ client, initialRoute },
	);
}

describe("SkillEditor Triggering picker", () => {
	it("saves the chosen mode via set-meta --invocation", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/local-skill");

		const radio = await screen.findByRole("radio", { name: /User-only/ });
		expect(radio).not.toBeDisabled();
		await userEvent.click(radio);

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "set-meta" &&
						c[1] === "local-skill" &&
						c[2] === "--invocation" &&
						c[3] === "user-only",
				),
			).toBe(true),
		);
	});

	it("disables the picker for an external skill with the ownership reason", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/ext-skill");

		const radio = await screen.findByRole("radio", { name: /User-only/ });
		expect(radio).toBeDisabled();
		expect(screen.getByText(INVOCATION_EXTERNAL_REASON)).toBeInTheDocument();
	});

	it("disables the picker for an MCP server with the mcp reason", async () => {
		const calls: string[][] = [];
		setupEditorInvoke(calls);
		renderEditor("/skill/mcp-skill");

		const radio = await screen.findByRole("radio", { name: /Auto/ });
		expect(radio).toBeDisabled();
		expect(screen.getByText(INVOCATION_MCP_REASON)).toBeInTheDocument();
	});
});

// ─── ProjectWorkspace override control ───────────────────────────────────────

function workspaceRegistry(): Registry {
	return {
		version: "1",
		hub_path: "~",
		skills: {
			"portable-a": {
				version: "1.0.0",
				description: "portable skill",
				source: "",
				type: "claude-skill",
				scope: "portable",
				upstream: null,
			},
			"global-b": {
				version: "1.0.0",
				description: "global skill",
				source: "",
				type: "claude-skill",
				scope: "global",
				upstream: null,
			},
		},
		projects: {
			alpha: {
				path: "/a",
				bundles: [],
				enabled: ["portable-a", "global-b"],
			},
		},
		bundles: {},
		harnesses_global: ["claude-code"],
	} as unknown as Registry;
}

function setupWorkspace(client = makeQueryClient()) {
	const reg = workspaceRegistry();
	const calls: string[][] = [];
	useAppStore.setState({
		toasts: [],
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
		],
	});
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return reg;
		if (cmd === "sync_report") return null;
		if (cmd === "project_scan_candidates") return [];
		if (cmd === "path_exists") return false;
		if (cmd === "harness_list") return useAppStore.getState().harnesses;
		if (cmd === "hub_cmd") {
			const a = (args as { args?: string[] })?.args ?? [];
			calls.push(a);
			if (a[0] === "project" && a[1] === "invocation") {
				const proj = reg.projects[a[2]];
				const skill = a[4];
				const mode = a[6];
				const overrides = { ...(proj.invocation_overrides ?? {}) };
				if (mode === "inherit") delete overrides[skill];
				else overrides[skill] = mode as "auto" | "user-only" | "model-only";
				proj.invocation_overrides = overrides;
			}
			return { success: true, output: "" };
		}
		return undefined;
	}) as never);
	primeRegistry(client, reg);
	renderWithProviders(
		<>
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>
			<ToastContainer />
		</>,
		{ client, initialRoute: "/project/alpha" },
	);
	return { calls, reg };
}

describe("ProjectWorkspace invocation override control", () => {
	beforeEach(() => window.localStorage.clear());

	it("sets a per-project override and shows an undo toast, then undo clears it", async () => {
		const { calls } = setupWorkspace();

		const card = (await screen.findByText("portable-a")).closest(
			".skill-card",
		)! as HTMLElement;
		await userEvent.click(
			within(card).getByTitle("Set per-project triggering"),
		);
		await userEvent.click(screen.getByRole("menuitemradio", { name: /User-only/ }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "project" &&
						c[1] === "invocation" &&
						c[2] === "alpha" &&
						c[4] === "portable-a" &&
						c[6] === "user-only",
				),
			).toBe(true),
		);

		// Undo toast → inverse verb clears the override (--mode inherit).
		await waitFor(() => expect(screen.getByText("Undo")).toBeInTheDocument());
		await userEvent.click(screen.getByText("Undo"));
		await waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c[0] === "project" &&
						c[1] === "invocation" &&
						c[4] === "portable-a" &&
						c[6] === "inherit",
				),
			).toBe(true),
		);
	});

	it("disables the control for a global-scope skill with the precedence explanation", async () => {
		setupWorkspace();

		const card = (await screen.findByText("global-b")).closest(
			".skill-card",
		)! as HTMLElement;
		await userEvent.click(
			within(card).getByTitle("Set per-project triggering"),
		);

		expect(screen.getByText(INVOCATION_GLOBAL_OVERRIDE_REASON)).toBeInTheDocument();
		// No settable radio options are offered for a gated skill.
		expect(screen.queryByRole("menuitemradio")).toBeNull();
	});
});
