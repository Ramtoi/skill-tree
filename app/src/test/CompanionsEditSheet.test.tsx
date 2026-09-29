// Wave 2 (D10/Approach 9, wave C): the rare-path editor. Pickers seed from
// the declared block, the skill's own inline hooks render as removable rows
// distinct from the library picker and restore their exact definition on a
// deselect→reselect (R18), a lossy (non-claude-code) agent copy is marked
// (W13), deselecting a companion the registry ledger already provisioned
// renders a de-provision line (W12), closing with unsaved edits asks first
// instead of discarding silently (R17), a typed rule is added via `Field` +
// `ChipRadios`, Save makes exactly ONE `hub skill companions set
// --json-body` call, an exit-1 `{ok:false,error,field}` surfaces in the form
// instead of throwing (S2), and the same surfacing covers the
// `managed: "external"` refusal.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, sampleRegistry, primeRegistry, makeQueryClient } from "./helpers";
import { CompanionsEditSheet } from "@/components/companions/CompanionsEditSheet";
import { NewHookForm } from "@/components/companions/NewHookForm";
import type { HookListResult } from "@/hooks/useHooks";
import type { ShipsWith } from "@/lib/companions";
import type { CompanionSeed } from "@/lib/shipWith";
import { REGISTRY_WRITE_KEYS } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";

const DECLARED: ShipsWith = {
	agents: ["orch-implementer", "orch-reviewer"],
	hooks: [
		{
			name: "orch-scope-guard",
			event: "PreToolUse",
			tools: ["Edit", "Write"],
			command: "scripts/scope-guard.sh",
			activation: "while-running",
		},
		{ ref: "lint-report", name: "lint-report" },
	],
	permissions: { deny: ["Bash(git push --force:*)"] },
};

const REGISTRY: Registry = {
	...sampleRegistry,
	skills: {
		...sampleRegistry.skills,
		"orchestrate-advanced": {
			...sampleRegistry.skills.brainstorm,
			ships_with: DECLARED,
		},
	},
	projects: {
		...sampleRegistry.projects,
		"notes-vault": {
			path: "/Users/dev/notes-vault",
			bundles: [],
			enabled: ["orchestrate-advanced"],
			companions: {
				"orchestrate-advanced": {
					agents: ["orch-reviewer"],
					hooks: ["lint-report"],
					permissions: [],
				},
			},
		},
	},
};

/** claude-code's user-scope agent list — both declared agents plus one new
 *  candidate (`orch-new-agent`) the picker offers but the block doesn't
 *  declare yet. */
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
		name: "orch-reviewer",
		file: "",
		relpath: "",
		description: "Reviews the diff.",
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

/** codex's own list — only ONE agent exists here and nowhere else, so it's a
 *  lossy (Codex-only) copy candidate (W13). */
const CODEX_AGENTS = [
	{
		name: "orch-codex-only",
		file: "",
		relpath: "",
		description: "Codex-only definition.",
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

/** The hooks library — `orch-scope-guard` is here too (W13's evidence: an
 *  inline hook is mirrored into the library with "Shipped by <skill>"), so
 *  this fixture exercises the exclusion directly rather than assuming it. */
const HOOK_LIST: HookListResult = {
	reach: {},
	hooks: [
		{
			name: "orch-scope-guard",
			provenance: "user",
			event: "PreToolUse",
			command: "scripts/scope-guard.sh",
			description: "Shipped by orchestrate-advanced",
			tools: ["Edit", "Write"],
			matcher: "",
			timeout: null,
			harnesses: null,
			settings: {},
			attached_global: false,
			attached_projects: [],
		},
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
			name: "new-hook-ref",
			provenance: "user",
			event: "PreToolUse",
			command: "scripts/other.sh",
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

function hubCmdCalls() {
	return vi
		.mocked(invoke)
		.mock.calls.filter(([cmd]) => cmd === "hub_cmd")
		.map(([, args]) => (args as { args: string[] }).args);
}

function mockPicker(setResponse?: { success: boolean; output: string }) {
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		// `useRegistry`'s background refetch (staleTime: 0) re-invokes this even
		// though `primeRegistry` already seeded the cache — keep it answering
		// the SAME registry rather than warning react-query with `undefined`.
		if (cmd === "read_registry") return Promise.resolve(REGISTRY);
		if (cmd === "hub_cmd") {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "set") {
				return Promise.resolve(
					setResponse ?? {
						success: true,
						output: JSON.stringify({
							ok: true,
							skill: "orchestrate-advanced",
							block: DECLARED,
							reconcile: { projects: {} },
						}),
					},
				);
			}
			return Promise.resolve({ success: true, output: "" });
		}
		if (cmd === "hook_list") return Promise.resolve(HOOK_LIST);
		if (cmd === "subagent_list") {
			const harnessId = (args as { harnessId?: string } | undefined)?.harnessId;
			const agents = harnessId === "codex" ? CODEX_AGENTS : CLAUDE_AGENTS;
			return Promise.resolve({
				scope: "user",
				project: null,
				agents_dir: "/home/test/.claude/agents",
				settings_path: "/home/test/.claude/settings.json",
				agents,
				builtins: [],
			});
		}
		return Promise.resolve(undefined);
	}) as never);
}

