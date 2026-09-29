// Wave 2 rebuild (D7/D8/C6): one dense row per companion, harness glyphs
// carrying STATE (never a verdict word), a ref hook alongside inline ones
// (A18/C5), ONE project-aware status line + `Provision` rung, an `Edit` rung
// disabled until a later wave wires it, and the drifted row's I9 menu.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { ShipsWithSection } from "@/components/skillEditor/ShipsWithSection";
import type { CompanionsPayload } from "@/lib/companions";
import type { HookListResult } from "@/hooks/useHooks";
import type { Skill } from "@/types";

/** F8: a test-only sibling probe — `renderSection` mounts no router
 *  assertions of its own, so a case that needs to know whether a click
 *  navigated (or deliberately didn't) reads this instead of guessing from
 *  DOM side effects. Not a component change. */
function Loc() {
	const loc = useLocation();
	return <span data-testid="loc">{loc.pathname + loc.search}</span>;
}

/** Two agents (one drifted), one inline hook, one ref hook, one deny rule —
 *  covers every row kind the test tasks name, at a size that stays legible. */
const SHIPPING_SKILL: Skill = {
	...sampleRegistry.skills.brainstorm,
	ships_with: {
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
	},
};

const PAYLOAD: CompanionsPayload = {
	skill: "orchestrate-advanced",
	project: "notes-vault",
	declared: SHIPPING_SKILL.ships_with!,
	summary: { provisioned: 4, pending: 1, drift: 1, missing: 0 },
	project_context: true,
	items: [
		{
			kind: "agent",
			name: "orch-implementer",
			harness: "claude-code",
			target: "~/.claude/agents/orch-implementer.md",
			verdict: "will_write",
			scope: "user",
			state: "drift",
		},
		{
			kind: "agent",
			name: "orch-implementer",
			harness: "codex",
			target: "~/.codex/agents/orch-implementer.toml",
			verdict: "unsupported",
			reason: "no sub-agent definitions",
			scope: "user",
			state: "unsupported",
		},
		{
			kind: "agent",
			name: "orch-reviewer",
			harness: "claude-code",
			target: "~/.claude/agents/orch-reviewer.md",
			verdict: "will_write",
			scope: "user",
			state: "provisioned",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "claude-code",
			target: "/repo/.claude/settings.local.json",
			verdict: "will_write",
			activation: "while-running",
			state: "provisioned",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "codex",
			target: "/repo",
			verdict: "unsupported",
			reason: "Codex skips project-attached hooks",
			activation: "while-running",
			state: "unsupported",
		},
		{
			kind: "hook",
			name: "lint-report",
			harness: "claude-code",
			target: "/repo/.claude/settings.local.json",
			verdict: "will_write",
			state: "pending",
		},
		{
			kind: "permission",
			name: "Bash(git push --force:*)",
			harness: "claude-code",
			target: "/repo/.claude/settings.json",
			verdict: "will_write",
			rule_kind: "deny",
			state: "provisioned",
			route: "/project/notes-vault?tab=permissions&focus=deny:Bash(git%20push%20--force%3A*)",
		},
	],
};

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
	],
};

const SUBAGENTS = [
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
];

/** `hub_cmd` arm for `skill companions … --json` and the I9 `resolve` verb,
 *  plus `hook_list`/`subagent_list` so the hover-card description lookups and
 *  the harness glyph cluster have real data — and the harmless defaults
 *  every other component test relies on. */
function mockCompanions(
	payload: CompanionsPayload = PAYLOAD,
	opts?: { resolveOk?: boolean; hookList?: HookListResult; hookListError?: boolean },
) {
	vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
		if (cmd === "hub_cmd") {
			const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
			if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "resolve") {
				return Promise.resolve({ success: opts?.resolveOk ?? true, output: "{}" });
			}
			if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions") {
				return Promise.resolve({ success: true, output: JSON.stringify(payload) });
			}
			return Promise.resolve({ success: true, output: "" });
		}
		// S4: a real `hook_list` failure — distinct from `opts.hookList` (a
		// successful read with different contents).
		if (cmd === "hook_list") {
			return opts?.hookListError
				? Promise.reject(new Error("hook_list failed"))
				: Promise.resolve(opts?.hookList ?? HOOK_LIST);
		}
		if (cmd === "subagent_list") {
			return Promise.resolve({
				scope: "user",
				project: null,
				agents_dir: "/home/test/.claude/agents",
				settings_path: "/home/test/.claude/settings.json",
				agents: SUBAGENTS,
				builtins: [],
			});
		}
		return Promise.resolve(undefined);
	}) as never);
}

