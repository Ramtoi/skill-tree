// Wave D (plan 2, D5/A11): the two provenance words never swap.
// `via <skill>` reads the project ledger (`projects.<n>.companions`) —
// project screens only. `shipped by <skill>` reads the project-independent
// mirror (`skills.<n>.ships_with`) — the Hooks library, the guardrails
// NavPanel, and the user-scope sub-agent list. Pins: `plans/2.md`'s test
// task table row for `companionProvenance.test.tsx`.

import { useState } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import type { NavigateFunction } from "react-router-dom";

import { CompanionTag } from "@/components/companions/CompanionTag";
import { PermissionRow } from "@/components/PermissionRow";
import { SubagentList } from "@/components/subagents/SubagentList";
import { HooksScreen } from "@/screens/HooksScreen";
import { GuardrailsRows } from "@/components/nav/GuardrailsBody";
import { hookRowMark } from "@/lib/navInsights";
import { qk } from "@/lib/queryKeys";
import { useShipWith, useShipWithStoreForTests } from "@/hooks/useShipWith";
import { renderWithProviders, makeQueryClient } from "./helpers";
import type { Capabilities, Rule } from "@/types/permissions";
import type { Registry } from "@/types";
import type { HookRow } from "@/hooks/useHooks";

const CAPS: Capabilities = {
	"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask", "hooks", "additional_directories"],
};

const SKILL_NAME = "orchestrate-advanced";
const SHORT_NAME = "orchestrate-adv…"; // S3: 15-char truncation of the 20-char name

/** The D6-shaped `ships_with` mirror + a `moon-base` ledger entry, minimal
 *  but real enough to exercise both `shippedBy` (mirror) and `via` (ledger). */
function registryWithCompanions(): Registry {
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
					agents: ["orch-implementer"],
					hooks: [
						{
							name: "orch-scope-guard",
							event: "PreToolUse",
							command: "scripts/scope-guard.sh",
							activation: "while-running",
						},
					],
					permissions: {
						deny: ["Bash(git push --force:*)"],
					},
				},
			},
		},
		projects: {
			"moon-base": {
				path: "/repo/moon-base",
				bundles: [],
				enabled: [SKILL_NAME],
				companions: {
					[SKILL_NAME]: {
						hooks: ["orch-scope-guard"],
						agents: ["orch-implementer"],
						permissions: [{ pattern: "Bash(git push --force:*)", kind: "deny" }],
						provisioned_at: "2026-09-05T00:00:00Z",
					},
				},
			},
		},
		bundles: {},
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	// Wave 4c unit 4 — the shared "Ship with…" host is a module-level store;
	// reset it so a flow left open by one test never leaks into the next.
	useShipWithStoreForTests.setState({ stage: "closed", target: null, skill: null });
});

// ─── CompanionTag itself ────────────────────────────────────────────────────

