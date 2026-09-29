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

const BAKED_LSP_COMMAND =
	"'/Applications/Skill Tree.app/Contents/Resources/python/bin/python3' " +
	"'/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report/lsp_report.py' " +
	"--config '/Users/alice/.skill-hub/state/hooks/lsp-report.global.json'";

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
	baked_command: BAKED_LSP_COMMAND,
	builtin: {
		dir: "/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report",
		files: [
			{
				name: "lsp_report.py",
				path: "/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report/lsp_report.py",
				body: "#!/usr/bin/env python3\n\"\"\"lsp-report body.\"\"\"\nprint('stdlib-only')\n",
			},
			{
				name: "hook.yaml",
				path: "/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report/hook.yaml",
				body: "event: PostToolUse\n",
			},
		],
	},
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

	it("offers NO tools control at all — the matching is a read-only summary (D5)", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		// A disabled checkbox still invites a click that does nothing; the
		// redesign renders a built-in's matching as text instead. The invariant
		// that must survive is that there is NO path to mutating it.
		expect(screen.queryByRole("checkbox", { name: "Edit" })).toBeNull();
		expect(screen.queryByRole("checkbox", { name: "Read" })).toBeNull();
		expect(screen.queryByRole("radio", { name: "Specific tools" })).toBeNull();
		// The tools it DOES match are still stated, so the summary stays honest.
		expect(screen.getByText("Edit")).toBeInTheDocument();
		expect(screen.getByText("MultiEdit")).toBeInTheDocument();
		expect(screen.queryByText("UNSAVED")).toBeNull();
	});

	it("exposes no matcher or timeout INPUT — both render as summary values", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		// This built-in sets no matcher, so no matcher control (or value) exists.
		expect(screen.queryByLabelText("raw matcher")).toBeNull();
		// The timeout is shown, never editable — open the ADVANCED section (closed
		// by default) to see it.
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		expect(screen.queryByLabelText("timeout")).toBeNull();
		expect(screen.getByText("30")).toBeInTheDocument();
	});

	it("no action-mode switcher is offered (a built-in's script is baked)", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");
		expect(screen.queryByRole("radio", { name: "Managed script" })).toBeNull();
		expect(screen.queryByRole("radio", { name: "Repo script" })).toBeNull();
		// And the command itself is text, not a textarea.
		expect(screen.getByLabelText("command").tagName).not.toBe("TEXTAREA");
	});

	it("renders the baked command the harness actually receives (Wave B)", async () => {
		renderBuiltin();
		const runs = await screen.findByLabelText("command");
		expect(runs.textContent).toBe(BAKED_LSP_COMMAND);
		// Never the un-baked template — the real command has interpreter + config
		// paths in it, not the placeholder from hook.yaml.
		expect(runs.textContent).not.toBe(BUILTIN_LSP.command);
	});

	it("offers a file tab per built-in source file, hook.yaml last, first file selected", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		const tabs = screen.getAllByRole("tab", { name: /lsp_report\.py|hook\.yaml/ });
		expect(tabs.map((t) => t.textContent)).toEqual(["lsp_report.py", "hook.yaml"]);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
		const panel = document.getElementById("hook-builtin-source-panel");
		expect(panel).toHaveAttribute("role", "tabpanel");
		expect(tabs[0]).toHaveAttribute("aria-controls", "hook-builtin-source-panel");
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"stdlib-only",
			),
		);
	});

	it("Right/Left arrow keys move the selection between file tabs", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"stdlib-only",
			),
		);

		const first = screen.getByRole("tab", { name: "lsp_report.py" });
		fireEvent.keyDown(first, { key: "ArrowRight" });
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"event: PostToolUse",
			),
		);
		expect(screen.getByRole("tab", { name: "hook.yaml" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tab", { name: "hook.yaml" })).toHaveFocus();

		fireEvent.keyDown(screen.getByRole("tab", { name: "hook.yaml" }), {
			key: "ArrowLeft",
		});
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"stdlib-only",
			),
		);
		expect(screen.getByRole("tab", { name: "lsp_report.py" })).toHaveFocus();
	});

	it("switching tabs swaps the displayed body", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"stdlib-only",
			),
		);

		fireEvent.click(screen.getByRole("tab", { name: "hook.yaml" }));
		await waitFor(() =>
			expect(document.querySelector(".hook-builtin-source .cm-content")?.textContent).toContain(
				"event: PostToolUse",
			),
		);
		expect(
			document.querySelector(".hook-builtin-source .cm-content")?.textContent,
		).not.toContain("stdlib-only");
	});

	it("a null baked_command shows the definition's command with an honest hint", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, baked_command: null }),
		});
		renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/lsp-report", client: makeQueryClient() },
		);
		const runs = await screen.findByLabelText("command");
		// Falls back to the definition's own (un-baked) command.
		expect(runs.textContent).toBe(BUILTIN_LSP.command);
		expect(
			screen.getByText(
				"Could not resolve the baked command — showing the definition's command.",
			),
		).toBeInTheDocument();
	});

	it("a null body shows the unreadable-file fallback instead of an empty editor", async () => {
		mockEditor({
			hook_show: () => ({
				...BUILTIN_LSP,
				builtin: {
					...BUILTIN_LSP.builtin,
					files: [
						{ name: "lsp_report.py", path: "/x/lsp_report.py", body: null },
						BUILTIN_LSP.builtin.files[1],
					],
				},
			}),
		});
		renderWithProviders(
			<Routes>
				<Route path="/hook/:name" element={<HookEditor />} />
			</Routes>,
			{ initialRoute: "/hook/lsp-report", client: makeQueryClient() },
		);
		await screen.findByLabelText("command");
		expect(
			await screen.findByText("Could not read lsp_report.py."),
		).toBeInTheDocument();
		expect(document.querySelector(".hook-builtin-source")).toBeNull();
	});

	it("the harness affinity rows are disabled and never go dirty", async () => {
		renderBuiltin();
		await screen.findByLabelText("command");

		// A `MultiSelectList` `role="option"` row — its accessible name also
		// carries the reach status word, so anchor with `\b` rather than match
		// the harness name exactly.
		const toggle = screen.getByRole("option", { name: /^Claude Code\b/ });
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		expect(toggle).toHaveAttribute("aria-selected", "true");
		// Forcing the change through (the way a regression to a plain button
		// would) must still not mark the form dirty.
		fireEvent.click(toggle);
		expect(screen.getByRole("option", { name: /^Claude Code\b/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
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

		// A user hook gets REAL controls everywhere the built-in got summary text.
		const cmd = (await screen.findByLabelText("command")) as HTMLTextAreaElement;
		expect(cmd.tagName).toBe("TEXTAREA");
		expect(cmd.readOnly).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		expect((screen.getByLabelText("timeout") as HTMLInputElement).readOnly).toBe(
			false,
		);
		expect(screen.getByRole("radio", { name: "Managed script" })).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /^Claude Code\b/ }),
		).not.toHaveAttribute("aria-disabled");
		// This hook carries tools, so it opens in Specific-tools mode with a live
		// picker (the built-in offered none).
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Specific tools" })).toBeChecked(),
		);
		expect(screen.getByRole("checkbox", { name: "Read" })).not.toBeDisabled();
		// Save starts hard-disabled (nothing dirty yet) with no read-only excuse.
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		expect(save).not.toHaveAttribute("aria-disabled");

		fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
	});
});
