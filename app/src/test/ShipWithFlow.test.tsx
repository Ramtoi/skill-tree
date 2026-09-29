// Wave 4c unit 3 (plans/3.md §5 Unit 3, §7 T14) — the shared "Ship this with
// a skill…" host, exercised end to end through `useShipWith()` +
// `shipWith.element` (never mounting `ShipWithFlow` with hand-built props —
// the point is proving the HOST, hook and flow together, behaves the way a
// real screen's row action will see it).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import {
	renderWithProviders,
	sampleRegistry,
	primeRegistry,
	makeQueryClient,
	mockCommands,
	type CommandRecorder,
} from "./helpers";
import { useShipWith, useShipWithStoreForTests } from "@/hooks/useShipWith";
import type { ShipWithTarget } from "@/lib/shipWith";
import type { HookListResult } from "@/hooks/useHooks";
import type { Registry } from "@/types";

/** Grill #19 — `harnesses_global` carries `pi` alongside the two
 *  agent-capable harnesses, so a fixture that happened to only ever see
 *  claude-code/codex could not silently be the reason `pi` never appears. */
const REGISTRY: Registry = {
	...sampleRegistry,
	harnesses_global: ["claude-code", "codex", "pi"],
	skills: {
		...sampleRegistry.skills,
		"orchestrate-advanced": {
			...sampleRegistry.skills.brainstorm,
			ships_with: {
				agents: ["orch-implementer"],
				hooks: [{ ref: "lint-report", name: "lint-report" }],
				permissions: { deny: [] },
			},
		},
	},
};

const CLAUDE_AGENTS = [
	{
		name: "orch-implementer",
		file: "",
		relpath: "",
		description: "Implements the plan.",
		model: "sonnet",
		tools_mode: "all" as const,
		tools: [],
		disallowed_tools: [],
		skills: [],
		color: "",
		disabled: false,
		builtin: false,
		valid: true,
		warnings: [],
	},
	{
		name: "orch-new-agent",
		file: "",
		relpath: "",
		description: "Not declared yet.",
		model: "sonnet",
		tools_mode: "all" as const,
		tools: [],
		disallowed_tools: [],
		skills: [],
		color: "",
		disabled: false,
		builtin: false,
		valid: true,
		warnings: [],
	},
];

const CODEX_AGENTS: typeof CLAUDE_AGENTS = [];

const HOOK_LIST: HookListResult = {
	reach: {},
	hooks: [
		{
			name: "lint-report",
			provenance: "builtin",
			event: "PostToolUse",
			command: "scripts/lint.sh",
			description: "",
			tools: [],
			matcher: "",
			timeout: null,
			harnesses: null,
			settings: {},
			attached_global: false,
			attached_projects: [],
		},
		{
			name: "scope-guard",
			provenance: "user",
			event: "PreToolUse",
			command: "scripts/scope-guard.sh",
			description: "",
			tools: [],
			matcher: "",
			timeout: null,
			harnesses: null,
			settings: {},
			attached_global: false,
			attached_projects: [],
		},
	],
};

const HOOK_TARGET: ShipWithTarget = { kind: "hook", name: "scope-guard" };
const AGENT_TARGET: ShipWithTarget = {
	kind: "agent",
	name: "orch-new-agent",
	sourceHarness: "claude-code",
	scope: "user",
};
// R1(b) belt-and-braces — a project-scope agent seed reaching `ShipWithFlow`
// directly (bypassing whatever gate the caller SHOULD have applied) must
// still be refused honestly, never rendered into a sheet with no row for it.
const PROJECT_AGENT_TARGET: ShipWithTarget = { ...AGENT_TARGET, scope: "project" };

let recorder: CommandRecorder;

function hubCmdCalls() {
	return recorder.of("hub_cmd").map((args) => (args as { args: string[] }).args);
}

function subagentListHarnesses() {
	return recorder
		.of("subagent_list")
		.map((args) => (args as { harnessId?: string } | undefined)?.harnessId);
}

function mockInvoke() {
	recorder = mockCommands({
		read_registry: REGISTRY,
		hub_cmd: (args: unknown) => {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "set") {
				return {
					success: true,
					output: JSON.stringify({
						ok: true,
						skill: cmdArgs[3],
						block: { agents: [], hooks: [], permissions: {} },
						reconcile: { projects: {} },
					}),
				};
			}
			return { success: true, output: "" };
		},
		hook_list: HOOK_LIST,
		subagent_list: (args: unknown) => {
			const harnessId = (args as { harnessId?: string } | undefined)?.harnessId;
			return {
				scope: "user",
				project: null,
				agents_dir: "/home/test/.claude/agents",
				settings_path: "/home/test/.claude/settings.json",
				agents: harnessId === "codex" ? CODEX_AGENTS : CLAUDE_AGENTS,
				builtins: [],
			};
		},
	});
}

/** A minimal test-only caller: two buttons that fire `shipWith.open(...)`
 *  with whatever target/skill the test wants, plus the rendered flow —
 *  exactly the shape `<Button onClick={() => shipWith.open(...)}>` +
 *  `{shipWith.element}` a real screen wires (plans/3.md §3.4). */
