import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, makeQueryClient } from "./helpers";
import { HooksScreen } from "@/screens/HooksScreen";
import { useShipWithStoreForTests } from "@/hooks/useShipWith";
import type { Registry } from "@/types";

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

function mockHooks(
	hooks: unknown[],
	caps: unknown = CAPS,
	doctor: unknown = { findings: [], danger_count: 0 },
) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "hook_list") return Promise.resolve({ hooks, reach: {} });
		if (cmd === "hook_capabilities") return Promise.resolve(caps);
		if (cmd === "hook_doctor") return Promise.resolve(doctor);
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

// Wave 4c unit 4 — the shared "Ship with…" host is a module-level store;
// reset it before every test in this file so a flow left open by one test
// never leaks into the next.
beforeEach(() => {
	useShipWithStoreForTests.setState({ stage: "closed", target: null, skill: null });
});

describe("HooksScreen", () => {
	beforeEach(() => {
		mockHooks(HOOKS);
	});

	it("renders a row with name, event, tools, provenance and reach badges", async () => {
		renderScreen();
		// Name (mono) + event tag.
		const lspName = await screen.findByText("lsp-report");
		expect(lspName).toBeInTheDocument();
		expect(screen.getByText("PostToolUse")).toBeInTheDocument();
		// Tools chips.
		expect(screen.getByText("Edit")).toBeInTheDocument();
		expect(screen.getByText("Write")).toBeInTheDocument();
		// Provenance badges — pinned to THEIR OWN row, not just present
		// somewhere in the DOM: a swap (builtin <-> user) must fail this.
		const lspRow = lspName.closest(".hook-row") as HTMLElement;
		expect(within(lspRow).getByText("builtin")).toBeInTheDocument();
		const notifyRow = screen.getByText("notify-on-stop").closest(".hook-row") as HTMLElement;
		expect(within(notifyRow).getByText("user")).toBeInTheDocument();
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

	it("flags a script hook with its action discriminator and leaves command rows unlabelled", async () => {
		// hook-editor-redesign D3: `command` is the default and needs no badge,
		// but a script hook runs a FILE — the library must not read identically
		// to a one-liner hook.
		mockHooks([
			{ ...HOOKS[1], name: "fmt", action: "script:managed" },
			{ ...HOOKS[1], name: "repo-lint", action: "script:repo" },
			{ ...HOOKS[1], action: "command" },
		]);
		renderScreen();
		await screen.findByText("fmt");
		expect(screen.getByText("script:managed")).toBeInTheDocument();
		expect(screen.getByText("script:repo")).toBeInTheDocument();
		expect(screen.queryByText("command")).toBeNull();
	});

	it("falls back to the script block when an older CLI omits `action`", async () => {
		mockHooks([
			{
				...HOOKS[1],
				name: "fmt",
				script: { source: "managed", interpreter: "bash" },
			},
		]);
		renderScreen();
		expect(await screen.findByText("script:managed")).toBeInTheDocument();
	});

	it("shows the global attach chip and does not also list projects", async () => {
		// hooks-screen-polish Wave A: global wins outright even when a stray
		// attached_projects list is also present (should never happen, but the
		// row must still not misdescribe it as project-scoped).
		mockHooks([
			{ ...HOOKS[0], attached_global: true, attached_projects: ["example-app"] },
		]);
		renderScreen();
		expect(await screen.findByText("global")).toBeInTheDocument();
		expect(screen.getByText("global")).toHaveAttribute(
			"title",
			"Attached everywhere (hooks_global)",
		);
		expect(screen.queryByText(/project/)).toBeNull();
	});

	it("shows an N-project attach chip with a title carrying the project names", async () => {
		mockHooks([
			{
				...HOOKS[1],
				attached_global: false,
				attached_projects: ["example-app", "other-app"],
			},
		]);
		renderScreen();
		const chip = await screen.findByText("2 projects");
		expect(chip).toHaveAttribute("title", "example-app, other-app");
	});

	it("shows a singular 1-project attach chip", async () => {
		mockHooks([HOOKS[1]]);
		renderScreen();
		const chip = await screen.findByText("1 project");
		expect(chip).toHaveAttribute("title", "example-app");
	});

	it("shows unattached when attached nowhere", async () => {
		mockHooks([{ ...HOOKS[1], attached_global: false, attached_projects: [] }]);
		renderScreen();
		const chip = await screen.findByText("unattached");
		expect(chip).toHaveAttribute(
			"title",
			"Attached nowhere — it never runs",
		);
	});

	it("shows the runs line for a command hook", async () => {
		mockHooks([{ ...HOOKS[1], command: "say done" }]);
		renderScreen();
		const runs = await screen.findByTitle("say done");
		expect(runs).toHaveTextContent("say done");
	});

	it("shows the runs line for a managed script hook", async () => {
		mockHooks([
			{
				...HOOKS[1],
				command: "",
				script: { source: "managed", interpreter: "bash", args: "--fix" },
			},
		]);
		renderScreen();
		expect(await screen.findByText("bash script.sh --fix")).toBeInTheDocument();
	});

	it("shows the runs line for a repo script hook", async () => {
		mockHooks([
			{
				...HOOKS[1],
				command: "",
				script: {
					source: "repo",
					interpreter: "python3",
					path: "scripts/lint.py",
					args: null,
				},
			},
		]);
		renderScreen();
		expect(
			await screen.findByText("python3 scripts/lint.py"),
		).toBeInTheDocument();
	});

	it("navigates to the create flow from the New hook button", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		fireEvent.click(screen.getByRole("button", { name: "New hook" }));
		await waitFor(() =>
			expect(screen.getByText(/^EDITOR:/)).toBeInTheDocument(),
		);
	});

	// ─── Wave C: doctor health badge ────────────────────────────────────────

	it("shows no health badge when the hook is clean", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		expect(screen.queryByText(/warning|danger|finding/i)).toBeNull();
	});

	it("shows a single-severity badge with a count and a joined-detail tooltip", async () => {
		mockHooks(HOOKS, CAPS, {
			danger_count: 0,
			findings: [
				{
					hook: "lsp-report",
					scope: "global",
					harness: "claude-code",
					code: "LSP_CHECKER_MISSING",
					severity: "info",
					explanation: "checker missing",
					detail: "lsp-report [claude-code]: typescript checker 'tsc' not found on PATH",
				},
			],
		});
		renderScreen();
		const label = await screen.findByText("1 info");
		const badge = label.closest(".status-badge");
		expect(badge).toHaveAttribute(
			"title",
			"lsp-report [claude-code]: typescript checker 'tsc' not found on PATH",
		);
	});

	it("labels a mixed-severity hook 'N findings' using the worst channel, and leaves other hooks unbadged", async () => {
		mockHooks(HOOKS, CAPS, {
			danger_count: 1,
			findings: [
				{
					hook: "lsp-report",
					scope: "global",
					harness: "claude-code",
					code: "HOOK_RUNS_SUDO",
					severity: "danger",
					explanation: "runs sudo",
					detail: "lsp-report (PostToolUse): sudo x",
				},
				{
					hook: "lsp-report",
					scope: "global",
					harness: "claude-code",
					code: "LSP_CHECKER_MISSING",
					severity: "info",
					explanation: "checker missing",
					detail: "lsp-report [claude-code]: python checker 'ruff' not found on PATH",
				},
			],
		});
		renderScreen();
		const label = await screen.findByText("2 findings");
		const badge = label.closest(".status-badge");
		expect(badge).toHaveAttribute(
			"title",
			"lsp-report (PostToolUse): sudo x\nlsp-report [claude-code]: python checker 'ruff' not found on PATH",
		);
		// notify-on-stop carries no findings — no badge text anywhere near it.
		const notifyRow = screen.getByText("notify-on-stop").closest(".hook-row");
		expect(notifyRow?.textContent).not.toMatch(/finding|danger|warning|info/i);
	});
});

