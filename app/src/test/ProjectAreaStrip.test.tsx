import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
	agentDocsSummary,
	permissionCounts,
	subagentsSummary,
} from "@/screens/project/projectAreaSummary";
import {
	cardModels,
	resetAreaStripMemory,
} from "@/screens/project/ProjectAreaStrip";
import { parseProjectTab } from "@/lib/projectViews";
import type { AgentDocsListing } from "@/types/agentDocs";
import type { SubagentListResult } from "@/lib/subagents";
import type { Registry } from "@/types";
import {
	makeQueryClient,
	mockSyncReport,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
	sampleSyncReportEnvelope,
} from "./helpers";

// ─── Pure summaries ──────────────────────────────────────────────────────────

describe("projectAreaSummary", () => {
	it("counts effective permission rules by pattern; own + inherited always equals total", () => {
		const registry = {
			...sampleRegistry,
			permissions_global: {
				allow: [
					{ pattern: "Bash(npm:*)", kind: "allow" },
					{ pattern: "Bash(git status:*)", kind: "allow" },
				],
				deny: [{ pattern: "Bash(rm -rf:*)", kind: "deny" }],
				ask: [],
			},
		} as Registry;
		const proj = {
			...sampleRegistry.projects["example-app"],
			permissions: {
				// Restates one global rule TWICE (a hand-edited block) — still one
				// own rule, and the restated global one is not "inherited".
				allow: [
					{ pattern: "Bash(npm:*)", kind: "allow" },
					{ pattern: "Bash(npm:*)", kind: "allow" },
				],
				ask: [{ pattern: "Bash(git push:*)", kind: "ask" }],
			},
		};
		expect(permissionCounts(proj, registry)).toEqual({
			allow: 2,
			deny: 1,
			ask: 1,
			total: 4,
			own: 2,
			inherited: 2,
		});
	});

	it("summarizes a sub-agent list: agents, disabled, built-ins", () => {
		const list = {
			scope: "project",
			project: "p",
			agents_dir: "",
			settings_path: "",
			agents: [{ name: "a", disabled: false }, { name: "b", disabled: true }],
			builtins: [
				{ name: "Plan", disabled: false },
				{ name: "Explore", disabled: true },
			],
		} as unknown as SubagentListResult;
		expect(subagentsSummary(list)).toEqual({
			agents: 2,
			disabled: 1,
			builtins: 2,
			builtinsOff: 1,
		});
	});

	it("summarizes agent docs: loaded files, upfront vs discoverable tokens, deviations", () => {
		const file = (rel: string, extra: object = {}) => ({
			rel,
			name: rel,
			label: rel,
			absolute_path: `/p/${rel}`,
			exists: true,
			is_known: true,
			is_discovered: false,
			is_symlink: false,
			symlink_to: null,
			symlink_target_in_project: true,
			can_read: true,
			can_write: true,
			size: 400,
			modified_at: null,
			hash: null,
			error: null,
			...extra,
		});
		const listing = {
			project_path: "/p",
			root: {
				name: "",
				path: "",
				dirs: [
					{
						name: "docs",
						path: "docs",
						dirs: [],
						files: [
							file("docs/rules.md", { imported_by: ["CLAUDE.md"] }),
							file("docs/CLAUDE.md"),
						],
					},
				],
				files: [file("CLAUDE.md")],
			},
			instruction_rels: ["CLAUDE.md", "docs/rules.md", "docs/CLAUDE.md"],
			external_imports: [],
			instruction_sets: [
				{ relative_dir: "", verdict: "canonical", flags: [] },
				{ relative_dir: "docs", verdict: "claude_only", flags: [] },
			],
		} as unknown as AgentDocsListing;
		const s = agentDocsSummary(listing, ["claude-code"], {
			harness: "claude-code",
			parts: [],
			upfront: 5,
			total: 8,
			discoverable: 3,
			discoverableTruncated: false,
			bySkill: new Map(),
		});
		expect(s.files).toBe(3);
		expect(s.deviations).toBe(1);
		// The root + its import load upfront; the nested doc is discoverable.
		expect(s.upfrontTokens).toBeGreaterThan(0);
		expect(s.discoverableTokens).toBeGreaterThan(0);
	});

	it("resolves ?tab= values: areas pass through; the retired tree lands on the loadout", () => {
		expect(parseProjectTab("permissions")).toBe("permissions");
		expect(parseProjectTab("tree")).toBe("loadout");
		expect(parseProjectTab("nope")).toBeNull();
		expect(parseProjectTab(null)).toBeNull();
	});
});

