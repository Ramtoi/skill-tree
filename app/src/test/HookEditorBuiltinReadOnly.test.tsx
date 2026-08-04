import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { HookEditor } from "@/screens/HookEditor";
import { useAppStore } from "@/store";

// Built-in read-only enforcement BEYOND command+event (which HookEditor.test.tsx
// already covers). The CLI rejects a core edit to a built-in, so any control that
// stays live produces an edit that looks accepted, vanishes on refetch, and — if
// the save button also re-enables — lands as an opaque CLI error toast. The
// coreReadOnly guards inside toggleTool/toggleAffinity had no test driving them.

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
	timeout: 30,
	harnesses: null,
	settings: { languages: { python: { enabled: true, mode: "advisory" } } },
	attached_global: true,
	attached_projects: [] as string[],
	project_settings: {},
	reach: {},
};

const HARNESSES = [
	{
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		used_by_projects: [],
	},
	{
		id: "codex",
		label: "Codex",
		installed: true,
		on_globally: false,
		used_by_projects: [],
	},
];

function mockEditor(over: Record<string, (args?: unknown) => unknown> = {}) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return Promise.resolve(sampleRegistry);
		if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
		if (cmd === "harness_list") return Promise.resolve(HARNESSES);
		if (over[cmd]) return Promise.resolve(over[cmd](args));
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

function renderBuiltin(over: Record<string, (args?: unknown) => unknown> = {}) {
	mockEditor({ hook_show: () => BUILTIN_LSP, ...over });
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
			<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
		</Routes>,
		{ initialRoute: "/hook/lsp-report", client: makeQueryClient() },
	);
}

describe("HookEditor — built-in core fields are inert everywhere", () => {
	beforeEach(() => {
		useAppStore.setState({ toasts: [], harnesses: HARNESSES });
	});

	it("the tools toggles are disabled and clicking one changes nothing", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		const editToggle = screen.getByRole("checkbox", { name: "Edit" });
		expect(editToggle).toBeDisabled();
		expect(editToggle).toBeChecked();
		const readToggle = screen.getByRole("checkbox", { name: "Read" });
		expect(readToggle).toBeDisabled();
		expect(readToggle).not.toBeChecked();

		// Even forcing the change through (bypassing the disabled attribute the
		// way a regression to a plain button would) must not mark the form dirty.
		fireEvent.click(readToggle);
		expect(screen.getByRole("checkbox", { name: "Read" })).not.toBeChecked();
		expect(screen.queryByText("UNSAVED")).toBeNull();
	});

	it("the raw matcher and timeout inputs are read-only", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		expect((screen.getByLabelText("raw matcher") as HTMLInputElement).readOnly).toBe(
			true,
		);
		const timeoutInput = screen.getByLabelText("timeout") as HTMLInputElement;
		expect(timeoutInput.readOnly).toBe(true);
		expect(timeoutInput.value).toBe("30");
	});

	it("the harness affinity chips are disabled and never go dirty", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		const chip = screen.getByRole("button", { name: /Claude Code/ });
		expect(chip).toBeDisabled();
		expect(chip).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(chip);
		expect(screen.queryByText("UNSAVED")).toBeNull();
	});

	it("Save is soft-disabled and explains why (discoverable, still focusable)", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toHaveAttribute("aria-disabled", "true");
		expect(save).toHaveAttribute(
			"title",
			"Built-in command/event are read-only — edit its settings below.",
		);
		fireEvent.click(save);
		await waitFor(() =>
			expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
				"hook_edit",
				expect.anything(),
			),
		);
	});

	it("⌘S is a no-op for a built-in", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		fireEvent.keyDown(window, { key: "s", metaKey: true });
		fireEvent.keyDown(window, { key: "s", ctrlKey: true });
		await waitFor(() =>
			expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
				"hook_edit",
				expect.anything(),
			),
		);
		expect(useAppStore.getState().toasts).toEqual([]);
	});

	it("a USER hook keeps all of the same controls live (the guard is provenance-driven)", async () => {
		mockEditor({
			hook_show: () => ({
				...BUILTIN_LSP,
				name: "notify-on-stop",
				provenance: "user",
			}),
		});
		renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/notify-on-stop", client: makeQueryClient() },
		);

		await screen.findByLabelText("command");
		expect(screen.getByRole("checkbox", { name: "Read" })).not.toBeDisabled();
		expect((screen.getByLabelText("raw matcher") as HTMLInputElement).readOnly).toBe(
			false,
		);
		expect((screen.getByLabelText("timeout") as HTMLInputElement).readOnly).toBe(
			false,
		);
		expect(screen.getByRole("button", { name: /Claude Code/ })).not.toBeDisabled();
		// Save starts hard-disabled (nothing dirty yet) with no read-only excuse.
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		expect(save).not.toHaveAttribute("aria-disabled");

		fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
	});
});
