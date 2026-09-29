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
	fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
	return client;
}

function emptyFootprint(project = "example-app") {
	return JSON.stringify({ ok: true, project, harnesses: {}, window: 30, last_scan_at: null });
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
				args: ["enable", "fs-mcp", "--project", "example-app", "--json"],
			}),
		);
	});

	it("blocks duplicate activation while equip is pending", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "usage" && args[1] === "footprint") {
				return { success: true, output: emptyFootprint() };
			}
			if (cmd === "hub_cmd" && args[0] === "enable") {
				await new Promise<void>(() => {});
				return { success: true, output: "" };
			}
			if (cmd === "hub_cmd") return { success: true, output: "" };
			if (cmd === "read_registry") return structuredClone(sampleRegistry);
			return true;
		});
		renderWorkspace();

		const row = screen.getByRole("button", { name: "Equip fs-mcp" });
		fireEvent.click(row);
		fireEvent.click(row);

		expect(row).toHaveAttribute("aria-busy", "true");
		// B1: the row root is now a `div role="button"` (ResourceRow), which has
		// no `disabled` HTML state to assert — the guard moved inside `onClick`
		// (`if (!isPending) …`) and `aria-busy` + `pointer-events: none` (CSS)
		// carry the same meaning. The invoke-call-count assertion below is the
		// real proof the second click was a no-op.
		expect(screen.getByText("Equipping…")).toBeInTheDocument();
		await waitFor(() => expect(
			vi.mocked(invoke).mock.calls.filter(([, payload]) => {
				const args = (payload as { args?: string[] } | undefined)?.args ?? [];
				return args[0] === "enable" && args[1] === "fs-mcp";
			}),
		).toHaveLength(1));
	});

	it("places a newly equipped direct skill first under the default sort", async () => {
		const registry = structuredClone(sampleRegistry);
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "usage" && args[1] === "footprint") {
				return { success: true, output: emptyFootprint() };
			}
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
			const grid = document.querySelector(".loadout-group:last-child");
			expect(grid).not.toBeNull();
			expect(
				within(grid as HTMLElement).getAllByText(/fs-mcp|brainstorm/)[0],
			).toHaveTextContent("fs-mcp");
		});
	});

	it("recovers the available row after equip failure", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[0] === "usage" && args[1] === "footprint") {
				return { success: true, output: emptyFootprint() };
			}
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

		const list = screen.getByRole("list", { name: "Available skills" });
		// B1: the roving stop is the `.avail-row-wrap` (`role="listitem"`), not
		// the inner ResourceRow (`tabIndex={-1}`) — `useListNav.focusIndex`
		// calls `.focus()` on the wrapper the ref-forwarding `itemProps` lands
		// on.
		const wrapOf = (name: string) =>
			screen.getByRole("button", { name }).closest(".avail-row-wrap");
		// flat order: fs-mcp (global) · rt-android-expert · android-compose-ui.
		fireEvent.keyDown(list, { key: "j" });
		expect(document.activeElement).toBe(wrapOf("Equip rt-android-expert"));
		fireEvent.keyDown(list, { key: "j" });
		expect(document.activeElement).toBe(wrapOf("Equip android-compose-ui"));
		fireEvent.keyDown(list, { key: "k" });
		expect(document.activeElement).toBe(wrapOf("Equip rt-android-expert"));
	});

	it("equips the focused row on e and on Enter", async () => {
		renderWorkspace(registryWithThreeAvailable());

		const list = screen.getByRole("list", { name: "Available skills" });
		// Enter on the initial row (index 0 = fs-mcp) equips it.
		fireEvent.keyDown(list, { key: "Enter" });
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: ["enable", "fs-mcp", "--project", "example-app", "--json"],
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
					args: ["enable", "rt-android-expert", "--project", "example-app", "--json"],
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
		const unequip = screen.getByRole("button", { name: "Unequip brainstorm" });
		const card = unequip.closest(".project-loadout-row");
		fireEvent.click(unequip);

		await waitFor(() =>
			expect(card).toHaveAttribute("data-pending", "true"),
		);

		// A second click while pending must not fire a duplicate disable.
		fireEvent.click(unequip);
		await waitFor(() => {
			const disableCalls = vi.mocked(invoke).mock.calls.filter(([cmd, payload]) => {
				const args = (payload as { args?: string[] } | undefined)?.args ?? [];
				return (
					cmd === "hub_cmd" && args[0] === "disable" && args[1] === "brainstorm"
				);
			});
			expect(disableCalls).toHaveLength(1);
		});

		gate.resolve({ success: true, output: "" });
	});
});