// ─── Card copy (no mount needed) ─────────────────────────────────────────────

describe("cardModels", () => {
	const base = {
		skills: { equipped: 4, direct: 1, via: 3, mcp: 1, wontSync: 0 },
		docs: { files: 2, upfrontTokens: 300, discoverableTokens: 40, deviations: 0 },
		permissions: { allow: 1, deny: 1, ask: 0, total: 2, own: 1, inherited: 1 },
		subagents: { agents: 2, disabled: 0, builtins: 0, builtinsOff: 0 },
		usage: null,
	};

	it("names MCP servers and skills that won't sync, and lights attention for the latter", () => {
		const m = cardModels(base, null);
		expect(m.loadout.subText).toBe("1 direct · 3 via bundles · 1 MCP");
		expect(m.loadout.attention).toBeNull();
		const w = cardModels(
			{ ...base, skills: { ...base.skills, wontSync: 2 } },
			null,
		);
		expect(w.loadout.subText).toContain("2 won't sync");
		expect(w.loadout.attention).toBe("warn");
	});

	it("says what the agent docs cost, and speaks up only when the layout deviates", () => {
		const quiet = cardModels(base, null)["agent-docs"];
		expect(quiet.subText).toBe("~300 tokens upfront · ~40 discoverable");
		expect(quiet.foot).toBeNull();
		expect(quiet.attention).toBeNull();
		const text = (n: unknown) =>
			JSON.stringify(n).replace(/[{}"[\],:]/g, " ").replace(/\s+/g, " ");
		const one = cardModels({ ...base, docs: { ...base.docs, deviations: 1 } }, null);
		const two = cardModels({ ...base, docs: { ...base.docs, deviations: 2 } }, null);
		expect(text(one["agent-docs"].foot)).toContain("1 dir needs a fix");
		expect(text(two["agent-docs"].foot)).toContain("2 dirs need a fix");
		expect(one["agent-docs"].attention).toBe("warn");
		const none = cardModels({ ...base, docs: { ...base.docs, files: 0 } }, null);
		expect(none["agent-docs"].subText).toBe("no agent docs yet");
	});

	it("says own · inherited when the project adds rules, and nothing-in-effect at zero", () => {
		const m = cardModels(base, null);
		expect(m.permissions.subText).toBe("1 allow · 1 deny · 0 ask");
		expect(m.permissions.foot).toBe("1 own · 1 inherited");
		const z = cardModels(
			{
				...base,
				permissions: { allow: 0, deny: 0, ask: 0, total: 0, own: 0, inherited: 0 },
			},
			null,
		);
		expect(z.permissions.foot).toBe("no rules in effect");
	});

	it("reports sub-agents as all enabled and drops the built-ins foot when there are none", () => {
		const m = cardModels(base, null);
		expect(m.subagents.subText).toBe("all enabled");
		expect(m.subagents.foot).toBeNull();
	});

	it("says when a source could not be read, and flags it, instead of showing 0", () => {
		const m = cardModels({ ...base, docs: "error", subagents: "error" }, null);
		expect(m["agent-docs"].value).toBeNull();
		expect(m["agent-docs"].subText).toBe("could not read the project");
		expect(m["agent-docs"].attention).toBe("warn");
		expect(m.subagents.subText).toBe("could not list agents");
		expect(m.subagents.attention).toBe("warn");
	});
});

// ─── The navigator on the workspace ──────────────────────────────────────────

function renderWorkspace(route = "/project/example-app") {
	useAppStore.setState({
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
		],
	});
	const client = makeQueryClient();
	primeRegistry(client, sampleRegistry);
	renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client, initialRoute: route },
	);
	return client;
}

function areaNav() {
	return screen.getByRole("navigation", { name: "Project areas" });
}
/** The card buttons only — the loadout card's harness "+" is a button too. */
function areaCards() {
	return Array.from(
		areaNav().querySelectorAll<HTMLButtonElement>(".area-card-hit"),
	);
}

