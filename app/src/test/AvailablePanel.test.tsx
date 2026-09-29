import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { backReturnOptions, useBackTarget } from "@/lib/backTarget";
import { estimateTokens } from "@/lib/estimateTokens";
import { formatProspectiveSkillLine } from "@/lib/usageGuidance";
import { useAppStore } from "@/store";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

// B1 — AvailableSkillsPanel rebuilt on ResourceRow + detail (PLAN §B1/§B1-a).
// One roving `.avail-row-wrap` (`role="listitem"`) per row; the inner
// `.avail-row` is a plain ResourceRow at `tabIndex={-1}` and Read is its
// sibling action. No gem (decision 1), MCP gets `.kind-mark` not an amber Tag.

function renderWorkspace(registry = sampleRegistry, client = makeQueryClient()) {
	useAppStore.setState({
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
				project_skills_dir: ".claude/skills",
			},
		],
	});
	primeRegistry(client, registry);
	const view = renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
			<Route path="/skill/:name" element={<ReadSkillRoute />} />
		</Routes>,
		{ client, initialRoute: "/project/example-app" },
	);
	fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
	return { ...view, client };
}

function ReadSkillRoute() {
	const navigate = useNavigate();
	const back = useBackTarget({ label: "Library", path: "/" });
	return (
		<>
			<h1>Skill editor</h1>
			<button onClick={() => navigate(back.path, backReturnOptions(back))}>
				Back to project
			</button>
		</>
	);
}

// fs-mcp is registered in `sampleRegistry` but never equipped anywhere → the
// sole Available row on `example-app`.
describe("AvailableSkillsPanel row anatomy (B1)", () => {
	it("renders no scope gem and marks an MCP row with .kind-mark, never an amber Tag", () => {
		renderWorkspace();

		const wrap = document.querySelector(".avail-row-wrap")!;
		expect(wrap).not.toBeNull();
		expect(wrap.querySelector(".scope-badge")).toBeNull();
		expect(wrap.querySelector(".kind-mark[data-kind='MCP']")).not.toBeNull();
		// The retired amber `<Tag>` rendered the bare word "MCP" as visible text;
		// `KindMark` never does (its label lives in aria-label/title only).
		expect(screen.queryByText("MCP")).toBeNull();
	});

	it("sets aria-busy on the row and cycles the equip copy while equipping", async () => {
		renderWorkspace();

		const row = screen.getByRole("button", { name: "Equip fs-mcp" });
		expect(row).not.toHaveAttribute("aria-busy");
		fireEvent.click(row);
		expect(row).toHaveAttribute("aria-busy", "true");
		expect(screen.getByText("Equipping…")).toBeInTheDocument();
	});

  it("does not start success feedback after leaving during an equip", async () => {
    const original = vi.mocked(invoke).getMockImplementation()!;
    let complete!: (result: { success: boolean; output: string }) => void;
    const pending = new Promise<{ success: boolean; output: string }>(resolve => { complete = resolve; });
    let started = false;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "hub_cmd" && (args as { args: string[] }).args[0] === "enable") {
        started = true;
        return pending as never;
      }
      return original(command, args);
    });
    const view = renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Equip fs-mcp" }));
    await waitFor(() => expect(started).toBe(true));
    view.unmount();
    const timer = vi.spyOn(window, "setTimeout");
    try {
      await act(async () => { complete({ success: true, output: "" }); });
      expect(timer.mock.calls.filter(([, delay]) => delay === 900)).toHaveLength(0);
    } finally {
      timer.mock.calls.forEach(([, delay], index) => {
        if (delay === 900) window.clearTimeout(timer.mock.results[index].value);
      });
      timer.mockRestore();
    }
  });

	it("the chevron is controlled by expandedAvailable and the detail drops SKILL/MCP/scope words", async () => {
		// rt-android-expert (portable, "Android compose planner") joins the
		// Available list once the android bundle is unassigned — its description
		// contains none of the retired meta words, unlike fs-mcp's own.
		const registry = structuredClone(sampleRegistry);
		registry.projects["example-app"].bundles = [];
		renderWorkspace(registry);

		fireEvent.click(
			screen.getByRole("button", { name: "Show rt-android-expert summary" }),
		);

		expect(screen.getByText("Android compose planner")).toBeInTheDocument();
		expect(screen.queryByText("SKILL")).toBeNull();
		expect(screen.queryByText("MCP")).toBeNull();
		expect(screen.queryByText("portable")).toBeNull();
	});
});