function hubCmdCalls() {
	return vi
		.mocked(invoke)
		.mock.calls.filter(([cmd]) => cmd === "hub_cmd")
		.map(([, args]) => (args as { args: string[] }).args);
}

function renderSection(skill: Skill = SHIPPING_SKILL, project: string | null | undefined = "notes-vault") {
	return renderWithProviders(
		<>
			<ShipsWithSection
				skillName="orchestrate-advanced"
				skill={skill}
				project={project}
				storageKey="st:test:ships-with"
			/>
			<Loc />
		</>,
		{ client: makeQueryClient() },
	);
}

function expandSection() {
	fireEvent.click(screen.getByTestId("side-section-ships-with"));
}

describe("ShipsWithSection", () => {
	it("is absent entirely when the skill declares no companions", () => {
		mockCompanions();
		renderWithProviders(
			<ShipsWithSection
				skillName="brainstorm"
				skill={sampleRegistry.skills.brainstorm}
				storageKey="st:test:ships-with"
			/>,
			{ client: makeQueryClient() },
		);
		expect(screen.queryByTestId("side-section-ships-with")).toBeNull();
	});

	it("ships collapsed and states counts in the head from the mirror alone, with no hub_cmd companions read", () => {
		mockCompanions();
		renderSection();
		const head = screen.getByTestId("side-section-ships-with");
		expect(head).toHaveAttribute("aria-expanded", "false");
		const section = document.querySelector("[data-section-id='ships-with']")!;
		expect(section.textContent).toContain("2 agents");
		expect(section.textContent).toContain("2 hooks");
		expect(section.textContent).toContain("1 rule");
		expect(
			hubCmdCalls().some((a) => a[0] === "skill" && a[1] === "companions"),
		).toBe(false);
	});

	it("shows compact AGENTS · HOOKS · RULES sub-group labels + counts, one row per companion incl. the ref hook", async () => {
		mockCompanions();
		renderSection();
		expandSection();

		const section = document.querySelector("[data-section-id='ships-with']")!;
		await waitFor(() => {
			expect(section.textContent).toContain("AGENTS");
		});
		expect(within(section as HTMLElement).getByText("AGENTS")).toBeInTheDocument();
		expect(within(section as HTMLElement).getByText("HOOKS")).toBeInTheDocument();
		expect(within(section as HTMLElement).getByText("RULES")).toBeInTheDocument();

		expect(screen.getByTestId("companion-row-agent:orch-implementer")).toBeInTheDocument();
		expect(screen.getByTestId("companion-row-agent:orch-reviewer")).toBeInTheDocument();
		expect(screen.getByTestId("companion-row-hook:orch-scope-guard")).toBeInTheDocument();
		// The ref hook renders exactly like an inline one — keyed on `name`.
		expect(screen.getByTestId("companion-row-hook:lint-report")).toBeInTheDocument();
		expect(
			screen.getByTestId("companion-row-permission:deny:Bash(git push --force:*)"),
		).toBeInTheDocument();
	});

	it("renders a harness glyph per item with its data-state and an sr-only sentence, and NO verdict pill anywhere", async () => {
		mockCompanions();
		renderSection();
		expandSection();

		const reviewerRow = await screen.findByTestId("companion-row-agent:orch-reviewer");
		// The glyph cluster only lights up once the async `hub skill companions`
		// read resolves — `find*` (not a plain querySelector) waits for it.
		const glyph = await within(reviewerRow).findByTitle(/Provisioned on Claude Code/);
		expect(glyph).toHaveAttribute("data-harness", "claude-code");
		expect(glyph).toHaveAttribute("data-state", "lit");
		expect(glyph.querySelector(".sr-only")?.textContent).toMatch(/Provisioned on Claude Code/);

		const implementerRow = screen.getByTestId("companion-row-agent:orch-implementer");
		const codexGlyph = await within(implementerRow).findByTitle(/Not supported on Codex/);
		expect(codexGlyph).toHaveAttribute("data-state", "unsupported");
		expect(codexGlyph.querySelector(".sr-only")?.textContent).toContain(
			"no sub-agent definitions",
		);

		const section = document.querySelector("[data-section-id='ships-with']")!;
		expect(section.querySelector(".status-badge")).toBeNull();
	});

	it("shows ONE status line — pending, with a Provision rung — when the read reports pending companions", async () => {
		mockCompanions();
		renderSection();
		expandSection();

		const line = await screen.findByTestId("companion-status-line");
		expect(line.textContent).toContain("1 pending on notes-vault");
		expect(screen.getByTestId("companion-provision")).toBeInTheDocument();
	});

	it("omits the Provision rung — and reads 'Provisioned on <project>' — once nothing is pending", async () => {
		mockCompanions({
			...PAYLOAD,
			summary: { provisioned: 5, pending: 0, drift: 0, missing: 0 },
			items: PAYLOAD.items.map((it) => ({
				...it,
				state: it.state === "drift" || it.state === "pending" ? "provisioned" : it.state,
			})),
		});
		renderSection();
		expandSection();

		const line = await screen.findByTestId("companion-status-line");
		expect(line.textContent).toContain("Provisioned on notes-vault");
		expect(screen.queryByTestId("companion-provision")).toBeNull();
	});

	it("reads 'Provisioned globally' for a scope: global skill's own-scope read (A17)", async () => {
		mockCompanions({
			skill: "orchestrate-advanced",
			project: null,
			declared: SHIPPING_SKILL.ships_with!,
			project_context: true,
			summary: { provisioned: 5, pending: 0, drift: 0, missing: 0 },
			items: PAYLOAD.items.map((it) => ({ ...it, state: "provisioned" })),
		});
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		const line = await screen.findByTestId("companion-status-line");
		expect(line.textContent).toContain("Provisioned globally");
	});

	it("Edit opens the companions editor for an ordinary skill, and stays disabled with the external-source reason for managed: external", () => {
		// Wave C wires the rung: an ordinary skill's `Edit` is a real click that
		// opens `CompanionsEditSheet`; only a `managed: "external"` skill keeps
		// the soft-disabled (`aria-disabled`, title-carried reason) treatment.
		mockCompanions();
		renderSection();
		const editBtn = screen.getByTestId("ships-with-edit");
		expect(editBtn).not.toHaveAttribute("aria-disabled", "true");
		fireEvent.click(editBtn);
		expect(document.querySelector(".companions-edit-sheet")).not.toBeNull();

		const externalSkill: Skill = { ...SHIPPING_SKILL, managed: "external" };
		mockCompanions();
		renderSection(externalSkill);
		const editBtns = screen.getAllByTestId("ships-with-edit");
		expect(editBtns[1]).toHaveAttribute("aria-disabled", "true");
		expect(editBtns[1]).toHaveAttribute(
			"title",
			expect.stringContaining("owned by an external source"),
		);
		fireEvent.click(editBtns[1]);
		expect(document.querySelectorAll(".companions-edit-sheet")).toHaveLength(1);
	});

	it("the drifted row's menu fires I9 with both ops (keep-mine / keep-skill)", async () => {
		mockCompanions();
		renderSection();
		expandSection();

		const implementerRow = await screen.findByTestId("companion-row-agent:orch-implementer");
		const drift = await within(implementerRow).findByTestId("companion-drift-orch-implementer");
		expect(within(drift).getByText("drifted")).toBeInTheDocument();

		fireEvent.click(within(drift).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByText("Keep mine"));

		await waitFor(() => {
			expect(
				hubCmdCalls().some(
					(a) =>
						a[0] === "skill" &&
						a[1] === "companions" &&
						a[2] === "resolve" &&
						a.includes("--op") &&
						a[a.indexOf("--op") + 1] === "keep-mine" &&
						a.includes("--agent") &&
						a[a.indexOf("--agent") + 1] === "orch-implementer" &&
						a.includes("--project") &&
						a[a.indexOf("--project") + 1] === "notes-vault",
				),
			).toBe(true);
		});

		fireEvent.click(within(drift).getByTestId("overflow-trigger"));
		fireEvent.click(await screen.findByText("Keep the skill's"));

		await waitFor(() => {
			expect(
				hubCmdCalls().some(
					(a) =>
						a[2] === "resolve" &&
						a[a.indexOf("--op") + 1] === "keep-skill" &&
						a[a.indexOf("--agent") + 1] === "orch-implementer",
				),
			).toBe(true);
		});
	});

	it("fires exactly one skill-companions read on expand, with the exact CLI args", async () => {
		mockCompanions();
		renderSection();
		expandSection();

		await waitFor(() => {
			expect(screen.getByTestId("companion-row-agent:orch-implementer")).toBeInTheDocument();
		});

		const calls = hubCmdCalls().filter((a) => a[0] === "skill" && a[1] === "companions" && a[2] !== "resolve");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			"skill",
			"companions",
			"orchestrate-advanced",
			"--project",
			"notes-vault",
			"--json",
		]);
	});

	it("a long name gets the truncating class + full name in title, and companions.css declares the ellipsis contract for it (R31 — survives long names)", async () => {
		const longName = "orch-a-very-long-companion-agent-name-that-should-not-blow-out-the-row";
		const skill: Skill = {
			...sampleRegistry.skills.brainstorm,
			ships_with: { agents: [longName] },
		};
		mockCompanions({
			skill: "orchestrate-advanced",
			project: null,
			declared: skill.ships_with!,
			project_context: false,
			items: [],
		});
		renderWithProviders(
			<ShipsWithSection skillName="orchestrate-advanced" skill={skill} storageKey="st:test:ships-with" />,
			{ client: makeQueryClient() },
		);
		expandSection();
		const nameEl = await screen.findByTitle(longName);
		expect(nameEl).toHaveClass("companion-name");

		// R31: jsdom computes no layout, so a claim resting on `nameEl` alone
		// would still pass with `text-overflow` deleted from the stylesheet —
		// pin the actual CSS *contract* the class carries by reading the
		// source rule directly (the same convention `StatCard.test.tsx` uses
		// for `rows-cards.css`).
		const css = readFileSync(
			join(process.cwd(), "src", "styles", "companions.css"),
			"utf8",
		);
		const rule = css.match(/\.companion-name\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		const body = rule![1];
		expect(body).toMatch(/overflow:\s*hidden/);
		expect(body).toMatch(/text-overflow:\s*ellipsis/);
		expect(body).toMatch(/white-space:\s*nowrap/);
	});

	it("D13/F5: an all-absent, project-less payload renders the idle line with an Equip… rung that opens usedby", async () => {
		mockCompanions({
			skill: "orchestrate-advanced",
			project: null,
			declared: SHIPPING_SKILL.ships_with!,
			project_context: false,
			provisioned_on: [],
			summary: { provisioned: 0, pending: 0, drift: 0, missing: 0 },
			items: [
				{
					kind: "hook",
					name: "orch-scope-guard",
					harness: "claude-code",
					target: null,
					verdict: "will_write",
					activation: "while-running",
					state: "absent",
				},
			],
		});
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		const line = await screen.findByTestId("companion-status-line");
		expect(line).toHaveAttribute("data-tone", "idle");
		expect(line.textContent).toContain(
			"Not provisioned anywhere — equip orchestrate-advanced on a project to install these",
		);
		// FRAME TWEAK: the section is uniformly absent (no lit row anywhere) —
		// no row wears a per-row badge; the idle line above already says it,
		// and repeating it on every name would be noise, not signal.
		expect(screen.queryByTestId("companion-badge-hook:orch-scope-guard")).toBeNull();

		// A stand-in for `ConnectionsPanel`'s sibling `usedby` section — out of
		// this component's own tree (no prop path exists between them), so the
		// contract under test is the exact DOM shape `scrollToUsedBy` reads.
		const toggle = document.createElement("button");
		toggle.setAttribute("data-testid", "side-section-usedby");
		toggle.setAttribute("aria-expanded", "false");
		toggle.addEventListener("click", () => toggle.setAttribute("aria-expanded", "true"));
		const scrollSpy = vi.fn();
		toggle.scrollIntoView = scrollSpy;
		document.body.appendChild(toggle);

		fireEvent.click(screen.getByTestId("companion-status-action"));
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(scrollSpy).toHaveBeenCalled();

		document.body.removeChild(toggle);
	});

	it("F4/F7/FRAME TWEAK: an absent hook row NOT in the hook library is a <span>, not clickable, and — being all this section has (uniform all-absent) — carries no badge", async () => {
		mockCompanions({
			skill: "orchestrate-advanced",
			project: null,
			declared: SHIPPING_SKILL.ships_with!,
			project_context: false,
			provisioned_on: [],
			summary: { provisioned: 0, pending: 0, drift: 0, missing: 0 },
			items: [
				{
					kind: "hook",
					name: "orch-scope-guard",
					harness: "claude-code",
					target: null,
					verdict: "will_write",
					activation: "while-running",
					state: "absent",
				},
			],
		});
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		// The row itself renders from the synchronous mirror (`sw`) before the
		// live `hub skill companions` read resolves — wait on the NAME becoming
		// a plain `<span>` (only true once `items` carries the resolved
		// `absent` state), to avoid asserting against the pre-resolve render.
		const row = screen.getByTestId("companion-row-hook:orch-scope-guard");
		await waitFor(() => {
			expect(within(row).getByTestId("companion-name")).toHaveAttribute("data-routable", "false");
		});
		// FRAME TWEAK: every considered item in the section is absent — the
		// section's own idle status line already says "Not provisioned
		// anywhere", so this (only) row wears no badge of its own.
		expect(within(row).queryByTestId("companion-badge-hook:orch-scope-guard")).toBeNull();

		const name = within(row).getByTestId("companion-name");
		expect(name.tagName).toBe("SPAN");
		expect(name).toHaveAttribute("data-routable", "false");

		fireEvent.click(name);
		expect(screen.getByTestId("loc").textContent).toBe("/");
	});

	it("F2/F4: routability and the row badge are orthogonal — a library hook stays routable while absent (and still badged), a provisioned agent is routable with no badge", async () => {
		mockCompanions({
			skill: "orchestrate-advanced",
			project: null,
			declared: SHIPPING_SKILL.ships_with!,
			project_context: false,
			provisioned_on: [],
			summary: { provisioned: 1, pending: 0, drift: 0, missing: 0 },
			items: [
				{
					kind: "hook",
					name: "lint-report",
					harness: "claude-code",
					target: null,
					verdict: "will_write",
					state: "absent",
				},
				{
					kind: "agent",
					name: "orch-implementer",
					harness: "claude-code",
					target: "~/.claude/agents/orch-implementer.md",
					verdict: "will_write",
					scope: "user",
					state: "provisioned",
				},
			],
		});
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		const hookRow = screen.getByTestId("companion-row-hook:lint-report");
		// Routability needs BOTH the companions read (`items`) and the hooks
		// library (`hookNames`) resolved — the row itself renders from the
		// synchronous mirror before either lands, so wait for the name to
		// actually become a `<button>` rather than trusting its mere presence.
		await waitFor(() => {
			expect(within(hookRow).getByTestId("companion-name").tagName).toBe("BUTTON");
		});
		const hookName = within(hookRow).getByTestId("companion-name");
		expect(hookName).toHaveAttribute("data-routable", "true");
		// F2's library gate and F4's state badge are independent signals: the
		// row is routable (the LIBRARY has "lint-report") AND still genuinely
		// `absent` (nothing has provisioned it) — both are true at once. The
		// section is MIXED (the agent row below is lit), so FRAME TWEAK still
		// shows the badge here — only the uniform all-absent case hides it.
		expect(within(hookRow).getByTestId("companion-badge-hook:lint-report")).toHaveTextContent(
			"not provisioned",
		);

		const agentRow = screen.getByTestId("companion-row-agent:orch-implementer");
		fireEvent.click(within(agentRow).getByTestId("companion-name"));
		expect(screen.getByTestId("loc").textContent).toBe(
			"/skill/orchestrate-advanced/agent/orch-implementer",
		);
		expect(within(agentRow).queryByTestId("companion-badge-agent:orch-implementer")).toBeNull();
	});

	it("D17: the post-equip payload (provisioned_on: ['scratch']) — a library hook row is routable, no not-installed badge, and the line reads 'Provisioned on scratch'", async () => {
		mockCompanions(
			{
				skill: "orchestrate-advanced",
				project: null,
				declared: SHIPPING_SKILL.ships_with!,
				project_context: false,
				provisioned_on: ["scratch"],
				summary: { provisioned: 4, pending: 0, drift: 0, missing: 0 },
				items: [
					{
						kind: "agent",
						name: "orch-implementer",
						harness: "claude-code",
						target: "~/.claude/agents/orch-implementer.md",
						verdict: "will_write",
						scope: "user",
						state: "provisioned",
						reason: "from scratch",
					},
					{
						kind: "hook",
						name: "orch-scope-guard",
						harness: "claude-code",
						target: "/repo/.claude/settings.local.json",
						verdict: "will_write",
						activation: "while-running",
						state: "provisioned",
						reason: "from scratch",
					},
					{
						kind: "permission",
						name: "Bash(git push --force:*)",
						harness: "claude-code",
						target: "/repo/.claude/settings.json",
						verdict: "will_write",
						rule_kind: "deny",
						state: "provisioned",
						reason: "from scratch",
						route: "/project/scratch?tab=permissions&focus=deny:Bash(git%20push%20--force%3A*)",
					},
				],
			},
			{
				// The real CLI creates the hook DEFINITION on first
				// `--with-companions` apply, so a provisioned hook always exists
				// in the LIBRARY too — reflect that here rather than relying on
				// the fixture's default `lint-report`-only list.
				hookList: {
					reach: {},
					hooks: [
						...HOOK_LIST.hooks,
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
							attached_projects: ["scratch"],
						},
					],
				},
			},
		);
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		const line = await screen.findByTestId("companion-status-line");
		expect(line.textContent).toContain("Provisioned on scratch");

		const hookRow = screen.getByTestId("companion-row-hook:orch-scope-guard");
		await waitFor(() => {
			expect(within(hookRow).getByTestId("companion-name")).toHaveAttribute(
				"data-routable",
				"true",
			);
		});
		expect(within(hookRow).queryByTestId("companion-badge-hook:orch-scope-guard")).toBeNull();
	});

	it("S4: when hook_list fails outright, a hook row falls back to the CLI's own route instead of going permanently inert", async () => {
		mockCompanions(
			{
				skill: "orchestrate-advanced",
				project: null,
				declared: SHIPPING_SKILL.ships_with!,
				project_context: false,
				provisioned_on: ["scratch"],
				summary: { provisioned: 1, pending: 0, drift: 0, missing: 0 },
				items: [
					{
						kind: "hook",
						name: "orch-scope-guard",
						harness: "claude-code",
						target: "/repo/.claude/settings.local.json",
						verdict: "will_write",
						activation: "while-running",
						state: "provisioned",
						reason: "from scratch",
						route: "/hook/orch-scope-guard",
					},
				],
			},
			{ hookListError: true },
		);
		renderSection(SHIPPING_SKILL, null);
		expandSection();

		const hookRow = screen.getByTestId("companion-row-hook:orch-scope-guard");
		await waitFor(() => {
			expect(within(hookRow).getByTestId("companion-name")).toHaveAttribute("data-routable", "true");
		});
		fireEvent.click(within(hookRow).getByTestId("companion-name"));
		expect(screen.getByTestId("loc").textContent).toBe("/hook/orch-scope-guard");
	});
});
