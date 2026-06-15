import { describe, expect, it, vi } from "vitest";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

function renderWorkspace(registry = sampleRegistry) {
	useAppStore.setState({
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
	// Prime registry BEFORE rendering so isLoading is false on first render,
	// avoiding the hook-count change between renders.
	const client = makeQueryClient();
	primeRegistry(client, registry);
	renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client, initialRoute: "/project/example-app" },
	);
	return client;
}

describe("ProjectWorkspace equip UX", () => {
	it("expands an available skill summary without equipping it", async () => {
		renderWorkspace();

		const row = screen.getByRole("button", { name: "Equip fs-mcp" });
		expect(row).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: "Show fs-mcp summary" }),
		);

		expect(screen.getByText("Filesystem MCP server")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Equip fs-mcp" })).toBeEnabled();
		expect(invoke).not.toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({
				args: ["enable", "fs-mcp", "--project", "example-app"],
			}),
		);
	});

	it("blocks duplicate activation while equip is pending", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "enable") {
				await new Promise<void>(() => {});
				return { success: true, output: "" };
			}
			if (cmd === "hub_cmd") return { success: true, output: "" };
			return true;
		});
		renderWorkspace();

		const row = screen.getByRole("button", { name: "Equip fs-mcp" });
		fireEvent.click(row);
		fireEvent.click(row);

		expect(row).toHaveAttribute("aria-busy", "true");
		expect(row).toBeDisabled();
		expect(screen.getByText("Equipping…")).toBeInTheDocument();
		expect(
			vi.mocked(invoke).mock.calls.filter(([, payload]) => {
				const args = (payload as { args?: string[] } | undefined)?.args ?? [];
				return args[0] === "enable" && args[1] === "fs-mcp";
			}),
		).toHaveLength(1);
	});

	it("places a newly equipped direct skill first under the default sort", async () => {
		const registry = structuredClone(sampleRegistry);
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "enable" && args[1] === "fs-mcp") {
				registry.projects["example-app"].enabled = ["brainstorm", "fs-mcp"];
				client.setQueryData(["registry"], structuredClone(registry));
				return { success: true, output: "" };
			}
			if (cmd === "read_registry") return structuredClone(registry);
			if (cmd === "hub_cmd") return { success: true, output: "" };
			return true;
		});
		const client = renderWorkspace(registry);

		fireEvent.click(screen.getByRole("button", { name: "Equip fs-mcp" }));

		await waitFor(() => {
			const grid = document.querySelector(".skill-grid");
			expect(grid).not.toBeNull();
			expect(
				within(grid as HTMLElement).getAllByText(/fs-mcp|brainstorm/)[0],
			).toHaveTextContent("fs-mcp");
		});
	});

	it("recovers the available row after equip failure", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "enable") {
				return { success: false, output: "boom" };
			}
			if (cmd === "read_registry") return structuredClone(sampleRegistry);
			if (cmd === "hub_cmd") return { success: true, output: "" };
			return true;
		});
		renderWorkspace();

		fireEvent.click(screen.getByRole("button", { name: "Equip fs-mcp" }));

		await waitFor(() => {
			expect(screen.getByText("Retry")).toBeInTheDocument();
		});
		expect(screen.getByRole("button", { name: "Equip fs-mcp" })).toBeEnabled();
	});
});

describe("ProjectWorkspace view toggle", () => {
	it("shows three view chips: Loadout, Tree, Agent Docs", async () => {
		renderWorkspace();
		await waitFor(() => {
			expect(screen.getByText("Loadout")).toBeInTheDocument();
		});
		expect(screen.getByText("Tree")).toBeInTheDocument();
		expect(screen.getAllByText("Agent Docs").length).toBeGreaterThanOrEqual(1);
	});

	it("clicking Agent Docs short-circuits to AgentDocsView header", async () => {
		renderWorkspace();
		await waitFor(() => {
			expect(screen.getByText("Loadout")).toBeInTheDocument();
		});
		const agentChip = screen.getByRole("tab", { name: /Agent Docs/i });
		act(() => {
			fireEvent.click(agentChip);
		});
		await waitFor(() => {
			expect(
				screen.getByText("Agent Docs · disk is source of truth"),
			).toBeInTheDocument();
		});
		// Save (primary) present; Refresh now lives in the overflow kebab.
		expect(screen.getByTestId("agent-docs-save")).toBeInTheDocument();
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /More actions/i }));
		});
		expect(screen.getByText("Refresh from disk")).toBeInTheDocument();
		// Sync action from Loadout/Tree should be absent now.
		expect(screen.queryByRole("button", { name: /^Sync$/i })).toBeNull();
	});
});
