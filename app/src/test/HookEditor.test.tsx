import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient, sampleRegistry } from "./helpers";
import { expectOnlySidePanelSections } from "./helpers/disclosureGuard";
import { HookEditor } from "@/screens/HookEditor";
import { skillBackTarget } from "@/lib/backTarget";
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

/** D14/F15: widened to accept a `{ pathname, state }` entry — `helpers.tsx`'s
 *  `renderWithProviders` already supports it — so a referrer test can seed
 *  history `state` without a real navigation. */
function renderEditor(route: string | { pathname: string; state?: unknown }) {
	return renderWithProviders(
		<Routes>
			<Route path="/hook/:name" element={<HookEditor />} />
			<Route path="/hooks" element={<div>HOOKS-LIST</div>} />
			<Route path="/skill/:name" element={<div>SKILL-EDITOR</div>} />
		</Routes>,
		{ initialRoute: route, client: makeQueryClient() },
	);
}

describe("HookEditor — create mode", () => {
	it("populates the event picker, and the tools picker (incl. MCP tools) behind Specific tools", async () => {
		mockEditor();
		renderEditor("/hook/new");
		// Event picker seeded from the canonical vocabulary.
		const eventSelect = await screen.findByLabelText("event");
		expect(eventSelect).toBeInTheDocument();
		fireEvent.click(eventSelect);
		expect(
			screen.getByRole("option", { name: /^PostToolUse\b/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /^SessionStart\b/ }),
		).toBeInTheDocument();
		fireEvent.keyDown(eventSelect, { key: "Escape" });

		// D2: create mode opens on "All tools" — the ~50-checkbox wall is NOT the
		// first thing a new user sees, and nothing claims a tool filter is set.
		expect(screen.queryByRole("checkbox", { name: "Bash" })).toBeNull();
		expect(screen.getByRole("radio", { name: "All tools" })).toBeChecked();

		fireEvent.click(screen.getByRole("radio", { name: "Specific tools" }));
		// The curated Common group is open by default; the rest is one click away.
		expect(screen.getByRole("checkbox", { name: "Bash" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Edit" })).toBeInTheDocument();
		// The registry's mcp-server token lives in the (collapsed) MCP group and
		// is reachable by typing — a collapse must never hide a real token.
		expect(screen.queryByRole("checkbox", { name: "mcp__fs-mcp" })).toBeNull();
		fireEvent.change(screen.getByPlaceholderText("Filter tools…"), {
			target: { value: "mcp__fs" },
		});
		expect(
			screen.getByRole("checkbox", { name: "mcp__fs-mcp" }),
		).toBeInTheDocument();
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
	it("renders command and event as read-only SUMMARY rows for a built-in, settings still editable", async () => {
		mockEditor({ hook_show: () => BUILTIN_LSP });
		renderEditor("/hook/lsp-report");

		// D5: a built-in reads as a summary, not a form full of dead controls —
		// the values are plain text, and there is no editable control at all.
		const cmd = await screen.findByLabelText("command");
		expect(cmd.tagName).not.toBe("TEXTAREA");
		expect(cmd).toHaveTextContent("python3 lsp_report.py");
		const ev = screen.getByLabelText("event");
		expect(ev.tagName).not.toBe("SELECT");
		expect(ev).toHaveTextContent("PostToolUse");

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
		fireEvent.click(screen.getByLabelText("settings scope"));
		fireEvent.click(screen.getByRole("option", { name: "project: example-app" }));
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
		// Global defaults are read-only for a built-in — switch to a project scope
		// so the mode select is interactive (a disabled `Select` never opens).
		fireEvent.click(screen.getByLabelText("settings scope"));
		fireEvent.click(screen.getByRole("option", { name: "project: example-app" }));
		// Mode select options use the honest labels.
		fireEvent.click(screen.getByLabelText("python mode"));
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
		fireEvent.click(screen.getByLabelText("settings scope"));
		fireEvent.click(screen.getByRole("option", { name: "project: example-app" }));
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
	it("toggling an installed harness never drops affinity for a harness that isn't installed", async () => {
		mockEditor({
			hook_show: () => USER_HOOK_CODEX_ONLY,
			harness_list: () => [
				{ id: "claude-code", label: "Claude Code", installed: true, on_globally: true, used_by_projects: [] },
				{ id: "codex", label: "Codex", installed: false, on_globally: false, used_by_projects: [] },
			],
			hook_edit: (args) => ({ success: true, output: JSON.stringify(args) }),
		});
		renderEditor("/hook/codex-only-hook");

		// D1: the harness panel merges the affinity toggle and the reach status
		// into one row per harness — a `MultiSelectList` `role="option"` (its
		// accessible name also carries the reach status word, so anchor on the
		// harness name with `\b` rather than match it exactly). Turn claude-code ON.
		const toggle = await screen.findByRole("option", { name: /^Claude Code\b/ });
		fireEvent.click(toggle);

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

	it("a harness the hook targets but that isn't installed still gets an honest row", async () => {
		const harnesses = [
			{ id: "claude-code", label: "Claude Code", installed: true, on_globally: true, used_by_projects: [] },
			{ id: "codex", label: "Codex", installed: false, on_globally: false, used_by_projects: [] },
		];
		// The harness list is a Zustand cache that only rescans when empty, so it
		// has to be seeded directly for this assertion to be deterministic.
		useAppStore.setState({ harnesses: harnesses as never });
		mockEditor({
			hook_show: () => USER_HOOK_CODEX_ONLY,
			harness_list: () => harnesses,
		});
		renderEditor("/hook/codex-only-hook");

		// Hiding it is exactly how the affinity silently gets dropped on save.
		const codex = await screen.findByRole("option", { name: /^Codex\b/ });
		expect(codex).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("(not installed)")).toBeInTheDocument();
	});
});

// ─── D4: hierarchy + the live summary line ────────────────────────────────────

describe("HookEditor — hierarchy and the live summary (D4/D5)", () => {
	it("renders a summary that RECOMPUTES as the form changes", async () => {
		mockEditor();
		renderEditor("/hook/new");

		const summary = await screen.findByLabelText("hook summary");
		expect(summary).toHaveTextContent(
			"On PostToolUse · all tools · runs a shell command · every effective harness",
		);

		fireEvent.click(screen.getByLabelText("event"));
		fireEvent.click(screen.getByRole("option", { name: /^SessionStart\b/ }));
		fireEvent.click(screen.getByRole("radio", { name: "Managed script" }));
		// The anchor describes what is ABOUT to be saved, not the server copy.
		expect(screen.getByLabelText("hook summary")).toHaveTextContent(
			"On SessionStart · all tools · runs a managed script",
		);
	});

	it("orders the main column Definition → Action → Applies to", async () => {
		mockEditor();
		const { container } = renderEditor("/hook/new");
		await screen.findByLabelText("event");
		const heads = Array.from(
			container.querySelectorAll(".hook-editor-main h4"),
		).map((h) => h.textContent);
		expect(heads).toEqual(["Definition", "Action", "Applies to"]);
	});

	it("puts Settings directly under Harnesses for a built-in (its only editable surface)", async () => {
		mockEditor({ hook_show: () => BUILTIN_LSP });
		const { container } = renderEditor("/hook/lsp-report");
		await screen.findByLabelText("settings scope");

		const heads = Array.from(
			container.querySelectorAll(".hook-editor-side .side-panel-section-title"),
		).map((h) => h.textContent);
		expect(heads.slice(0, 3)).toEqual(["Harnesses", "Settings", "Advanced"]);
		// …marked by `side-section-primary` (an ornament dot, never a stripe);
		// the scope summary states only the real (read-only) fact about the scope.
		expect(
			container.querySelector(".side-panel-section.side-section-primary"),
		).not.toBeNull();
		expect(screen.getByText(/global default · read-only/)).toBeInTheDocument();
	});

	it("keeps Settings BELOW Advanced for a user hook (the definition is the point there)", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, name: "notify-on-stop", provenance: "user" }),
		});
		const { container } = renderEditor("/hook/notify-on-stop");
		await screen.findByLabelText("settings scope");

		const heads = Array.from(
			container.querySelectorAll(".hook-editor-side .side-panel-section-title"),
		).map((h) => h.textContent);
		expect(heads.slice(0, 3)).toEqual(["Harnesses", "Advanced", "Settings"]);
		expect(
			container.querySelector(".side-panel-section.side-section-primary"),
		).toBeNull();
		// A user hook's own scope is never read-only.
		expect(screen.queryByText(/read-only/)).toBeNull();
	});

	it("names the built-in's action a 'built-in script', not a generic shell command", async () => {
		mockEditor({ hook_show: () => BUILTIN_LSP });
		renderEditor("/hook/lsp-report");
		const summary = await screen.findByLabelText("hook summary");
		expect(summary).toHaveTextContent("runs a built-in script");
		expect(summary).not.toHaveTextContent("runs a shell command");
	});

	// side-panels wave 4: the ONE disclosure grammar — HARNESSES / SETTINGS /
	// ADVANCED are all `SidePanelSection`s, and nothing on this panel hand-rolls
	// its own `aria-expanded` toggle.
	it("the side panel's disclosures are all SidePanelSection, never a hand-rolled toggle", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, name: "notify-on-stop", provenance: "user" }),
		});
		const { container } = renderEditor("/hook/notify-on-stop");
		await screen.findByLabelText("settings scope");

		expectOnlySidePanelSections(
			container.querySelector(".hook-editor-side") as HTMLElement,
			3,
			[
				join(process.cwd(), "src", "screens", "HookEditor.tsx"),
				join(process.cwd(), "src", "components", "hooks", "HookSidePanel.tsx"),
				join(process.cwd(), "src", "components", "hooks", "HookSettingsSection.tsx"),
			],
		);
	});

	// AUDIT m6: the count is 3 only for a SAVED hook — create mode has no
	// `settingsBlock` at all (there is no `hook` yet to attach settings to), so
	// the panel has 2 sections. Guard both shapes, not just the common one.
	it("create mode has exactly 2 disclosures (no SETTINGS — there is no hook yet)", async () => {
		mockEditor();
		const { container } = renderEditor("/hook/new");
		await screen.findByLabelText("event");

		expectOnlySidePanelSections(
			container.querySelector(".hook-editor-side") as HTMLElement,
			2,
			[
				join(process.cwd(), "src", "screens", "HookEditor.tsx"),
				join(process.cwd(), "src", "components", "hooks", "HookSidePanel.tsx"),
				join(process.cwd(), "src", "components", "hooks", "HookSettingsSection.tsx"),
			],
		);
	});
});

