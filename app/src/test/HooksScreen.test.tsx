import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient } from "./helpers";
import { HooksScreen } from "@/screens/HooksScreen";

const CAPS = {
	schema_version: 1,
	probed_at: "2026-07-14T00:00:00Z",
	harnesses: {
		"claude-code": {
			harness_id: "claude-code",
			verdict: "supported",
			reason: "Claude Code is installed; command hooks are supported.",
			extra: {},
		},
		opencode: {
			harness_id: "opencode",
			verdict: "unsupported",
			reason: "LSP available but off by default; plugins not hub-managed.",
			extra: { lsp_state: "disabled" },
		},
		pi: {
			harness_id: "pi",
			verdict: "not_installed",
			reason: "pi is not installed on this machine.",
			extra: {},
		},
	},
};

const HOOKS = [
	{
		name: "lsp-report",
		provenance: "builtin",
		event: "PostToolUse",
		command: "python3 lsp_report.py",
		description: "One-shot language diagnostics after file edits",
		tools: ["Edit", "Write", "MultiEdit"],
		matcher: "",
		timeout: null,
		harnesses: null,
		settings: {},
		attached_global: true,
		attached_projects: [],
	},
	{
		name: "notify-on-stop",
		provenance: "user",
		event: "Stop",
		command: "say done",
		description: "",
		tools: [],
		matcher: "",
		timeout: 30,
		harnesses: null,
		settings: {},
		attached_global: false,
		attached_projects: ["example-app"],
	},
];

function mockHooks(hooks: unknown[], caps: unknown = CAPS) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "hook_list") return Promise.resolve({ hooks, reach: {} });
		if (cmd === "hook_capabilities") return Promise.resolve(caps);
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderScreen() {
	return renderWithProviders(
		<Routes>
			<Route path="/hooks" element={<HooksScreen />} />
			<Route path="/hook/:name" element={<div>EDITOR:{location.hash}</div>} />
		</Routes>,
		{ initialRoute: "/hooks", client: makeQueryClient() },
	);
}

describe("HooksScreen", () => {
	beforeEach(() => {
		mockHooks(HOOKS);
	});

	it("renders a row with name, event, tools, provenance and reach badges", async () => {
		renderScreen();
		// Name (mono) + event tag.
		expect(await screen.findByText("lsp-report")).toBeInTheDocument();
		expect(screen.getByText("PostToolUse")).toBeInTheDocument();
		// Tools chips.
		expect(screen.getByText("Edit")).toBeInTheDocument();
		expect(screen.getByText("Write")).toBeInTheDocument();
		// Provenance badges — both builtin and user rows.
		expect(screen.getByText("builtin")).toBeInTheDocument();
		expect(screen.getByText("user")).toBeInTheDocument();
		// The user hook with no tools shows "all tools".
		expect(screen.getAllByText("all tools").length).toBeGreaterThan(0);
	});

	it("shows a supported reach badge for claude-code and an unsupported one for opencode with a reason tooltip", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		// opencode reach badge carries the verdict reason as its tooltip.
		const openBadges = screen.getAllByTitle(
			"LSP available but off by default; plugins not hub-managed.",
		);
		expect(openBadges.length).toBeGreaterThan(0);
		// claude-code is supported → its badge exposes an accessible "supported" name.
		expect(
			screen.getAllByLabelText(/Claude Code: supported/i).length,
		).toBeGreaterThan(0);
		// not_installed harness (pi) is omitted entirely.
		expect(screen.queryByLabelText(/Pi:/i)).toBeNull();
	});

	it("renders an EmptyState when there are no hooks", async () => {
		mockHooks([]);
		renderScreen();
		expect(await screen.findByText("No hooks yet")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /create your first hook/i }),
		).toBeInTheDocument();
	});

	it("opens the editor via keyboard Enter on the focused row", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		const listbox = screen.getByRole("listbox", { name: "Hooks" });
		fireEvent.keyDown(listbox, { key: "Enter" });
		await waitFor(() =>
			expect(screen.getByText(/^EDITOR:/)).toBeInTheDocument(),
		);
	});

	it("renders a raw matcher as /matcher/ with a tooltip, replacing the tool chips", async () => {
		// Every other hook fixture in the suite sets matcher: "" — this row is the
		// power-user escape hatch that WINS over the tools list, so the row must
		// show the matcher rather than tool chips (which would misdescribe when
		// the hook fires).
		mockHooks([
			{
				...HOOKS[1],
				name: "notebook-guard",
				matcher: "Notebook.*",
				tools: ["Edit", "Write"],
			},
		]);
		renderScreen();

		const matcher = await screen.findByText("/Notebook.*/");
		expect(matcher).toHaveAttribute("title", "raw matcher: Notebook.*");
		// The tools it would otherwise list are NOT shown, and neither is the
		// "all tools" fallback.
		expect(screen.queryByText("Edit")).toBeNull();
		expect(screen.queryByText("Write")).toBeNull();
		expect(screen.queryByText("all tools")).toBeNull();
	});

	it("navigates to the create flow from the New hook button", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		fireEvent.click(screen.getByRole("button", { name: "New hook" }));
		await waitFor(() =>
			expect(screen.getByText(/^EDITOR:/)).toBeInTheDocument(),
		);
	});
});