describe("CompanionTag", () => {
	it("renders 'via <skill>', truncated, with the full name in title", () => {
		render(<CompanionTag word="via" skill={SKILL_NAME} />);
		const wrap = screen.getByTestId("companion-tag");
		expect(wrap).toHaveTextContent(`via ${SHORT_NAME}`);
		expect(wrap.getAttribute("title")).toBe(`via ${SKILL_NAME}`);
	});

	it("renders 'shipped by <skill>', the other word, never both", () => {
		render(<CompanionTag word="shipped by" skill={SKILL_NAME} />);
		const wrap = screen.getByTestId("companion-tag");
		expect(wrap).toHaveTextContent(`shipped by ${SHORT_NAME}`);
		expect(wrap.getAttribute("title")).toBe(`shipped by ${SKILL_NAME}`);
		expect(wrap.textContent).not.toContain("via ");
	});

	it("is neutral — never the amber provenance/severity channel", () => {
		render(<CompanionTag word="via" skill={SKILL_NAME} />);
		const tag = screen.getByTestId("companion-tag").querySelector(".tag");
		expect((tag as HTMLElement).style.color).not.toBe("var(--amber)");
	});

	// ─── T16 (wave 4c unit 4, plans/3.md §6.5) — the interactive mode: the
	// literal reverse of the read-only tag above. No `onClick` ⇒ a `<span>`
	// exactly as before; `onClick` ⇒ a `<button>`, same visible label, and an
	// accessible name that still carries the UNTRUNCATED skill name even
	// though the visible text is truncated (S3).

	it("renders a <span> with no onClick (read-only, unchanged)", () => {
		render(<CompanionTag word="shipped by" skill={SKILL_NAME} />);
		const wrap = screen.getByTestId("companion-tag");
		expect(wrap.tagName).toBe("SPAN");
		expect(wrap).not.toHaveAttribute("data-interactive");
	});

	it("renders a <button> when onClick is passed, firing it exactly once per click", () => {
		const onClick = vi.fn();
		render(<CompanionTag word="shipped by" skill={SKILL_NAME} onClick={onClick} />);
		const wrap = screen.getByTestId("companion-tag");
		expect(wrap.tagName).toBe("BUTTON");
		expect(wrap).toHaveAttribute("data-interactive", "true");
		fireEvent.click(wrap);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("the button's accessible name still contains the untruncated skill name", () => {
		render(<CompanionTag word="shipped by" skill={SKILL_NAME} onClick={() => {}} />);
		const btn = screen.getByRole("button", { name: new RegExp(SKILL_NAME) });
		expect(btn).toBeInTheDocument();
		// The visible label stays truncated (S3) — only the accessible name/title
		// carry the full skill name.
		expect(btn).toHaveTextContent(SHORT_NAME);
	});
});

// ─── PermissionRow: `via <skill>` on a project-scope rule row ──────────────

describe("PermissionRow provenance", () => {
	const rule: Rule = {
		pattern: "Bash(git push --force:*)",
		kind: "deny",
		origin: "project",
	};

	it("renders a neutral 'via <skill>' companion tag alongside the untouched project tag", () => {
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				viaSkill={SKILL_NAME}
			/>,
		);
		const tag = screen.getByTestId("companion-tag");
		expect(tag.getAttribute("data-word")).toBe("via");
		expect(tag).toHaveTextContent(SHORT_NAME);
		// The amber project-scope branch (`provenanceMeta`) is untouched — both
		// provenance tags render side by side.
		expect(screen.getByText("project")).toBeInTheDocument();
	});

	it("renders no companion tag when the row has no ledger entry", () => {
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				viaSkill={null}
			/>,
		);
		expect(screen.queryByTestId("companion-tag")).not.toBeInTheDocument();
	});
});

// ─── T18 (wave 4c unit 4, plans/3.md §2.3/§5, R7) — the reverse-link row
// action on a Permissions row: hidden for an empty pattern, and the seed it
// stages is captured BY VALUE at click time, so a later draft edit can never
// move what was already staged.

describe("PermissionRow ship-with action (R7)", () => {
	const rule: Rule = {
		pattern: "Bash(git push --force:*)",
		kind: "deny",
		origin: "project",
	};

	it("renders the action when onShipWith is passed", () => {
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onShipWith={() => {}}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Ship this rule with a skill" }),
		).toBeInTheDocument();
	});

	it("is absent when onShipWith is omitted", () => {
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
			/>,
		);
		expect(screen.queryByTestId("ship-with-open")).not.toBeInTheDocument();
	});

	it("is hidden when the pattern is empty, even with onShipWith passed", () => {
		render(
			<PermissionRow
				rule={{ ...rule, pattern: "" }}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onShipWith={() => {}}
			/>,
		);
		expect(screen.queryByTestId("ship-with-open")).not.toBeInTheDocument();
	});

	/** Reproduces the exact integration shape `PermissionsEditor.renderRuleRow`
	 *  uses: `onShipWith` is a fresh closure built on every render, reading
	 *  `rule.pattern`/`rule.kind` directly — so a click stages a snapshot into
	 *  the shared store, and a LATER edit to the draft (a new `rule` object on
	 *  the next render) can never reach back and change what is already
	 *  staged. */
	function ShipWithHarness({ initialPattern }: { initialPattern: string }) {
		const [pattern, setPattern] = useState(initialPattern);
		const shipWith = useShipWith();
		const draftRule: Rule = { pattern, kind: "deny", origin: "project" };
		return (
			<div>
				<PermissionRow
					rule={draftRule}
					scopeKind="project"
					installedHarnesses={["claude-code"]}
					capabilities={CAPS}
					onShipWith={() =>
						shipWith.open({
							kind: "permission",
							pattern: draftRule.pattern,
							ruleKind: draftRule.kind,
						})
					}
				/>
				<button onClick={() => setPattern("Bash(changed:*)")}>edit-draft</button>
			</div>
		);
	}

	it("captures the pattern BY VALUE at click time — a later draft edit does not move the seed", () => {
		render(<ShipWithHarness initialPattern="Bash(git push --force:*)" />);
		fireEvent.click(screen.getByTestId("ship-with-open"));
		expect(useShipWithStoreForTests.getState().target).toEqual({
			kind: "permission",
			pattern: "Bash(git push --force:*)",
			ruleKind: "deny",
		});

		fireEvent.click(screen.getByText("edit-draft"));
		// The draft moved on (the input now reflects the new pattern)...
		expect(screen.getByDisplayValue("Bash(changed:*)")).toBeInTheDocument();
		// ...but the already-staged seed is untouched.
		expect(useShipWithStoreForTests.getState().target).toEqual({
			kind: "permission",
			pattern: "Bash(git push --force:*)",
			ruleKind: "deny",
		});
	});
});