function renderSheet(onClose = vi.fn(), seed?: CompanionSeed) {
	const client = makeQueryClient();
	primeRegistry(client, REGISTRY);
	const utils = renderWithProviders(
		<CompanionsEditSheet
			open
			onClose={onClose}
			skillName="orchestrate-advanced"
			declared={DECLARED}
			seed={seed}
		/>,
		{ client },
	);
	return { ...utils, onClose };
}

beforeEach(() => {
	mockPicker();
});

describe("CompanionsEditSheet", () => {
	it("seeds the agent and hook pickers from the declared block", async () => {
		renderSheet();
		await waitFor(() => {
			expect(screen.getByRole("option", { name: "orch-implementer" })).toBeInTheDocument();
		});
		expect(screen.getByRole("option", { name: "orch-implementer" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("option", { name: "orch-reviewer" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("option", { name: "orch-new-agent" })).toHaveAttribute(
			"aria-selected",
			"false",
		);
		expect(screen.getByRole("option", { name: /lint-report/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("option", { name: /new-hook-ref/ })).toHaveAttribute(
			"aria-selected",
			"false",
		);
	});

	it("lists the skill's own inline hook as a removable row, distinct from the library picker (R18)", async () => {
		renderSheet();
		await waitFor(() => {
			expect(screen.getByRole("option", { name: /lint-report/ })).toBeInTheDocument();
		});
		// It IS a companion — visible, selected, and tagged "inline" — never a
		// second library-ref row under the same name (W13's exclusion still
		// keeps the library picker itself from offering a duplicate).
		const rows = screen.getAllByRole("option", { name: /orch-scope-guard/ });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveAttribute("aria-selected", "true");
		expect(rows[0]).toHaveTextContent("inline");
	});

	it("restores an inline hook's exact definition on deselect→reselect, never a library ref (R18)", async () => {
		renderSheet();
		const row = await screen.findByRole("option", { name: /orch-scope-guard/ });
		fireEvent.click(row); // deselect
		await waitFor(() => expect(row).toHaveAttribute("aria-selected", "false"));
		fireEvent.click(row); // reselect
		await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(hubCmdCalls().length).toBeGreaterThan(0));

		const setCalls = hubCmdCalls().filter(
			(a) => a[0] === "skill" && a[1] === "companions" && a[2] === "set",
		);
		const bodyIdx = setCalls[0].indexOf("--json-body");
		const block = JSON.parse(setCalls[0][bodyIdx + 1]) as {
			hooks: { name: string; ref?: string; event?: string; command?: string }[];
		};
		const restored = block.hooks.find((h) => h.name === "orch-scope-guard");
		expect(restored).toBeTruthy();
		expect(restored?.ref).toBeUndefined();
		expect(restored?.event).toBe("PreToolUse");
		expect(restored?.command).toBe("scripts/scope-guard.sh");
	});

	it("marks a Codex-only agent copy as lossy (W13)", async () => {
		renderSheet();
		const row = await screen.findByRole("option", { name: "orch-codex-only" });
		expect(row).toHaveAttribute("title", expect.stringContaining("tier worker"));
		expect(row).toHaveAttribute("title", expect.stringContaining("codex"));
	});

	it("deselecting a ledgered agent renders its de-provision line, per project (W12)", async () => {
		renderSheet();
		const row = await screen.findByRole("option", { name: "orch-reviewer" });
		fireEvent.click(row);
		await waitFor(() => {
			expect(screen.getByTestId("companions-edit-consequences")).toHaveTextContent(
				"Removing orch-reviewer de-provisions it on notes-vault",
			);
		});
	});

	it("deselecting a ledgered ref hook renders its own de-provision line", async () => {
		renderSheet();
		const row = await screen.findByRole("option", { name: /lint-report/ });
		fireEvent.click(row);
		await waitFor(() => {
			expect(screen.getByTestId("companions-edit-consequences")).toHaveTextContent(
				"Removing lint-report de-provisions it on notes-vault",
			);
		});
		expect(screen.getByTestId("companions-edit-save")).toHaveTextContent(
			"removes 1 on notes-vault",
		);
	});

	it("deselecting a never-ledgered agent renders no consequence line", async () => {
		renderSheet();
		const row = await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(row);
		await waitFor(() => expect(row).toHaveAttribute("aria-selected", "false"));
		expect(screen.queryByTestId("companions-edit-consequences")).toBeNull();
		expect(screen.getByTestId("companions-edit-save")).toHaveTextContent("Save");
		expect(screen.getByTestId("companions-edit-save")).not.toHaveTextContent("removes");
	});

	it("adds a typed rule via the pattern Field + Kind ChipRadios", async () => {
		renderSheet();
		await screen.findByRole("option", { name: "orch-implementer" });
		await userEvent.type(
			screen.getByTestId("companions-edit-rule-pattern"),
			"Bash(gh pr merge:*)",
		);
		await userEvent.click(screen.getByRole("radio", { name: "Ask" }));
		fireEvent.click(screen.getByTestId("companions-edit-rule-add"));
		expect(
			screen.getByTestId("companions-edit-rule-ask:Bash(gh pr merge:*)"),
		).toBeInTheDocument();
	});

	it("removes a typed rule via its own remove control", async () => {
		renderSheet();
		await screen.findByRole("option", { name: "orch-implementer" });
		const denyRow = screen.getByTestId("companions-edit-rule-deny:Bash(git push --force:*)");
		expect(denyRow).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove Bash(git push --force:*)" }),
		);
		expect(
			screen.queryByTestId("companions-edit-rule-deny:Bash(git push --force:*)"),
		).toBeNull();
	});

	it("saves with exactly ONE `skill companions set --json-body` call carrying the edited block", async () => {
		const onClose = vi.fn();
		renderSheet(onClose);
		const newAgentRow = await screen.findByRole("option", { name: "orch-new-agent" });
		fireEvent.click(newAgentRow); // add
		const reviewerRow = screen.getByRole("option", { name: "orch-reviewer" });
		fireEvent.click(reviewerRow); // remove (ledgered — de-provision line appears)
		await waitFor(() => screen.getByTestId("companions-edit-consequences"));

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());

		const setCalls = hubCmdCalls().filter(
			(a) => a[0] === "skill" && a[1] === "companions" && a[2] === "set",
		);
		expect(setCalls).toHaveLength(1);
		const bodyIdx = setCalls[0].indexOf("--json-body");
		const block = JSON.parse(setCalls[0][bodyIdx + 1]) as {
			agents: { name: string; from?: { harness: string } }[];
			hooks: unknown[];
			permissions: { deny: string[] };
		};
		const agentNames = block.agents.map((a) => a.name);
		expect(agentNames).toContain("orch-implementer");
		expect(agentNames).toContain("orch-new-agent");
		expect(agentNames).not.toContain("orch-reviewer");
		// A newly-added agent carries `from` (D9) so the backend knows which
		// harness's definition to copy.
		const added = block.agents.find((a) => a.name === "orch-new-agent");
		expect(added?.from?.harness).toBe("claude-code");
		expect(block.permissions.deny).toEqual(["Bash(git push --force:*)"]);
	});

	it("surfaces an exit-1 {ok:false,error,field} in the form instead of throwing (S2)", async () => {
		mockPicker({
			success: false,
			output: JSON.stringify({ ok: false, error: "'x' is declared twice", field: "hooks" }),
		});
		const onClose = vi.fn();
		renderSheet(onClose);
		await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => {
			expect(screen.getByTestId("companions-edit-error")).toHaveTextContent(
				"'x' is declared twice",
			);
		});
		expect(screen.getByTestId("companions-edit-error")).toHaveTextContent("hooks");
		expect(onClose).not.toHaveBeenCalled();
	});

	it("surfaces the managed-external refusal message the same way", async () => {
		mockPicker({
			success: false,
			output: JSON.stringify({
				ok: false,
				error: "read_only: orchestrate-advanced is managed by its source",
			}),
		});
		const onClose = vi.fn();
		renderSheet(onClose);
		await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => {
			expect(screen.getByTestId("companions-edit-error")).toHaveTextContent(
				"read_only: orchestrate-advanced is managed by its source",
			);
		});
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes at once when Cancel is pressed with no staged edits", async () => {
		const onClose = vi.fn();
		renderSheet(onClose);
		await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("Discard companion edits?")).toBeNull();
	});

	it("never silently discards staged edits on close — asks first, and 'Keep editing' keeps the draft (R17)", async () => {
		const onClose = vi.fn();
		renderSheet(onClose);
		const row = await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(row); // deselect — a staged, unsaved edit

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Discard companion edits?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.queryByText("Discard companion edits?")).toBeNull();
		// The draft itself was never touched by the close attempt.
		expect(screen.getByRole("option", { name: "orch-implementer" })).toHaveAttribute(
			"aria-selected",
			"false",
		);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// ─── Wave 4c unit 2 — the "New hook…" form (T12) ──────────────────────────

	it("adds a new hook via the New hook… form; Save sends the scaffold key and the toast names the created script + its persistence (T12, grill #18)", async () => {
		mockPicker({
			success: true,
			output: JSON.stringify({
				ok: true,
				skill: "orchestrate-advanced",
				block: DECLARED,
				reconcile: { projects: {} },
				scaffolded: ["/Users/test/.skill-hub/skills/orchestrate-advanced/scripts/new-guard.sh"],
			}),
		});
		const onClose = vi.fn();
		renderSheet(onClose);
		await screen.findByRole("option", { name: "orch-implementer" });

		// The disclosure is collapsed ([hidden]) by default (grill #18) — the
		// form's own fields are present but not visible until the toggle opens
		// it (the region toggles via `el.hidden`, never conditional unmount).
		expect(screen.getByTestId("companions-new-hook-name")).not.toBeVisible();
		fireEvent.click(screen.getByTestId("companions-new-hook-toggle"));
		expect(screen.getByTestId("companions-new-hook-name")).toBeVisible();
		await userEvent.type(screen.getByTestId("companions-new-hook-name"), "new-guard");
		fireEvent.click(screen.getByTestId("companions-new-hook-add"));

		// It renders as an ordinary selected row, tagged inline — no second
		// representation (§2.1).
		const newRow = await screen.findByRole("option", { name: /new-guard/ });
		expect(newRow).toHaveAttribute("aria-selected", "true");
		expect(newRow).toHaveTextContent("inline");
		// The disclosure re-collapses after Add.
		expect(screen.getByTestId("companions-new-hook-name")).not.toBeVisible();

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());

		const setCalls = hubCmdCalls().filter(
			(a) => a[0] === "skill" && a[1] === "companions" && a[2] === "set",
		);
		expect(setCalls).toHaveLength(1);
		const bodyIdx = setCalls[0].indexOf("--json-body");
		const block = JSON.parse(setCalls[0][bodyIdx + 1]) as {
			hooks: { name: string; command?: string; scaffold?: { template: string } }[];
		};
		const created = block.hooks.find((h) => h.name === "new-guard");
		expect(created?.command).toBe("scripts/new-guard.sh");
		expect(created?.scaffold).toEqual({ template: "bash" });

		// Two toasts fire on save (the scaffold notice, then the reconcile
		// toast pushed unconditionally right after it — see
		// `pushReconcileToast`), so the LAST toast is not this one; find it by
		// title. `setup.ts` now resets `toasts: []` every test, so this can no
		// longer pick up a same-titled toast left by an earlier test.
		const findScaffoldToast = () =>
			useAppStore.getState().toasts.find((t) => t.title.includes("Created"));
		await waitFor(() => expect(findScaffoldToast()).toBeTruthy());
		const scaffoldToast = findScaffoldToast();
		expect(scaffoldToast?.body).toContain("scripts/new-guard.sh");
		expect(scaffoldToast?.body).toContain("stays on disk");
	});

	it("an {ok:false, field:'hooks[x].command'} reply surfaces in companions-edit-error and does not close the sheet (T12)", async () => {
		mockPicker({
			success: false,
			output: JSON.stringify({
				ok: false,
				error: "hooks[new-guard]: cannot scaffold — unsupported_suffix",
				field: "hooks[new-guard].command",
			}),
		});
		const onClose = vi.fn();
		renderSheet(onClose);
		await screen.findByRole("option", { name: "orch-implementer" });

		fireEvent.click(screen.getByTestId("companions-new-hook-toggle"));
		await userEvent.type(screen.getByTestId("companions-new-hook-name"), "new-guard");
		fireEvent.click(screen.getByTestId("companions-new-hook-add"));
		await screen.findByRole("option", { name: /new-guard/ });

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => {
			expect(screen.getByTestId("companions-edit-error")).toHaveTextContent("cannot scaffold");
		});
		expect(screen.getByTestId("companions-edit-error")).toHaveTextContent(
			"hooks[new-guard].command",
		);
		expect(onClose).not.toHaveBeenCalled();
	});
});

