import { describe, expect, it, vi } from "vitest";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
	deferredInvoke,
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

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

describe("ProjectWorkspace Available roving keyboard nav (B1-08)", () => {
	// Clear the android bundle so rt-android-expert + android-compose-ui join
	// fs-mcp in the Available list → three rows to rove across.
	function registryWithThreeAvailable() {
		const registry = structuredClone(sampleRegistry);
		registry.projects["example-app"].bundles = [];
		return registry;
	}

	it("moves the active row with j / k across scope groups", () => {
		renderWorkspace(registryWithThreeAvailable());

		const list = screen.getByRole("listbox", { name: "Available skills" });
		// flat order: fs-mcp (global) · rt-android-expert · android-compose-ui.
		fireEvent.keyDown(list, { key: "j" });
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Equip rt-android-expert" }),
		);
		fireEvent.keyDown(list, { key: "j" });
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Equip android-compose-ui" }),
		);
		fireEvent.keyDown(list, { key: "k" });
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Equip rt-android-expert" }),
		);
	});

	it("equips the focused row on e and on Enter", async () => {
		renderWorkspace(registryWithThreeAvailable());

		const list = screen.getByRole("listbox", { name: "Available skills" });
		// Enter on the initial row (index 0 = fs-mcp) equips it.
		fireEvent.keyDown(list, { key: "Enter" });
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: ["enable", "fs-mcp", "--project", "example-app"],
				}),
			),
		);

		// Move to rt-android-expert and equip it with `e`.
		fireEvent.keyDown(list, { key: "j" });
		fireEvent.keyDown(list, { key: "e" });
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: ["enable", "rt-android-expert", "--project", "example-app"],
				}),
			),
		);
	});
});

describe("ProjectWorkspace unequip pending feedback (B1-09)", () => {
	it("marks the card pending while the disable mutation is in flight and blocks a duplicate", async () => {
		const gate = deferredInvoke((cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			return cmd === "hub_cmd" && args[0] === "disable";
		});
		renderWorkspace();

		// brainstorm is the only directly-equipped skill → the one card with an ×.
		const unequip = screen.getByRole("button", { name: "Unequip" });
		const card = unequip.closest(".skill-card");
		fireEvent.click(unequip);

		await waitFor(() =>
			expect(card).toHaveClass("skill-card-unequipping"),
		);

		// A second click while pending must not fire a duplicate disable.
		fireEvent.click(unequip);
		const disableCalls = vi.mocked(invoke).mock.calls.filter(([cmd, payload]) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			return (
				cmd === "hub_cmd" && args[0] === "disable" && args[1] === "brainstorm"
			);
		});
		expect(disableCalls).toHaveLength(1);

		gate.resolve({ success: true, output: "" });
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

describe("ProjectWorkspace empty state (C3)", () => {
	it("offers an Add project action instead of a dead end when no project is selected", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		// Rendered without a matching `/project/:name` Route, so useParams()
		// resolves to no name — the "No project selected" branch.
		renderWithProviders(
			<>
				<ProjectWorkspace />
				<LocationProbe />
			</>,
			{ client },
		);

		expect(screen.getByText("No project selected")).toBeInTheDocument();
		const addBtn = screen.getByRole("button", { name: /add project/i });
		await userEvent.click(addBtn);
		expect(screen.getByTestId("loc").textContent).toBe("/?addProject=1");
	});

	it("also offers Add project when a stale project name isn't in the registry", () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: "/project/does-not-exist" },
		);
		expect(
			screen.getByText('Project "does-not-exist" not found'),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /add project/i }),
		).toBeInTheDocument();
	});
});

// ─── F3 — hook order stable across a deferred registry query ──────────────────
// The workspace's derived `useMemo`s + `useListNav` must run on EVERY render, so
// they are hoisted ABOVE the isLoading / not-found early returns. Before that
// fix the loading→loaded transition added hooks after an early return, and React
// threw "Rendered more hooks than during the previous render." This test drives
// exactly that transition (deferred registry, then resolved).
describe("ProjectWorkspace loading transition (F3)", () => {
	it("survives a deferred registry query without a hook-order crash", async () => {
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
		// Gate the registry read so the FIRST render is genuinely `isLoading`.
		const gate = deferredInvoke((cmd) => cmd === "read_registry");
		const client = makeQueryClient();
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: "/project/example-app" },
		);

		// First render: registry pending → the loading placeholder (early return
		// BEFORE the hoisted hooks would have run on the old code).
		expect(await screen.findByText("Loading workspace")).toBeInTheDocument();

		// Resolve the registry → the component re-renders WITH data. On the old
		// code this render calls more hooks than the loading one → React throws.
		await act(async () => {
			gate.resolve(sampleRegistry);
		});

		// The workspace renders through to the equip surface — no hook-order crash.
		expect(
			await screen.findByRole("button", { name: "Equip fs-mcp" }),
		).toBeInTheDocument();
	});
});