// ─── Wave C: doctor health banner ──────────────────────────────────────────

describe("HookEditor — doctor health banner", () => {
	it("renders nothing when the hook has no findings", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, name: "notify-on-stop", provenance: "user" }),
			hook_doctor: () => ({ findings: [], danger_count: 0 }),
		});
		const { container } = renderEditor("/hook/notify-on-stop");
		await screen.findByLabelText("hook summary");
		expect(container.querySelector(".hook-health")).toBeNull();
	});

	it("lists this hook's findings, labelled from the risk-schema mirror when it has an entry", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, name: "notify-on-stop", provenance: "user" }),
			hook_doctor: () => ({
				danger_count: 1,
				findings: [
					{
						hook: "notify-on-stop",
						scope: "global",
						harness: "claude-code",
						code: "HOOK_RUNS_SUDO",
						severity: "danger",
						explanation: "raw explanation",
						detail: "notify-on-stop (Stop): sudo say done",
					},
					// A different hook's finding must never leak into this banner.
					{
						hook: "lsp-report",
						scope: "global",
						harness: "claude-code",
						code: "LSP_CHECKER_MISSING",
						severity: "info",
						explanation: "checker missing",
						detail: "lsp-report [claude-code]: tsc missing",
					},
				],
			}),
			permissions_risks_schema: () => [
				{
					code: "HOOK_RUNS_SUDO",
					severity: "danger",
					explanation: "Hub-managed hooks must not require elevated privileges.",
				},
			],
		});
		const { container } = renderEditor("/hook/notify-on-stop");
		const banner = await screen.findByLabelText("hook health");
		expect(banner.textContent).toContain(
			"Hub-managed hooks must not require elevated privileges.",
		);
		expect(banner.textContent).toContain("notify-on-stop (Stop): sudo say done");
		expect(banner.textContent).not.toContain("lsp-report");
		expect(container.querySelectorAll(".hook-health-row").length).toBe(1);
	});

	it("falls back to the raw code when the risk-schema mirror has no entry for it", async () => {
		mockEditor({
			hook_show: () => ({ ...BUILTIN_LSP, name: "notify-on-stop", provenance: "user" }),
			hook_doctor: () => ({
				danger_count: 0,
				findings: [
					{
						hook: "notify-on-stop",
						scope: "registry",
						harness: "",
						code: "HOOK_SCRIPT_MISSING",
						severity: "warning",
						explanation: "unused",
						detail: "notify-on-stop: managed script missing",
					},
				],
			}),
			permissions_risks_schema: () => [],
		});
		renderEditor("/hook/notify-on-stop");
		const banner = await screen.findByLabelText("hook health");
		expect(banner.textContent).toContain("HOOK_SCRIPT_MISSING");
	});
});