/** A full list item, as the Sub-Agents screen (which the test opens) reads it. */
function agentItem(name: string, disabled: boolean) {
	return {
		name,
		file: `/p/.claude/agents/${name}.md`,
		relpath: `.claude/agents/${name}.md`,
		description: `${name} agent`,
		model: "inherit",
		tools_mode: "all",
		tools: [],
		disallowed_tools: [],
		skills: [],
		color: "",
		disabled,
		builtin: false,
		valid: true,
		warnings: [],
		link: null,
	};
}
function builtin(name: string, disabled: boolean) {
	return { name, model: "inherit", description: `${name} built-in`, disabled, builtin: true };
}

/** Layer area-specific payloads over whatever implementation is installed. */
function mockAreas(payloads: Record<string, unknown>) {
	const mock = vi.mocked(invoke);
	const prev = mock.getMockImplementation();
	mock.mockImplementation(((cmd: string, args?: unknown) =>
		cmd in payloads
			? Promise.resolve(payloads[cmd])
			: (prev?.(cmd as never, args as never) ??
				Promise.resolve(undefined))) as never);
}

describe("ProjectAreaStrip", () => {
	beforeEach(() => {
		resetAreaStripMemory();
	});

	it("is a nav of one button per area, in order, expanded on the dashboard with the loadout current", async () => {
		renderWorkspace();
		await waitFor(() => expect(areaCards()).toHaveLength(5));
		expect(areaNav()).toHaveAttribute("data-expanded", "false");
		expect(areaNav()).not.toHaveAttribute("data-animate");
		const cards = areaCards();
		expect(cards.map((c) => c.getAttribute("aria-current"))).toEqual([
			"page",
			null,
			null,
			null,
			null,
		]);
		// The accessible name carries the area AND the number.
		expect(cards[0]).toHaveAccessibleName("Loadout 3 skills");
		expect(cards[1]).toHaveAccessibleName(/^Agent Docs/);
		expect(cards[2]).toHaveAccessibleName("Permissions 2 rules");
		expect(cards[3]).toHaveAccessibleName(/^Sub-Agents/);
		expect(cards[4]).toHaveAccessibleName(/^Usage/);
		// No tab row anywhere, no tree.
		expect(document.querySelector(".main-subheader")).toBeNull();
		expect(screen.queryByRole("tab", { name: /Tree/ })).toBeNull();
		expect(document.querySelector(".tree-canvas")).toBeNull();
	});

	it("says what each area holds, from the same data the area screens read", async () => {
		renderWorkspace();
		const loadout = (await screen.findAllByRole("button", { name: /^Loadout/ }))[0];
		// example-app: android bundle (2) + brainstorm direct (1).
		expect(loadout).toHaveTextContent("1 direct · 2 via bundles");
		// The harness pills are controls of their own, so they live in the
		// card beside the button, never inside it — and no lead-in word.
		const card = loadout.closest(".area-card")!;
		expect(card).not.toHaveTextContent("syncs to");
		expect(loadout.querySelector("button")).toBeNull();
		expect(within(card as HTMLElement).getByRole("button", { name: /add/i })).toBeInTheDocument();
		// sampleRegistry: 1 allow + 1 deny globally, nothing of its own — drawn
		// as the Permissions screen's kind icons, each named for AT.
		const perms = screen.getByRole("button", { name: "Permissions 2 rules" });
		expect(within(perms).getByLabelText("1 allow")).toBeInTheDocument();
		expect(within(perms).getByLabelText("1 deny")).toBeInTheDocument();
		expect(within(perms).getByLabelText("0 ask")).toBeInTheDocument();
		expect(perms).toHaveTextContent("all inherited from global");
		// Default stubs: no agent docs, no sub-agents — said honestly, not as 0 of nothing.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^Agent Docs/ })).toHaveTextContent(
				"no agent docs yet",
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^Sub-Agents/ })).toHaveTextContent(
				"none in .claude/agents",
			),
		);
	});

	it("mounts each summary read once on the dashboard", async () => {
		renderWorkspace();
		await screen.findAllByRole("button", { name: /^Loadout/ });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^Sub-Agents/ })).toHaveTextContent(
				"none in .claude/agents",
			),
		);
		const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
		expect(calls.filter((c) => c === "list_agent_docs")).toHaveLength(1);
		expect(calls.filter((c) => c === "subagent_list")).toHaveLength(1);
	});

	it("carries attention (amber) when agent docs deviate, and sub-agent enable state", async () => {
		mockAreas({
			list_agent_docs: {
				project_path: "/p",
				all_rels: ["CLAUDE.md"],
				instruction_rels: ["CLAUDE.md"],
				external_imports: [],
				root: { name: "", path: "", dirs: [], files: [] },
				instruction_sets: [
					{ relative_dir: "", verdict: "conflict", flags: [] },
				],
			},
			subagent_list: {
				scope: "project",
				project: "example-app",
				agents_dir: "",
				settings_path: "",
				agents: [agentItem("a", false), agentItem("b", true)],
				builtins: [
					builtin("Plan", false),
					builtin("Explore", true),
					builtin("general-purpose", false),
				],
			},
		});
		renderWorkspace();
		const docs = await screen.findByRole("button", { name: /^Agent Docs/ });
		await waitFor(() =>
			expect(docs.closest(".area-card")).toHaveAttribute("data-attention", "warn"),
		);
		expect(docs).toHaveTextContent("1 dir needs a fix");
		// The marker is an element AT can read, not a CSS pseudo.
		expect(within(docs).getByRole("img", { name: "needs attention" })).toBeInTheDocument();
		const agents = screen.getByRole("button", { name: /^Sub-Agents/ });
		await waitFor(() => expect(agents).toHaveTextContent("1 enabled · 1 off"));
		expect(agents).toHaveTextContent("2/3 built-ins on");
	});

	it("lights the loadout card when the last sync skipped equipped skills", async () => {
		mockSyncReport({
			...sampleSyncReportEnvelope,
			report: {
				...sampleSyncReportEnvelope.report!,
				projects: {
					...sampleSyncReportEnvelope.report!.projects,
					"example-app": {
						...sampleSyncReportEnvelope.report!.projects["example-app"]!,
						affinity_skips: [
							{ skill: "brainstorm", harnesses: ["codex"], reason: "affinity" },
						] as never,
					},
				},
			},
		});
		renderWorkspace();
		const loadout = (await screen.findAllByRole("button", { name: /^Loadout/ }))[0];
		await waitFor(() => expect(loadout).toHaveTextContent("1 won't sync"));
		expect(loadout.closest(".area-card")).toHaveAttribute("data-attention", "warn");
	});

	it("folds into the area screen's navigator: same cards, counts on the labels, and back", async () => {
		renderWorkspace();
		const docsCard = await screen.findByRole("button", { name: /^Agent Docs/ });
		act(() => {
			fireEvent.click(docsCard);
		});
		await screen.findByText("Agent Docs · disk is source of truth");
		// The same nav, right under the header, collapsed and animating shut.
		const nav = areaNav();
		expect(nav).toHaveAttribute("data-expanded", "false");
		expect(nav).not.toHaveAttribute("data-animate");
		expect(nav.previousElementSibling).toHaveClass("main-header");
		const cards = areaCards();
		expect(cards).toHaveLength(5);
		expect(cards[1]).toHaveAttribute("aria-current", "page");
		// The folded row carries each area's number on its label.
		expect(cards[0].querySelector(".label .count")).toHaveTextContent("3");
		expect(cards[2].querySelector(".label .count")).toHaveTextContent("2");
		// And back: the Loadout card returns to the dashboard, unfolding.
		act(() => {
			fireEvent.click(cards[0]);
		});
		await screen.findByRole("button", { name: /^Sync$/ });
		expect(areaNav()).toHaveAttribute("data-expanded", "false");
		expect(areaNav()).not.toHaveAttribute("data-animate");
		expect(areaCards()[0]).toHaveAttribute("aria-current", "page");
	});

	it("deep-links ?tab=permissions into the folded navigator with Permissions current", async () => {
		renderWorkspace("/project/example-app?tab=permissions");
		await screen.findByRole("button", { name: /Save & apply/ });
		expect(areaNav()).toHaveAttribute("data-expanded", "false");
		expect(areaCards()[2]).toHaveAttribute("aria-current", "page");
	});

	it("deep-links ?tab=usage into the folded navigator with Usage current", async () => {
		renderWorkspace("/project/example-app?tab=usage");
		await screen.findByText("usage never scanned");
		expect(areaNav()).toHaveAttribute("data-expanded", "false");
		expect(areaCards()[4]).toHaveAttribute("aria-current", "page");
	});

	it("lands the retired ?tab=tree deep link on the loadout", async () => {
		renderWorkspace("/project/example-app?tab=tree");
		await screen.findAllByRole("button", { name: /^Loadout/ });
		expect(areaNav()).toHaveAttribute("data-expanded", "false");
		expect(areaCards()[0]).toHaveAttribute("aria-current", "page");
	});
});