// ─── SubagentList: `via` in project scope, `shipped by` in user scope ──────

const AGENT_ITEM = {
	name: "orch-implementer",
	file: "orch-implementer.md",
	relpath: "orch-implementer.md",
	description: "Implements one wave.",
	model: "sonnet",
	tools_mode: "allowlist",
	tools: ["Read", "Edit", "Write"],
	disallowed_tools: [],
	skills: [],
	color: "",
	disabled: false,
	builtin: false,
	valid: true,
	warnings: [],
};

function mockSubagents(registry: Registry, listScope: "user" | "project") {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		switch (cmd) {
			case "read_registry":
				return registry;
			case "subagent_list": {
				const a = args as { scope?: string };
				if (a?.scope !== listScope) {
					return { scope: a?.scope, project: null, agents_dir: "", settings_path: "", agents: [], builtins: [] };
				}
				return {
					scope: listScope,
					project: listScope === "project" ? "moon-base" : null,
					agents_dir: listScope === "project" ? "/repo/moon-base/.claude/agents" : "/home/test/.claude/agents",
					settings_path: "/home/test/.claude/settings.json",
					agents: [AGENT_ITEM],
					builtins: [],
				};
			}
			default:
				return undefined;
		}
	}) as never);
}

describe("SubagentList provenance", () => {
	it("shows 'via <skill>' on a project-scope agent card from the ledger", async () => {
		mockSubagents(registryWithCompanions(), "project");
		renderWithProviders(
			<SubagentList
				scope="project"
				project="moon-base"
				onScopeChange={() => {}}
				onOpen={() => {}}
				hideScopeSwitcher
			/>,
			{ client: makeQueryClient() },
		);
		await screen.findByText("orch-implementer");
		const tag = screen.getByTestId("companion-tag");
		expect(tag.getAttribute("data-word")).toBe("via");
		expect(tag).toHaveTextContent(SHORT_NAME);
	});

	it("shows 'shipped by <skill>' on a user-scope agent card from the mirror", async () => {
		mockSubagents(registryWithCompanions(), "user");
		renderWithProviders(
			<SubagentList
				scope="user"
				project={null}
				onScopeChange={() => {}}
				onOpen={() => {}}
			/>,
			{ client: makeQueryClient() },
		);
		await screen.findByText("orch-implementer");
		const tag = screen.getByTestId("companion-tag");
		expect(tag.getAttribute("data-word")).toBe("shipped by");
		expect(tag).toHaveTextContent(SHORT_NAME);
	});
});

// ─── T17 (wave 4c unit 4) — the reverse-link row action on a sub-agent card:
// a shipped card's tag becomes the affordance (no separate button); an
// unshipped card gets the ghost button; neither ever fires the card's own
// `onOpen` (the shipped-but-dead / accidental-navigation failure mode this
// repo has hit before). Grill #19: the seed's `sourceHarness` is whatever
// harness THIS list renders — never `pi`, even when the registry's own
// `harnesses_global` carries it alongside the two agent-capable harnesses.

const AGENT_UNSHIPPED = {
	...AGENT_ITEM,
	name: "new-agent",
	description: "Not declared yet.",
};

function mockSubagentsTwo(registry: Registry) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		switch (cmd) {
			case "read_registry":
				return registry;
			case "subagent_list": {
				const a = args as { scope?: string };
				if (a?.scope !== "user") {
					return { scope: a?.scope, project: null, agents_dir: "", settings_path: "", agents: [], builtins: [] };
				}
				return {
					scope: "user",
					project: null,
					agents_dir: "/home/test/.claude/agents",
					settings_path: "/home/test/.claude/settings.json",
					agents: [AGENT_ITEM, AGENT_UNSHIPPED],
					builtins: [],
				};
			}
			default:
				return undefined;
		}
	}) as never);
}