// ─── Wave D: reading + converting the script behind a command hook ───────────

const COMMAND_HOOK_WITH_CONVERSION = {
	name: "lint-on-edit",
	provenance: "user",
	event: "PostToolUse",
	command: "bash scripts/lint.sh --fix",
	description: "Lint the files the agent edits.",
	tools: ["Edit", "Write"],
	matcher: "",
	timeout: null,
	harnesses: null,
	settings: {},
	attached_global: false,
	attached_projects: ["example-app", "moon-base"],
	project_settings: {},
	reach: {},
	command_script: {
		token: "scripts/lint.sh",
		kind: "relative",
		locations: [
			{
				project: "example-app",
				path: "/Users/alice/dev/example-app/scripts/lint.sh",
				exists: true,
				body: "#!/bin/bash\necho lint\n",
				reason: null,
			},
			{
				project: "moon-base",
				path: "/Users/alice/dev/moon-base/scripts/lint.sh",
				exists: false,
				body: null,
				reason: null,
			},
		],
	},
	repo_script_conversion: { interpreter: "bash", path: "scripts/lint.sh", args: "--fix" },
};

describe("HookEditor — convert a command hook to a repo script (Wave D)", () => {
	it("Convert fills the form from repo_script_conversion, marks it UNSAVED, and Save emits the repo script fields", async () => {
		const edits: unknown[] = [];
		mockEditor({
			hook_show: () => COMMAND_HOOK_WITH_CONVERSION,
			hook_edit: (args) => {
				edits.push(args);
				return { success: true, output: "ok" };
			},
		});
		renderEditor("/hook/lint-on-edit");

		await screen.findByRole("button", { name: "Convert to repo script" });
		expect(screen.queryByText("UNSAVED")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Convert to repo script" }));

		// The form switched to Repo script mode and hydrated from the conversion —
		// nothing is saved until the user hits Save.
		expect(screen.getByText("UNSAVED")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Repo script" })).toBeChecked();
		expect((screen.getByLabelText("script path") as HTMLInputElement).value).toBe(
			"scripts/lint.sh",
		);
		expect((screen.getByLabelText("script args") as HTMLInputElement).value).toBe(
			"--fix",
		);
		expect(screen.getByLabelText("script interpreter")).toHaveTextContent("bash");

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(edits.length).toBe(1));
		expect(edits[0]).toMatchObject({
			name: "lint-on-edit",
			scriptSource: "repo",
			scriptInterpreter: "bash",
			scriptPath: "scripts/lint.sh",
			scriptArgs: "--fix",
		});
		// command → repo is not a managed body being dropped — no destructive
		// confirm should ever have appeared.
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("HookEditor — referrer contract (D14)", () => {
	it("a skill referrer makes the header back arrow read the skill and navigate there", async () => {
		mockEditor();
		renderEditor({
			pathname: "/hook/lint-on-edit",
			state: { from: skillBackTarget("orchestrate-advanced") },
		});
		const back = await screen.findByRole("button", { name: "Back to orchestrate-advanced" });
		fireEvent.click(back);
		expect(await screen.findByText("SKILL-EDITOR")).toBeInTheDocument();
	});

	it("the same referrer on the not-found branch — 'Back to <skill>' navigates there", async () => {
		// setup.ts resolves `hook_show` by default (a fake hook for any name) —
		// the not-found branch only fires when the read itself rejects.
		mockEditor({ hook_show: () => Promise.reject(new Error("not found")) });
		renderEditor({
			pathname: "/hook/no-such-hook",
			state: { from: skillBackTarget("orchestrate-advanced") },
		});
		const backBtn = await screen.findByRole("button", { name: "Back to orchestrate-advanced" });
		fireEvent.click(backBtn);
		expect(await screen.findByText("SKILL-EDITOR")).toBeInTheDocument();
	});

	it("no referrer (a deep link) — back still reads Hooks and goes to /hooks", async () => {
		mockEditor();
		renderEditor("/hook/lint-on-edit");
		const back = await screen.findByRole("button", { name: "Back to hooks" });
		fireEvent.click(back);
		expect(await screen.findByText("HOOKS-LIST")).toBeInTheDocument();
	});
});