// ─── T11 — NewHookForm, standalone ──────────────────────────────────────────

describe("NewHookForm (T11)", () => {
	it("derives the script path live from the name, keeps Add disabled until valid, calls onAdd with the exact entry (incl. scaffold), and clears itself", async () => {
		const onAdd = vi.fn();
		render(
			<NewHookForm
				registry={REGISTRY}
				taken={{ inline: [], refs: ["lint-report"], library: ["lint-report"] }}
				onAdd={onAdd}
			/>,
		);
		const addButton = screen.getByTestId("companions-new-hook-add");
		expect(addButton).toBeDisabled();
		expect(screen.queryByTestId("companions-new-hook-path")).toBeNull();

		await userEvent.type(screen.getByTestId("companions-new-hook-name"), "Scope Guard");
		expect(screen.getByTestId("companions-new-hook-path")).toHaveTextContent(
			"scripts/scope-guard.sh",
		);
		expect(addButton).not.toBeDisabled();

		fireEvent.click(addButton);
		expect(onAdd).toHaveBeenCalledTimes(1);
		expect(onAdd.mock.calls[0][0]).toEqual({
			name: "Scope Guard",
			event: "PreToolUse",
			command: "scripts/scope-guard.sh",
			activation: "while-running",
			scaffold: { template: "bash" },
		});

		// Clears itself — a reopen always starts fresh.
		expect(screen.getByTestId("companions-new-hook-name")).toHaveValue("");
		expect(screen.queryByTestId("companions-new-hook-path")).toBeNull();
	});

	it("keeps Add disabled when the name collides with a hooks-library definition (§6.3a)", async () => {
		const onAdd = vi.fn();
		render(
			<NewHookForm
				registry={REGISTRY}
				taken={{ inline: [], refs: [], library: ["lint-report"] }}
				onAdd={onAdd}
			/>,
		);
		await userEvent.type(screen.getByTestId("companions-new-hook-name"), "lint-report");
		expect(screen.getByTestId("companions-new-hook-add")).toBeDisabled();
		expect(onAdd).not.toHaveBeenCalled();
	});
});