describe("SubagentList ship-with action (T17)", () => {
	it("a shipped card's tag is the affordance — no separate button, and it never opens the card", async () => {
		mockSubagentsTwo(registryWithCompanions());
		const onOpen = vi.fn();
		renderWithProviders(
			<SubagentList scope="user" project={null} onScopeChange={() => {}} onOpen={onOpen} />,
			{ client: makeQueryClient() },
		);
		await screen.findByText("orch-implementer");
		const card = screen.getByText("orch-implementer").closest(".subagent-card") as HTMLElement;
		const tag = within(card).getByTestId("companion-tag");
		expect(tag.tagName).toBe("BUTTON");
		expect(within(card).queryByTestId("ship-with-open")).not.toBeInTheDocument();

		fireEvent.click(tag);
		expect(useShipWithStoreForTests.getState()).toMatchObject({
			stage: "sheet",
			target: { kind: "agent", name: "orch-implementer", sourceHarness: "claude-code" },
			skill: SKILL_NAME,
		});
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("an unshipped card gets the ghost button, which opens the picker without navigating", async () => {
		mockSubagentsTwo(registryWithCompanions());
		const onOpen = vi.fn();
		renderWithProviders(
			<SubagentList scope="user" project={null} onScopeChange={() => {}} onOpen={onOpen} />,
			{ client: makeQueryClient() },
		);
		await screen.findByText("new-agent");
		const card = screen.getByText("new-agent").closest(".subagent-card") as HTMLElement;
		expect(within(card).queryByTestId("companion-tag")).not.toBeInTheDocument();
		const btn = within(card).getByTestId("ship-with-open");

		fireEvent.click(btn);
		expect(useShipWithStoreForTests.getState()).toMatchObject({
			stage: "picker",
			target: { kind: "agent", name: "new-agent", sourceHarness: "claude-code" },
			skill: null,
		});
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("grill #19 — the seed's sourceHarness is the harness THIS list renders, never pi", async () => {
		const registry: Registry = {
			...registryWithCompanions(),
			harnesses_global: ["claude-code", "codex", "pi"],
		};
		mockSubagentsTwo(registry);
		renderWithProviders(
			<SubagentList
				scope="user"
				project={null}
				harness="codex"
				onScopeChange={() => {}}
				onOpen={() => {}}
			/>,
			{ client: makeQueryClient() },
		);
		await screen.findByText("new-agent");
		fireEvent.click(screen.getByTestId("ship-with-open"));
		const target = useShipWithStoreForTests.getState().target;
		expect(target).toMatchObject({ kind: "agent", sourceHarness: "codex" });
		expect(target && "sourceHarness" in target ? target.sourceHarness : null).not.toBe("pi");
	});

	it("R1(b) — a project-scope card with no companion gets a disabled 'Ship with…' naming why, and never stages a seed", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			switch (cmd) {
				case "read_registry":
					return registryWithCompanions();
				case "subagent_list": {
					const a = args as { scope?: string };
					if (a?.scope !== "project") {
						return { scope: a?.scope, project: null, agents_dir: "", settings_path: "", agents: [], builtins: [] };
					}
					return {
						scope: "project",
						project: "moon-base",
						agents_dir: "/repo/moon-base/.claude/agents",
						settings_path: "/home/test/.claude/settings.json",
						agents: [AGENT_UNSHIPPED],
						builtins: [],
					};
				}
				default:
					return undefined;
			}
		}) as never);
		renderWithProviders(
			<SubagentList
				scope="project"
				project="moon-base"
				onScopeChange={() => {}}
				onOpen={() => {}}
				hideScopeSwitcher
			/>,
			{ client: makeQueryClient() },
		);
		await screen.findByText("new-agent");
		expect(screen.queryByTestId("companion-tag")).not.toBeInTheDocument();
		const btn = screen.getByTestId("ship-with-open");
		expect(btn).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByText("Companions copy user-scope agents only.")).toBeInTheDocument();

		fireEvent.click(btn);
		// Soft-disabled (still focusable, per `Button`'s `disabledReason`
		// contract) — but the click must be swallowed, never staging a seed
		// the sheet has no user-scope row for.
		expect(useShipWithStoreForTests.getState().stage).toBe("closed");
	});
});