// ─── T16 (wave 4c unit 4, plans/3.md §2.3/§5) — the reverse-link row action:
// a row whose hook is already shipped by a skill shows the interactive tag
// naming that skill (no separate button); a row with no such skill shows the
// ghost "Ship with…" button instead. Clicking either opens the shared flow
// (seeded with a hook target) and never navigates to `/hook/:name` — the
// shipped-but-dead / accidental-navigation failure mode this repo has hit.

const SKILL_NAME = "orchestrate-advanced";

function registryShippingHook(hookName: string): Registry {
	return {
		version: "1",
		skills: {
			[SKILL_NAME]: {
				version: "0.1.0",
				description: "Deep orchestrator with guardrails.",
				source: "~/skill-hub/skills/orchestrate-advanced",
				type: "claude-skill",
				scope: "portable",
				upstream: null,
				ships_with: {
					hooks: [{ ref: hookName, name: hookName }],
				},
			},
		},
		projects: {},
		bundles: {},
	};
}

function mockHooksWithRegistry(hooks: unknown[], registry: Registry) {
	const prev = vi.mocked(invoke).getMockImplementation();
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "hook_list") return Promise.resolve({ hooks, reach: {} });
		if (cmd === "hook_capabilities") return Promise.resolve(CAPS);
		if (cmd === "hook_doctor") return Promise.resolve({ findings: [], danger_count: 0 });
		if (cmd === "read_registry") return Promise.resolve(registry);
		return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
	}) as never);
}