// ─── T12b (grill #14) — Save invalidation ───────────────────────────────────

describe("CompanionsEditSheet Save invalidation (T12b, grill #14)", () => {
	it("invalidates every REGISTRY_WRITE_KEYS entry plus qk.hooks.list() plus the skillCompanionsAll family", async () => {
		mockPicker();
		const onClose = vi.fn();
		const client = makeQueryClient();
		primeRegistry(client, REGISTRY);
		// Spy on the client's own `invalidateQueries`, rather than reading
		// `isInvalidated` back afterward: several of these keys (`registry`,
		// `hooks.list`) have ACTIVE observers in this render, so a fast mocked
		// refetch can clear the flag again before the assertion runs — a race
		// this behavioural spy sidesteps entirely.
		const spy = vi.spyOn(client, "invalidateQueries");
		renderWithProviders(
			<CompanionsEditSheet
				open
				onClose={onClose}
				skillName="orchestrate-advanced"
				declared={DECLARED}
			/>,
			{ client },
		);
		await screen.findByRole("option", { name: "orch-implementer" });
		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());

		const invalidatedKeys = spy.mock.calls.map(([opts]) =>
			JSON.stringify((opts as { queryKey?: unknown[] } | undefined)?.queryKey),
		);
		const expectedKeys = [...REGISTRY_WRITE_KEYS, qk.hooks.list(), qk.skillCompanionsAll()];
		for (const key of expectedKeys) {
			expect(invalidatedKeys).toContain(JSON.stringify(key));
		}
	});

	// companions.journey.spec.ts "Reverse: Hooks row → Ship with… → pick a
	// skill → seeded sheet → Save shows shipped by" (~:371-407). The Hooks
	// row → picker → sheet crossing is `ShipWithFlow`'s own overlay routing
	// (never both overlays at once) — not re-proven here. This is the
	// sheet's OWN half: opening already seeded from a `ShipWithTarget` marks
	// the seeded row `data-seeded`, is dirty (Save enabled) with no click
	// inside the sheet, and Save's payload actually carries the seeded hook
	// — the data `CompanionTag`'s "shipped by" reads back off the registry.
	it("opens pre-seeded from a hook Ship-with target: data-seeded row, Save enabled at once, and the write carries the seeded hook", async () => {
		const onClose = vi.fn();
		renderSheet(onClose, { kind: "hook", name: "new-hook-ref" });

		// "new-hook-ref" isn't in DECLARED — a genuinely new seed, same as the
		// journey's lsp-report (a hook `orchestrate-advanced` doesn't ship
		// yet). The accessible name also carries the trailing event text
		// (e.g. "new-hook-refPreToolUse"), so match the leading name only.
		const seededRow = await screen.findByRole("option", { name: /^new-hook-ref/ });
		expect(seededRow).toHaveAttribute("aria-selected", "true");
		await waitFor(() =>
			expect(
				document.querySelector('[data-seeded="true"]'),
			).not.toBeNull(),
		);

		// Dirty the moment it opens — nothing clicked inside the sheet yet.
		expect(screen.getByTestId("companions-edit-save")).toBeEnabled();

		fireEvent.click(screen.getByTestId("companions-edit-save"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());

		const setCalls = hubCmdCalls().filter(
			(a) => a[0] === "skill" && a[1] === "companions" && a[2] === "set",
		);
		expect(setCalls).toHaveLength(1);
		const bodyIdx = setCalls[0].indexOf("--json-body");
		const block = JSON.parse(setCalls[0][bodyIdx + 1]) as {
			hooks: { name?: string; ref?: string }[];
		};
		// The write is what a `CompanionTag` reads "shipped by" off of — the
		// seeded hook rides in the saved block, alongside what was already
		// declared, never replacing it.
		expect(block.hooks.some((h) => h.name === "new-hook-ref" || h.ref === "new-hook-ref")).toBe(true);
		expect(block.hooks.some((h) => h.name === "orch-scope-guard")).toBe(true);
	});
});