// ─── HooksScreen: `shipped by <skill>` + activation words on a library row ─

describe("HooksScreen provenance", () => {
	const HOOK: HookRow = {
		name: "orch-scope-guard",
		provenance: "user",
		event: "PreToolUse",
		command: "scripts/scope-guard.sh",
		description: "",
		tools: ["Edit", "Write"],
		matcher: "",
		timeout: null,
		harnesses: null,
		settings: {},
		attached_global: false,
		attached_projects: ["moon-base"],
	};

	it("shows 'shipped by <skill>' and the activation words beside HookAttachChip", async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			switch (cmd) {
				case "read_registry":
					return registryWithCompanions();
				case "hook_list":
					return { hooks: [HOOK], reach: {} };
				case "hook_capabilities":
					return null;
				case "hook_doctor":
					return { findings: [], danger_count: 0 };
				default:
					return undefined;
			}
		}) as never);
		renderWithProviders(<HooksScreen />, { client: makeQueryClient() });
		await screen.findByText("orch-scope-guard");
		const tag = screen.getByTestId("companion-tag");
		expect(tag.getAttribute("data-word")).toBe("shipped by");
		expect(tag).toHaveTextContent(SHORT_NAME);
		expect(screen.getByTestId("hook-activation")).toHaveTextContent(
			`while ${SKILL_NAME} runs`,
		);
	});
});

// ─── GuardrailsRows / hookRowMark: the NavPanel's own "shipped by" wiring ──
//
// `GuardrailsRows` renders `mark.hint`/`mark.title` verbatim through
// `SideRow` — the string itself is built by the pure `hookRowMark` (the
// NavPanel contract: no markup, no IPC, in `lib/navInsights.ts`). We assert
// both at the pure-function level (matching `navInsights.test.ts`'s own
// style for this helper) AND through a real `GuardrailsRows` render, so the
// wiring from `companionsIndex.shippedBy` through to the row's DOM is proven
// too.

describe("hookRowMark shippedBy (A1/A11)", () => {
	const hook: HookRow = {
		name: "orch-scope-guard",
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
		attached_projects: ["moon-base"],
	};

	it("falls back to the plain event when no skill ships this hook (unchanged default)", () => {
		const mark = hookRowMark(hook);
		expect(mark.hint).toBe("PreToolUse");
		expect(mark.title).not.toContain("shipped by");
	});

	it("reads 'shipped by <skill>' plus the activation words when a skill does", () => {
		const mark = hookRowMark(hook, { skill: SKILL_NAME, activation: "while-running" });
		expect(mark.hint).toBe(`shipped by ${SKILL_NAME}`);
		expect(mark.title).toContain(`while ${SKILL_NAME} runs`);
	});
});

describe("GuardrailsRows hook row", () => {
	it("renders 'shipped by <skill>' as the row hint, from the mirror", () => {
		const guardrailsHookList = {
			hooks: [
				{
					name: "orch-scope-guard",
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
					attached_projects: ["moon-base"],
				},
			],
			reach: {},
		};
		// `useHookList()`'s `staleTime: 0` means mounting also fires a background
		// refetch — mock `invoke` so that lands on the SAME payload instead of
		// racing the primed cache to `undefined` (react-query's non-fatal warning).
		vi.mocked(invoke).mockImplementation((async (cmd: string) =>
			cmd === "hook_list" ? guardrailsHookList : undefined) as never);
		const client = makeQueryClient();
		client.setQueryData(qk.hooks.list(), guardrailsHookList);
		render(
			<QueryClientProvider client={client}>
				<GuardrailsRows
					registry={registryWithCompanions()}
					syncEnvelope={null}
					harnesses={[]}
					anchorPath="/hooks"
					currentPath="/hooks"
					searchParams={new URLSearchParams()}
					locationState={null}
					navigate={(() => {}) as unknown as NavigateFunction}
					collapsed={new Set<string>()}
					toggleCollapsed={() => {}}
					filterFor={() => ""}
					setFilter={() => {}}
					pinned={new Set<string>()}
					togglePin={() => {}}
				/>
			</QueryClientProvider>,
		);
		const row = screen.getByRole("button", { name: /orch-scope-guard/ });
		expect(within(row).getByText(`shipped by ${SKILL_NAME}`)).toBeInTheDocument();
		expect(row.getAttribute("title")).toContain(`while ${SKILL_NAME} runs`);
	});
});