function Harness({ second }: { second?: ShipWithTarget }) {
	const shipWith = useShipWith();
	return (
		<div>
			<button onClick={() => shipWith.open(HOOK_TARGET, "orchestrate-advanced")}>
				open-known-hook
			</button>
			<button onClick={() => shipWith.open(AGENT_TARGET, "orchestrate-advanced")}>
				open-known-agent
			</button>
			<button onClick={() => shipWith.open(PROJECT_AGENT_TARGET, "orchestrate-advanced")}>
				open-known-project-agent
			</button>
			<button onClick={() => shipWith.open(HOOK_TARGET)}>open-unknown</button>
			{second && <button onClick={() => shipWith.open(second)}>open-second</button>}
			{shipWith.element}
		</div>
	);
}

function renderHarness(second?: ShipWithTarget) {
	const client = makeQueryClient();
	primeRegistry(client, REGISTRY);
	return renderWithProviders(<Harness second={second} />, { client });
}

beforeEach(() => {
	useShipWithStoreForTests.setState({ stage: "closed", target: null, skill: null });
	mockInvoke();
});

describe("useShipWith + ShipWithFlow", () => {
	it("opening with a known skill goes straight to the sheet — no picker in the DOM", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-known-hook"));
		await screen.findByText("Edit companions · orchestrate-advanced");
		expect(screen.queryByText("Ship this with a skill…")).not.toBeInTheDocument();
	});

	it("opening without a skill renders the picker, and only THEN the sheet", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-unknown"));
		await screen.findByText("Ship this with a skill…");
		expect(screen.queryByText(/^Edit companions ·/)).not.toBeInTheDocument();

		// Eligible: brainstorm, orchestrate-advanced, rt-android-expert.
		// Blocked (dropped, not listed): fs-mcp (mcp-server), android-compose-ui
		// (managed: external).
		expect(screen.getByTestId("ship-with-picker-blocked")).toHaveTextContent("2 skills");
		const row = await screen.findByRole("option", { name: "brainstorm" });
		fireEvent.click(row);

		await screen.findByText("Edit companions · brainstorm");
		expect(screen.queryByText("Ship this with a skill…")).not.toBeInTheDocument();
	});

	it("the sheet opens with the target hook row aria-selected + data-seeded, and is dirty at open", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-known-hook"));
		await screen.findByText("Edit companions · orchestrate-advanced");

		const row = await screen.findByRole("option", { name: /scope-guard/ });
		await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
		await waitFor(() => expect(row).toHaveAttribute("data-seeded", "true"));

		// Dirty at open (§3.3): closing raises the discard question rather than
		// dropping the staged seed silently.
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await screen.findByText("Discard companion edits?");
	});

	it("R1(b) — a project-scope agent seed is refused honestly, never rendering the sheet", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-known-project-agent"));

		await waitFor(() =>
			expect(useShipWithStoreForTests.getState().stage).toBe("closed"),
		);
		expect(screen.queryByText("Edit companions · orchestrate-advanced")).not.toBeInTheDocument();
		expect(screen.queryByText("Ship this with a skill…")).not.toBeInTheDocument();
	});

	it("an agent seed's Save carries from: {harness: sourceHarness} — never pi (grill #19)", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-known-agent"));
		await screen.findByText("Edit companions · orchestrate-advanced");
		await screen.findByRole("option", { name: "orch-new-agent" });

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(hubCmdCalls().length).toBeGreaterThan(0));

		const setCall = hubCmdCalls().find(
			(a) => a[0] === "skill" && a[1] === "companions" && a[2] === "set",
		);
		expect(setCall).toBeTruthy();
		const bodyIdx = (setCall as string[]).indexOf("--json-body");
		const block = JSON.parse((setCall as string[])[bodyIdx + 1]) as {
			agents: { name: string; from?: { harness: string } }[];
		};
		const seeded = block.agents.find((a) => a.name === "orch-new-agent");
		expect(seeded?.from).toEqual({ harness: "claude-code" });

		// The registry's own `harnesses_global` includes `pi`, but `pi` has no
		// agents_dir / sub-agent surface — `useCompanionPickerData` only ever
		// asks claude-code and codex, regardless of what the project turns on.
		expect(subagentListHarnesses()).not.toContain("pi");
		expect(block.agents.every((a) => a.from?.harness !== "pi")).toBe(true);
	});

	it("a second flow while one is open is refused honestly — the first flow stays exactly as it was", async () => {
		const second: ShipWithTarget = { kind: "hook", name: "lint-report" };
		renderHarness(second);
		fireEvent.click(screen.getByText("open-known-hook"));
		await screen.findByText("Edit companions · orchestrate-advanced");

		fireEvent.click(screen.getByText("open-second"));

		// Still the SAME sheet — no picker opened underneath/instead, no crash,
		// nothing silently retargeted.
		expect(screen.getByText("Edit companions · orchestrate-advanced")).toBeInTheDocument();
		expect(screen.queryByText("Ship this with a skill…")).not.toBeInTheDocument();
	});

	it("close() resets the host so a later open works again", async () => {
		renderHarness();
		fireEvent.click(screen.getByText("open-known-hook"));
		await screen.findByText("Edit companions · orchestrate-advanced");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
		await waitFor(() =>
			expect(screen.queryByText("Edit companions · orchestrate-advanced")).not.toBeInTheDocument(),
		);

		fireEvent.click(screen.getByText("open-unknown"));
		await screen.findByText("Ship this with a skill…");
	});
});
