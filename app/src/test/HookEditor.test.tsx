import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { useAppStore } from "@/store";

const CAPS = {
	schema_version: 1,
	probed_at: "2026-07-14T00:00:00Z",
	harnesses: {
		"claude-code": {
			harness_id: "claude-code",
			verdict: "supported",
			reason: "supported",
			extra: {},
		},
		codex: { harness_id: "codex", verdict: "supported", reason: "supported", extra: {} },
	},
};

const BUILTIN_LSP = {
	name: "lsp-report",
	provenance: "builtin",
	event: "PostToolUse",
	command: "python3 lsp_report.py --config lsp-report.json",
	description: "One-shot language diagnostics after file edits",
	tools: ["Edit", "Write", "MultiEdit"],
	matcher: "",
	timeout: null,
	harnesses: null,
	settings: {
		languages: {
			python: { enabled: true, mode: "advisory", timeout: 30 },
			typescript: { enabled: false, mode: "advisory", timeout: 30 },
		},
	},
	attached_global: true,
	attached_projects: [],
	project_settings: {},
	reach: {},
};

/** Compose a per-command mock over the setup default, capturing calls. */
function mockEditor(over: Record<string, (args?: unknown) => unknown> = {}) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
		if (over[cmd]) return Promise.resolve(over[cmd](args));
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderEditor(route: string) {
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
			<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
		</Routes>,
		{ initialRoute: route, client: makeQueryClient() },
	);
}

describe("HookEditor — create mode", () => {
	it("populates the event picker and tools picker (incl. MCP tools)", async () => {
		mockEditor();
		renderEditor("/hook/new");
		// Event picker seeded from the canonical vocabulary.
		const eventSelect = await screen.findByLabelText("event");
		expect(eventSelect).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "PostToolUse" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "SessionStart" }),
		).toBeInTheDocument();
		// Tools picker: canonical built-ins + the registry's mcp-server token.
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(screen.getByText("Edit")).toBeInTheDocument();
		expect(screen.getByText("mcp__fs-mcp")).toBeInTheDocument();
	});

	it("edits the command, goes dirty, and ⌘S saves via hook_new IPC", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_new: (args) => {
				calls.push(args);
				return { success: true, output: "created" };
			},
		});
		renderEditor("/hook/new");

		const nameInput = await screen.findByLabelText("hook name");
		fireEvent.change(nameInput, { target: { value: "lint-x" } });
		const cmd = screen.getByLabelText("command");
		fireEvent.change(cmd, { target: { value: "echo hi" } });

		// Editing marks the form dirty (UNSAVED pill appears).
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();

		// ⌘S saves.
		fireEvent.keyDown(window, { key: "s", metaKey: true });

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "lint-x",
			event: "PostToolUse",
			command: "echo hi",
		});
	});
});

describe("HookEditor — built-in constraints", () => {
	it("renders command and event read-only for a built-in, settings still editable", async () => {
		mockEditor({ hook_show: () => BUILTIN_LSP });
		renderEditor("/hook/lsp-report");

		const cmd = (await screen.findByLabelText("command")) as HTMLTextAreaElement;
		expect(cmd.readOnly).toBe(true);
		expect(screen.getByLabelText("event")).toBeDisabled();

		// The settings section is present and editable (not globally disabled).
		expect(screen.getByLabelText("settings scope")).toBeInTheDocument();
		// lsp-report per-language table renders with a row per language.
		expect(
			screen.getByRole("table", { name: "lsp-report languages" }),
		).toBeInTheDocument();
		expect(screen.getByText("python")).toBeInTheDocument();
		expect(screen.getByText("typescript")).toBeInTheDocument();
	});

	it("lsp-report per-language table edits via hook_set_settings at project scope", async () => {
		const calls: unknown[] = [];
		mockEditor({
			hook_show: () => BUILTIN_LSP,
			hook_set_settings: (args) => {
				calls.push(args);
				return { success: true, output: "ok" };
			},
		});
		renderEditor("/hook/lsp-report");

		await screen.findByRole("table", { name: "lsp-report languages" });
		// Built-in global defaults are read-only → pick a project scope to edit.
		fireEvent.change(screen.getByLabelText("settings scope"), {
			target: { value: "example-app" },
		});
		// Now the per-language toggle is editable; flip typescript on.
		const tsToggle = screen.getByLabelText("typescript enabled");
		expect(tsToggle).not.toBeDisabled();
		fireEvent.click(tsToggle);

		await waitFor(() => expect(calls.length).toBe(1));
		expect(calls[0]).toMatchObject({
			name: "lsp-report",
			project: "example-app",
			global: false,
			settings: { languages: { typescript: { enabled: true } } },
		});
	});

	it("shows the honest LSP mode labels (never 'prevents the edit')", async () => {
		mockEditor({ hook_show: () => BUILTIN_LSP });
		renderEditor("/hook/lsp-report");
		await screen.findByRole("table", { name: "lsp-report languages" });
		// Mode select options use the honest labels.
		expect(
			screen.getAllByRole("option", { name: "report" }).length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByRole("option", {
				name: "interrupt (agent must address)",
			}).length,
		).toBeGreaterThan(0);
	});

	it("surfaces a failed hook_set_settings call as an error toast instead of swallowing it", async () => {
		useAppStore.setState({ toasts: [] });
		mockEditor({
			hook_show: () => BUILTIN_LSP,
			hook_set_settings: () => ({ success: false, output: "project not found" }),
		});
		renderEditor("/hook/lsp-report");
		await screen.findByRole("table", { name: "lsp-report languages" });
		// Switch to a project scope (global is read-only for a builtin) then
		// toggle a language to trigger a settings save.
		const scopeSelect = screen.getByLabelText("settings scope");
		fireEvent.change(scopeSelect, { target: { value: "example-app" } });
		fireEvent.click(screen.getByLabelText("python enabled"));
		await waitFor(() => {
			const toasts = useAppStore.getState().toasts;
			expect(toasts.some((t) => t.kind === "error")).toBe(true);
		});
	});
});

const USER_HOOK_CODEX_ONLY = {
	name: "codex-only-hook",
	provenance: "user",
	event: "PostToolUse",
	command: "./notify.sh",
	description: "",
	tools: ["Edit"],
	matcher: "",
	timeout: null,
	// Scoped to codex only — codex is NOT installed in this test's harness_list
	// mock, so no affinity chip renders for it; editing an INSTALLED harness's
	// chip must never silently drop this.
	harnesses: ["codex"],
	settings: {},
	attached_global: true,
	attached_projects: [],
	project_settings: {},
	reach: {},
};

describe("HookEditor — affinity preservation", () => {
	it("toggling an installed harness's chip never drops affinity for a harness that isn't installed", async () => {
		mockEditor({
			hook_show: () => USER_HOOK_CODEX_ONLY,
			harness_list: () => [
				{ id: "claude-code", label: "Claude Code", installed: true, on_globally: true, used_by_projects: [] },
				{ id: "codex", label: "Codex", installed: false, on_globally: false, used_by_projects: [] },
			],
			hook_edit: (args) => ({ success: true, output: JSON.stringify(args) }),
		});
		renderEditor("/hook/codex-only-hook");

		// Only claude-code renders a chip (codex isn't installed) — toggle it on.
		const chip = await screen.findByRole("button", { name: "Claude Code" });
		fireEvent.click(chip);

		fireEvent.keyDown(window, { key: "s", metaKey: true });
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"hook_edit",
				expect.objectContaining({
					harnesses: expect.arrayContaining(["codex", "claude-code"]),
				}),
			);
		});
	});
});