describe("AvailableSkillsPanel prospective cost (D16.6)", () => {
	const document = {
		name: "fs-mcp",
		description: "Filesystem MCP server from the test document",
	};

	it("prices a visible row from its exact prospective line, caches revisits, and shows pending/failure states", async () => {
		const read = vi.fn(async () => document);
		vi.mocked(invoke).mockImplementation(((command: string) =>
			command === "read_skill_document"
				? read()
				: Promise.resolve(undefined)) as never);

		const client = makeQueryClient();
		const view = renderWorkspace(undefined, client);
		const exactLine = formatProspectiveSkillLine({
			...document,
			projectSkillsDir: ".claude/skills",
		});
		const expected = `~${estimateTokens(exactLine)} tokens`;
		await screen.findByText(expected);
		expect(read).toHaveBeenCalledTimes(1);

		view.rerender(
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>,
		);
		await screen.findByText(expected);
		expect(read).toHaveBeenCalledTimes(1);
		view.unmount();

		const pending = new Promise<typeof document>(() => {});
		vi.mocked(invoke).mockImplementation(((command: string) =>
			command === "read_skill_document" ? pending : Promise.resolve(undefined)) as never);
		const pendingView = renderWorkspace(structuredClone(sampleRegistry));
		expect(await screen.findAllByText("…")).not.toHaveLength(0);
		pendingView.unmount();

		vi.mocked(invoke).mockImplementation(((command: string) =>
			command === "read_skill_document"
				? Promise.reject(new Error("unavailable"))
				: Promise.resolve(undefined)) as never);
		renderWorkspace();
		expect(await screen.findByText("token count unavailable")).toBeInTheDocument();
	});
});

describe("AvailableSkillsPanel keyboard controls (GRILL #6)", () => {
	it("Tab from the filter reaches the roving list item before its sibling Read action", async () => {
		renderWorkspace();

		const filter = screen.getByPlaceholderText("Filter library…");
		filter.focus();
		await userEvent.tab();

		const wrap = document.activeElement as HTMLElement;
		expect(wrap.classList.contains("avail-row-wrap")).toBe(true);
		expect(wrap.getAttribute("role")).toBe("listitem");
		expect(wrap.getAttribute("data-listnav-active")).toBe("true");

		const innerRow = wrap.querySelector(".avail-row")!;
		expect(innerRow).toHaveAttribute("tabindex", "-1");
	});

	it("j moves data-listnav-active to the next wrapper", () => {
		const registry = structuredClone(sampleRegistry);
		registry.projects["example-app"].bundles = [];
		renderWorkspace(registry);

		const list = screen.getByRole("list", { name: "Available skills" });
		const wraps = () =>
			Array.from(document.querySelectorAll(".avail-row-wrap"));
		const activeBefore = wraps().findIndex(
			(w) => w.getAttribute("data-listnav-active") === "true",
		);
		fireEvent.keyDown(list, { key: "j" });
		const activeAfter = wraps().findIndex(
			(w) => w.getAttribute("data-listnav-active") === "true",
		);
		expect(activeAfter).toBe(activeBefore + 1);
	});
});

describe("AvailableSkillsPanel Read skill return", () => {
	it("opens the filtered skill without equipping and restores its query and roving row", async () => {
		const registry = structuredClone(sampleRegistry);
		registry.projects["example-app"].bundles = [];
		renderWorkspace(registry);

		const filter = screen.getByPlaceholderText("Filter library…");
		fireEvent.change(filter, { target: { value: "android" } });
		const read = screen.getByRole("button", {
			name: "Read skill android-compose-ui",
		});
		fireEvent.click(read);

		expect(screen.getByRole("heading", { name: "Skill editor" })).toBeInTheDocument();
		expect(invoke).not.toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({
				args: ["enable", "android-compose-ui", "--project", "example-app", "--json"],
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Back to project" }));
		await waitFor(() => {
			expect(screen.getByPlaceholderText("Filter library…")).toHaveValue("android");
			const wrap = screen
				.getByRole("button", { name: "Equip android-compose-ui" })
				.closest(".avail-row-wrap");
			expect(wrap).toHaveAttribute("data-listnav-active", "true");
			expect(document.activeElement).toBe(wrap);
		});

		fireEvent.keyDown(screen.getByRole("list", { name: "Available skills" }), {
			key: "k",
		});
		fireEvent.keyDown(screen.getByRole("list", { name: "Available skills" }), {
			key: "e",
		});
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