describe("ProjectWorkspace bundle removal feedback", () => {
	it.each([true, false])("keeps removal busy until completion and recovers when success=%s", async (success) => {
		const gate = deferredInvoke((cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			return cmd === "hub_cmd" && args[0] === "bundle" && args[1] === "remove";
		});
		renderWorkspace();
		const remove = screen.getByRole("button", { name: "Remove" });
		fireEvent.click(remove);
		expect(remove).toHaveAttribute("aria-busy", "true");
		expect(remove).toBeDisabled();
		expect(remove).toHaveTextContent("Removing…");
		fireEvent.click(remove);
		await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([cmd, payload]) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			return cmd === "hub_cmd" && args[0] === "bundle" && args[1] === "remove";
		})).toHaveLength(1));
		await act(async () => gate.resolve({ success, output: success ? "" : "Bundle removal failed" }));
		await waitFor(() => expect(remove).toBeEnabled());
		expect(remove).not.toHaveAttribute("aria-busy");
		expect(remove).not.toHaveTextContent("Removing…");
		expect(useAppStore.getState().toasts).toEqual(expect.arrayContaining([
			expect.objectContaining({ title: success ? "Removed android from example-app" : "Couldn't remove bundle" }),
		]));
		if (!success) {
			fireEvent.click(remove);
			await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([cmd, payload]) => {
				const args = (payload as { args?: string[] } | undefined)?.args ?? [];
				return cmd === "hub_cmd" && args[0] === "bundle" && args[1] === "remove";
			})).toHaveLength(2));
		}
	});
});

describe("ProjectWorkspace areas", () => {
	it("navigates by area card on the dashboard — no separate tab row", async () => {
		renderWorkspace();
		const nav = await screen.findByRole("navigation", { name: "Project areas" });
		expect(nav.className).toContain("area-strip");
		expect(nav.querySelectorAll(".area-card-hit")).toHaveLength(5);
		expect(document.querySelector(".main-subheader")).toBeNull();
	});

	it("clicking the Agent Docs card short-circuits to AgentDocsView header", async () => {
		renderWorkspace();
		const card = await screen.findByRole("button", { name: /^Agent Docs/ });
		act(() => {
			fireEvent.click(card);
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
		// Sync action from the loadout should be absent now.
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
		expect(screen.getByText("Project not found")).toBeInTheDocument();
		// The name the user actually typed survives in the body copy…
		expect(
			screen.getByText(/No project named "does-not-exist" is registered/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /add project/i }),
		).toBeInTheDocument();
	});

	/**
	 * B5 — this was the only screen in the app with no ScreenHeader, so a broken
	 * deep link left the user with no breadcrumb and no way back but the single
	 * Add-project button.
	 */
	it("gives the not-found state a header with a way back to the library", async () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
				<Route path="/" element={<div data-testid="library-route" />} />
			</Routes>,
			{ client, initialRoute: "/project/does-not-exist" },
		);
		const back = screen.getByRole("button", { name: "Back to Library" });
		await userEvent.click(back);
		expect(screen.getByTestId("library-route")).toBeInTheDocument();
	});

	/**
	 * B5 — `/project/__none__` is a route placeholder, not something the user
	 * named. Headlining the raw sentinel made the app look like it had lost
	 * something that never existed.
	 */
	it("never headlines the __none__ sentinel", () => {
		const client = makeQueryClient();
		primeRegistry(client);
		const { container } = renderWithProviders(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
			{ client, initialRoute: "/project/__none__" },
		);
		expect(screen.getByText("No project selected")).toBeInTheDocument();
		expect(screen.queryByText("Project not found")).not.toBeInTheDocument();
		expect(container.textContent).not.toContain("__none__");
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
			await screen.findByRole("button", { name: "Add skills" }),
		).toBeInTheDocument();
	});
});