describe("HooksScreen ship-with action (T16)", () => {
	beforeEach(() => {
		mockHooksWithRegistry(HOOKS, registryShippingHook("lsp-report"));
	});

	it("a row whose hook is already shipped shows the interactive tag naming that skill, and no ghost button", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		const row = screen.getByText("lsp-report").closest(".hook-row") as HTMLElement;
		const tag = within(row).getByTestId("companion-tag");
		expect(tag.tagName).toBe("BUTTON");
		expect(tag.getAttribute("data-word")).toBe("shipped by");
		expect(tag.getAttribute("data-skill")).toBe(SKILL_NAME);
		expect(within(row).queryByTestId("ship-with-open")).not.toBeInTheDocument();
	});

	it("clicking the interactive tag opens the flow seeded with a hook target — no navigation", async () => {
		renderScreen();
		await screen.findByText("lsp-report");
		const row = screen.getByText("lsp-report").closest(".hook-row") as HTMLElement;
		fireEvent.click(within(row).getByTestId("companion-tag"));

		expect(useShipWithStoreForTests.getState()).toMatchObject({
			stage: "sheet",
			target: { kind: "hook", name: "lsp-report" },
			skill: SKILL_NAME,
		});
		expect(screen.queryByText(/^EDITOR:/)).not.toBeInTheDocument();
	});

	it("a row with no shipping skill shows the ghost button instead of a tag", async () => {
		renderScreen();
		await screen.findByText("notify-on-stop");
		const row = screen.getByText("notify-on-stop").closest(".hook-row") as HTMLElement;
		expect(within(row).queryByTestId("companion-tag")).not.toBeInTheDocument();
		expect(
			within(row).getByRole("button", { name: "Ship with…" }),
		).toBeInTheDocument();
	});

	it("clicking the ghost button opens the flow (no known skill yet) — no navigation", async () => {
		renderScreen();
		await screen.findByText("notify-on-stop");
		const row = screen.getByText("notify-on-stop").closest(".hook-row") as HTMLElement;
		fireEvent.click(within(row).getByTestId("ship-with-open"));

		expect(useShipWithStoreForTests.getState()).toMatchObject({
			stage: "picker",
			target: { kind: "hook", name: "notify-on-stop" },
			skill: null,
		});
		expect(screen.queryByText(/^EDITOR:/)).not.toBeInTheDocument();
	});
});
