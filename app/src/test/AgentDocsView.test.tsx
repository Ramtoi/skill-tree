import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { AgentDocsView } from "@/components/AgentDocsView";
import { primeRegistry, renderWithProviders } from "./helpers";
import type {
	AgentDocsListing,
	AgentDocContent,
	AgentDocFixApplyResult,
	AgentDocFixPlan,
	AgentDocInstructionSet,
	AgentDocWriteResult,
} from "@/types/agentDocs";

function listing(overrides?: Partial<AgentDocsListing>): AgentDocsListing {
	return {
		project_path: "/p",
		all_rels: [
			"CLAUDE.md",
			"AGENTS.md",
			".claude/CLAUDE.md",
			".agents/AGENTS.md",
			"core/canvas/CLAUDE.md",
		],
		truncated: false,
		warning: null,
		required_formats: ["CLAUDE", "AGENT"],
		instruction_sets: [],
		policy: {
			requires_claude: true,
			requires_agent: true,
			strategy: "symlink",
			canonical: "AGENTS.md",
			derived: "CLAUDE.md",
		},
		root: {
			name: "",
			path: "",
			files: [
				{
					rel: "CLAUDE.md",
					name: "CLAUDE.md",
					label: "CLAUDE.md",
					absolute_path: "/p/CLAUDE.md",
					exists: true,
					is_known: true,
					is_discovered: false,
					is_symlink: false,
					symlink_to: null,
					symlink_target_in_project: false,
					can_read: true,
					can_write: true,
					size: 42,
					modified_at: 1716_000_000,
					hash: "hashA",
					error: null,
				},
				{
					rel: "AGENTS.md",
					name: "AGENTS.md",
					label: "AGENTS.md",
					absolute_path: "/p/AGENTS.md",
					exists: false,
					is_known: true,
					is_discovered: false,
					is_symlink: false,
					symlink_to: null,
					symlink_target_in_project: false,
					can_read: false,
					can_write: true,
					size: null,
					modified_at: null,
					hash: null,
					error: null,
				},
			],
			dirs: [
				{
					name: ".claude",
					path: ".claude",
					dirs: [],
					files: [
						{
							rel: ".claude/CLAUDE.md",
							name: "CLAUDE.md",
							label: ".claude/CLAUDE.md",
							absolute_path: "/p/.claude/CLAUDE.md",
							exists: false,
							is_known: true,
							is_discovered: false,
							is_symlink: false,
							symlink_to: null,
							symlink_target_in_project: false,
							can_read: false,
							can_write: true,
							size: null,
							modified_at: null,
							hash: null,
							error: null,
						},
					],
				},
				{
					name: ".agents",
					path: ".agents",
					dirs: [],
					files: [
						{
							rel: ".agents/AGENTS.md",
							name: "AGENTS.md",
							label: ".agents/AGENTS.md",
							absolute_path: "/p/.agents/AGENTS.md",
							exists: false,
							is_known: true,
							is_discovered: false,
							is_symlink: false,
							symlink_to: null,
							symlink_target_in_project: false,
							can_read: false,
							can_write: true,
							size: null,
							modified_at: null,
							hash: null,
							error: null,
						},
					],
				},
				{
					name: "core",
					path: "core",
					files: [],
					dirs: [
						{
							name: "canvas",
							path: "core/canvas",
							dirs: [],
							files: [
								{
									rel: "core/canvas/CLAUDE.md",
									name: "CLAUDE.md",
									label: "core/canvas/CLAUDE.md",
									absolute_path: "/p/core/canvas/CLAUDE.md",
									exists: true,
									is_known: false,
									is_discovered: true,
									is_symlink: false,
									symlink_to: null,
									symlink_target_in_project: false,
									can_read: true,
									can_write: true,
									size: 100,
									modified_at: 1716_000_000,
									hash: "hashNested",
									error: null,
								},
								{
									rel: "core/canvas/AGENTS.md",
									name: "AGENTS.md",
									label: "core/canvas/AGENTS.md",
									absolute_path: "/p/core/canvas/AGENTS.md",
									exists: true,
									is_known: false,
									is_discovered: true,
									is_symlink: false,
									symlink_to: null,
									symlink_target_in_project: false,
									can_read: true,
									can_write: true,
									size: 90,
									modified_at: 1716_000_000,
									hash: "hashNestedAgents",
									error: null,
								},
							],
						},
					],
				},
			],
		},
		...overrides,
	} as AgentDocsListing;
}

function makeSet(
	overrides: Partial<AgentDocInstructionSet> & {
		id: string;
		relative_dir: string;
	},
): AgentDocInstructionSet {
	const dir = overrides.relative_dir;
	const prefix = dir ? `${dir}/` : "";
	return {
		display_path: dir || "root",
		full_path_title: `/p/${dir}`,
		label: dir || "Project Instructions",
		label_source: "path",
		verdict: "canonical",
		flags: [],
		formats: {
			CLAUDE: {
				format: "CLAUDE",
				rel: `${prefix}CLAUDE.md`,
				exists: false,
				file: null,
				is_symlink: false,
				target_kind: "missing",
				required_by_harnesses: ["claude-code"],
				warnings: [],
				title: null,
			},
			AGENT: {
				format: "AGENT",
				rel: `${prefix}AGENTS.md`,
				exists: false,
				file: null,
				is_symlink: false,
				target_kind: "missing",
				required_by_harnesses: ["codex"],
				warnings: [],
				title: null,
			},
		},
		legacy: [],
		appendix: null,
		required_formats: ["CLAUDE", "AGENT"],
		warnings: [],
		...overrides,
	} as AgentDocInstructionSet;
}

/** The screenshot shape: real CLAUDE.md + legacy AGENT.md, no AGENTS.md —
 *  root deviates (claude_only + legacy), nested canvas set is canonical. */
function deviatingListing(): AgentDocsListing {
	const base = listing();
	const claude = base.root.files[0];
	const nestedClaude = base.root.dirs[2].dirs[0].files[0];
	base.instruction_sets = [
		makeSet({
			id: "root",
			relative_dir: "",
			label: "Project Instructions",
			label_source: "heading:CLAUDE",
			verdict: "claude_only",
			flags: ["legacy"],
			formats: {
				CLAUDE: {
					format: "CLAUDE",
					rel: "CLAUDE.md",
					exists: true,
					file: claude,
					is_symlink: false,
					target_kind: "none",
					required_by_harnesses: ["claude-code"],
					warnings: [],
					title: "Project Instructions",
				},
				AGENT: {
					format: "AGENT",
					rel: "AGENTS.md",
					exists: false,
					file: base.root.files[1],
					is_symlink: false,
					target_kind: "missing",
					required_by_harnesses: ["codex"],
					warnings: [],
					title: null,
				},
			},
			legacy: [
				{
					rel: "AGENT.md",
					name: "AGENT.md",
					label: "AGENT.md",
					absolute_path: "/p/AGENT.md",
					exists: true,
					is_known: false,
					is_discovered: true,
					is_symlink: true,
					symlink_to: "CLAUDE.md",
					symlink_target_in_project: true,
					can_read: true,
					can_write: false,
					size: 9,
					modified_at: 1716_000_000,
					hash: null,
					error: null,
				},
			],
		}),
		makeSet({
			id: "core/canvas",
			relative_dir: "core/canvas",
			label: "Canvas AI Module",
			label_source: "heading:AGENT",
			verdict: "canonical",
			formats: {
				CLAUDE: {
					format: "CLAUDE",
					rel: "core/canvas/CLAUDE.md",
					exists: true,
					file: nestedClaude,
					is_symlink: false,
					target_kind: "none",
					required_by_harnesses: ["claude-code"],
					warnings: [],
					title: "Canvas AI Module",
				},
				AGENT: {
					format: "AGENT",
					rel: "core/canvas/AGENTS.md",
					exists: true,
					file: {
						...nestedClaude,
						rel: "core/canvas/AGENTS.md",
						name: "AGENTS.md",
						absolute_path: "/p/core/canvas/AGENTS.md",
					},
					is_symlink: false,
					target_kind: "none",
					required_by_harnesses: ["codex"],
					warnings: [],
					title: "Canvas AI Module",
				},
			},
		}),
	];
	return base;
}

/** Fully canonical project: real AGENTS.md, derived CLAUDE.md, no flags. */
function canonicalListing(): AgentDocsListing {
	const base = listing();
	base.root.files[0] = {
		...base.root.files[0],
		is_symlink: true,
		symlink_to: "AGENTS.md",
		symlink_target_in_project: true,
	};
	base.root.files[1] = {
		...base.root.files[1],
		exists: true,
		size: 42,
		hash: "hashAgents",
		modified_at: 1716_000_000,
	};
	base.root.dirs = base.root.dirs.filter((d) => d.name !== "core");
	base.all_rels = base.all_rels.filter((r) => r !== "core/canvas/CLAUDE.md");
	base.instruction_sets = [
		makeSet({
			id: "root",
			relative_dir: "",
			label: "Project Instructions",
			verdict: "canonical",
			formats: {
				CLAUDE: {
					format: "CLAUDE",
					rel: "CLAUDE.md",
					exists: true,
					file: base.root.files[0],
					is_symlink: true,
					target_kind: "sibling",
					required_by_harnesses: ["claude-code"],
					warnings: [],
					title: null,
				},
				AGENT: {
					format: "AGENT",
					rel: "AGENTS.md",
					exists: true,
					file: base.root.files[1],
					is_symlink: false,
					target_kind: "none",
					required_by_harnesses: ["codex"],
					warnings: [],
					title: "Project Instructions",
				},
			},
		}),
	];
	return base;
}

function fixPlan(): AgentDocFixPlan {
	return {
		strategy: "symlink",
		policy: {
			requires_claude: true,
			requires_agent: true,
			canonical: "AGENTS.md",
			derived: "CLAUDE.md",
		},
		steps: [
			{
				id: 0,
				dir: "",
				action: "promote",
				optional: false,
				selected: true,
				paths: ["CLAUDE.md", "AGENTS.md"],
				preconditions: [{ rel: "CLAUDE.md", kind: "file", hash: "abc" }],
				details: "rename CLAUDE.md → AGENTS.md, derive CLAUDE.md (symlink)",
			},
			{
				id: 1,
				dir: "",
				action: "remove_legacy_link",
				optional: false,
				selected: true,
				paths: ["AGENT.md"],
				preconditions: [
					{ rel: "AGENT.md", kind: "symlink", target: "CLAUDE.md" },
				],
				details:
					"remove legacy link AGENT.md (→ CLAUDE.md) — no configured agent reads AGENT.md",
			},
			{
				id: 2,
				dir: "agents",
				action: "promote",
				optional: true,
				selected: false,
				paths: ["agents/CLAUDE.md", "agents/AGENTS.md"],
				preconditions: [{ rel: "agents/CLAUDE.md", kind: "file", hash: "n" }],
				details:
					"rename agents/CLAUDE.md → agents/AGENTS.md, derive agents/CLAUDE.md (symlink)",
			},
		],
		attention: [],
		flagged: [],
	};
}

function content(rel: string, body: string, hash = "hashA"): AgentDocContent {
	return {
		rel,
		absolute_path: `/p/${rel}`,
		content: body,
		size: body.length,
		modified_at: 1716_000_000,
		hash,
		is_symlink: false,
		symlink_to: null,
		oversized: false,
		is_derived_pointer: false,
	};
}

function writeResult(rel: string, hash: string): AgentDocWriteResult {
	return {
		written: [
			{
				rel,
				name: rel.split("/").pop() ?? rel,
				label: rel,
				absolute_path: `/p/${rel}`,
				exists: true,
				is_known: true,
				is_discovered: false,
				is_symlink: false,
				symlink_to: null,
				symlink_target_in_project: false,
				can_read: true,
				can_write: true,
				size: 7,
				modified_at: 1716_000_001,
				hash,
				error: null,
			},
		],
		derived: false,
	};
}

function setupInvoke(
	handlers: Partial<{
		list_agent_docs: AgentDocsListing;
		read_agent_doc: (rel: string) => AgentDocContent;
		write_agent_doc:
			| AgentDocWriteResult
			| ((args: Record<string, unknown>) => AgentDocWriteResult);
		write_error?: string;
		fix_plan: AgentDocFixPlan;
		fix_apply: (plan: AgentDocFixPlan) => AgentDocFixApplyResult;
	}>,
) {
	vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === "list_agent_docs") {
			return handlers.list_agent_docs ?? listing();
		}
		if (cmd === "read_agent_doc") {
			const a = (args ?? {}) as { relativePath: string };
			return handlers.read_agent_doc
				? handlers.read_agent_doc(a.relativePath)
				: content(a.relativePath, "# stub\n");
		}
		if (cmd === "write_agent_doc") {
			if (handlers.write_error) throw handlers.write_error;
			if (typeof handlers.write_agent_doc === "function") {
				return handlers.write_agent_doc(
					(args ?? {}) as Record<string, unknown>,
				);
			}
			return handlers.write_agent_doc ?? writeResult("CLAUDE.md", "hashB");
		}
		if (cmd === "agent_docs_fix_plan") {
			return handlers.fix_plan ?? fixPlan();
		}
		if (cmd === "agent_docs_fix_apply") {
			const a = (args ?? {}) as { plan: AgentDocFixPlan };
			return handlers.fix_apply
				? handlers.fix_apply(a.plan)
				: ({
						applied: true,
						executed: [{ id: 0, dir: "", action: "promote" }],
						backups: ["/tmp/b/CLAUDE.md.ts"],
					} satisfies AgentDocFixApplyResult);
		}
		if (cmd === "agent_docs_strategy_get") {
			return {
				global: "symlink",
				project: "example-app",
				override_value: null,
				effective: "symlink",
			};
		}
		if (cmd === "hub_cmd") return { success: true, output: "" };
		if (cmd === "harness_list") return [];
		return undefined;
	});
}

function renderView() {
	const { client } = renderWithProviders(
		<AgentDocsView
			projectName="example-app"
			projectPath="/p"
			view="agent-docs"
			onChangeView={() => {}}
			projectHarnesses={["claude-code", "codex"]}
		/>,
	);
	primeRegistry(client);
	return { client };
}

describe("AgentDocsView", () => {
	it("renders header with project name, path, and disk-source-of-truth crumb", async () => {
		setupInvoke({});
		renderView();
		await waitFor(() => {
			// Project name appears in the header AND in the file map tree root.
			expect(screen.getAllByText("example-app").length).toBeGreaterThanOrEqual(
				1,
			);
		});
		expect(screen.getByText("/p")).toBeInTheDocument();
		expect(
			screen.getByText("Agent Docs · disk is source of truth"),
		).toBeInTheDocument();
		// View chips
		expect(screen.getByText("Loadout")).toBeInTheDocument();
		expect(screen.getByText("Tree")).toBeInTheDocument();
		expect(screen.getAllByText("Agent Docs").length).toBeGreaterThanOrEqual(1);
		// Refresh (in overflow kebab) + Save (primary)
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /More actions/i }));
		});
		expect(screen.getByText("Refresh from disk")).toBeInTheDocument();
		expect(screen.getByTestId("agent-docs-save")).toBeInTheDocument();
	});

	it("shows file map count and known + discovered files", async () => {
		setupInvoke({});
		renderView();
		await waitFor(() => {
			// Existing rows: CLAUDE.md (root) + core/canvas/CLAUDE.md = 2 existing
			// out of 5 total known+discovered.
			expect(screen.getByText("2/5")).toBeInTheDocument();
		});
		// Known missing files visible as rows.
		expect(screen.getByText(".claude/")).toBeInTheDocument();
		expect(screen.getByText(".agents/")).toBeInTheDocument();
		// Discovered nested folder visible.
		expect(screen.getByText("core/")).toBeInTheDocument();
	});

	it("renders project-level token summary split into upfront vs discoverable", async () => {
		setupInvoke({});
		renderView();
		// Default fixture: CLAUDE.md exists at 42 bytes → ~11 tokens upfront.
		// core/canvas/CLAUDE.md exists at 100 bytes → ~25 tokens discoverable.
		await waitFor(() => {
			expect(screen.getByText("~11")).toBeInTheDocument();
			expect(screen.getByText("~25")).toBeInTheDocument();
		});
		expect(screen.getByTestId("agent-docs-token-summary")).toBeInTheDocument();
		expect(screen.getByText("context")).toBeInTheDocument();
		expect(screen.getByText("upfront")).toBeInTheDocument();
		expect(screen.getByText("discoverable")).toBeInTheDocument();
	});

	it("shows MISSING pill on absent known files", async () => {
		setupInvoke({});
		renderView();
		await waitFor(() => {
			// AGENTS.md row exists and absent.
			const rows = screen.getAllByRole("button");
			const agent = rows.find(
				(b) =>
					within(b).queryByText("AGENTS.md") &&
					within(b).queryByText("absent"),
			);
			expect(agent).toBeTruthy();
		});
	});

	it("renders content after lazy read; edit marks UNSAVED; Save calls write_agent_doc", async () => {
		setupInvoke({
			read_agent_doc: () => content("CLAUDE.md", "# original\n", "hashA"),
			write_agent_doc: writeResult("CLAUDE.md", "hashAfter"),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# original/)).toBeInTheDocument();
		});
		// Save initially disabled.
		const save = screen.getByTestId("agent-docs-save");
		expect(save).toBeDisabled();
		// Edit content
		const ta = screen.getByDisplayValue(/# original/);
		act(() => {
			fireEvent.change(ta, { target: { value: "# original\nmore\n" } });
		});
		// UNSAVED pill appears in both the file row AND the editor header.
		expect(screen.getAllByText("UNSAVED").length).toBeGreaterThanOrEqual(1);
		expect(save).not.toBeDisabled();
		// Click save
		act(() => {
			fireEvent.click(save);
		});
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"write_agent_doc",
				expect.objectContaining({
					projectPath: "/p",
					relativePath: "CLAUDE.md",
					content: "# original\nmore\n",
					expectedHash: "hashA",
					overwrite: false,
				}),
			);
		});
	});

	it("canonicalizing create follows the real written file", async () => {
		// Multi-harness project, no root docs: drafting CLAUDE.md writes the
		// canonical AGENTS.md + derived CLAUDE.md pair.
		const empty = listing();
		empty.root.files[0] = {
			...empty.root.files[0],
			exists: false,
			hash: null,
			size: null,
			modified_at: null,
		};
		empty.root.dirs = empty.root.dirs.filter((d) => d.name !== "core");
		empty.all_rels = empty.all_rels.filter(
			(r) => r !== "core/canvas/CLAUDE.md",
		);
		setupInvoke({
			list_agent_docs: empty,
			write_agent_doc: () => ({
				written: [
					writeResult("AGENTS.md", "hashAgents").written[0],
					{
						...writeResult("CLAUDE.md", "hashDerived").written[0],
						is_symlink: true,
						symlink_to: "AGENTS.md",
						symlink_target_in_project: true,
					},
				],
				derived: true,
			}),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByText(/NEW · NOT YET ON DISK/i)).toBeInTheDocument();
		});
		const ta = document.querySelector(
			".agent-docs-editor textarea",
		) as HTMLTextAreaElement;
		act(() => {
			fireEvent.change(ta, { target: { value: "# Root doc\n" } });
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("agent-docs-save"));
		});
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"write_agent_doc",
				expect.objectContaining({
					relativePath: "CLAUDE.md",
					content: "# Root doc\n",
				}),
			);
		});
		// The write produced AGENTS.md (real) + derived CLAUDE.md; the editor
		// follows the real written file.
		await waitFor(() => {
			expect(document.querySelector(".ad-doc-name")?.textContent).toBe(
				"AGENTS.md",
			);
		});
	});

	it("mounts the applied-snippets strip for a real file and blocks it while dirty", async () => {
		setupInvoke({
			read_agent_doc: () => content("CLAUDE.md", "# original\n", "hashA"),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# original/)).toBeInTheDocument();
		});
		// Strip is present for an existing real file (default scan mock = empty).
		expect(screen.getByText("Applied snippets")).toBeInTheDocument();
		// Dirty buffer flips the strip into its blocked state.
		act(() => {
			fireEvent.change(screen.getByDisplayValue(/# original/), {
				target: { value: "# original\nmore\n" },
			});
		});
		expect(screen.getByText(/save to manage/)).toBeInTheDocument();
	});

	it("shows conflict modal on write conflict and supports Reload + Overwrite", async () => {
		const conflictErr = JSON.stringify({
			kind: "conflict",
			rel: "CLAUDE.md",
			current_hash: "hashOther",
			current_size: 50,
			modified_at: 1716_000_010,
		});
		// First write rejects with a conflict; subsequent write (overwrite) succeeds.
		let firstWrite = true;
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown) => {
				if (cmd === "list_agent_docs") return listing();
				if (cmd === "read_agent_doc") {
					const a = (args ?? {}) as { relativePath: string };
					return content(a.relativePath, "# original\n", "hashA");
				}
				if (cmd === "write_agent_doc") {
					if (firstWrite) {
						firstWrite = false;
						return Promise.reject(conflictErr);
					}
					return writeResult("CLAUDE.md", "hashFinal");
				}
				if (cmd === "harness_list") return [];
				return undefined;
			},
		);
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# original/)).toBeInTheDocument();
		});
		const ta = screen.getByDisplayValue(/# original/);
		act(() => {
			fireEvent.change(ta, { target: { value: "# user\n" } });
		});
		const save = screen.getByTestId("agent-docs-save");
		await act(async () => {
			fireEvent.click(save);
		});
		await waitFor(() => {
			// Modal title text rendered inside .ad-modal-head
			expect(screen.getByText("CLAUDE.md changed on disk")).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /Reload from disk/i }),
		).toBeInTheDocument();
		const overwrite = screen.getByRole("button", {
			name: /Overwrite with my edits/i,
		});
		act(() => {
			fireEvent.click(overwrite);
		});
		await waitFor(() => {
			expect(vi.mocked(invoke)).toHaveBeenCalledWith(
				"write_agent_doc",
				expect.objectContaining({ overwrite: true }),
			);
		});
	});

	it("Refresh on dirty buffer prompts discard confirmation", async () => {
		setupInvoke({
			read_agent_doc: () => content("CLAUDE.md", "# original\n", "hashA"),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# original/)).toBeInTheDocument();
		});
		const ta = screen.getByDisplayValue(/# original/);
		act(() => {
			fireEvent.change(ta, { target: { value: "# dirty\n" } });
		});
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /More actions/i }));
		});
		const refresh = screen.getByText("Refresh from disk");
		act(() => {
			fireEvent.click(refresh);
		});
		expect(screen.getByText(/Discard unsaved edits/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Discard & reload/i }),
		).toBeInTheDocument();
	});

	it("missing file shows NEW · NOT YET ON DISK pill and Create primary action", async () => {
		// Listing where CLAUDE.md doesn't exist, no nested files.
		const missingClaude = listing();
		missingClaude.root.files[0].exists = false;
		missingClaude.root.files[0].hash = null;
		missingClaude.root.files[0].size = null;
		missingClaude.root.files[0].modified_at = null;
		missingClaude.root.dirs = missingClaude.root.dirs.filter(
			(d) => d.name !== "core",
		);
		missingClaude.all_rels = missingClaude.all_rels.filter(
			(r) => r !== "core/canvas/CLAUDE.md",
		);
		setupInvoke({ list_agent_docs: missingClaude });
		renderView();
		await waitFor(() => {
			expect(screen.getByText(/NEW · NOT YET ON DISK/i)).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /Create\s*⌘S/i }),
		).toBeInTheDocument();
	});

	// ── Status line + badges (one model, quiet when green) ──

	it("renders the quiet status line with root summary and check when all-canonical", async () => {
		setupInvoke({ list_agent_docs: canonicalListing() });
		renderView();
		await waitFor(() => {
			expect(
				screen.getByText("root: AGENTS.md · CLAUDE.md derived (symlink)"),
			).toBeInTheDocument();
		});
		expect(screen.getByTestId("agent-docs-canonical-ok")).toBeInTheDocument();
		// No banner, no badges, no legacy linking chrome.
		expect(
			screen.queryByTestId("agent-docs-fix-banner"),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/BOTH linked/)).not.toBeInTheDocument();
		expect(screen.queryByText(/link AGENT/)).not.toBeInTheDocument();
		expect(screen.queryByText("LEGACY")).not.toBeInTheDocument();
	});

	it("badges only the deviating sets; canonical sets render silently", async () => {
		setupInvoke({ list_agent_docs: deviatingListing() });
		renderView();
		await waitFor(() => {
			expect(screen.getByText("Project Instructions")).toBeInTheDocument();
		});
		// Root set deviates: FIX + LEGACY badges.
		expect(screen.getByText("FIX")).toBeInTheDocument();
		expect(screen.getByText("LEGACY")).toBeInTheDocument();
		// Nested canonical set: label visible, no badge inside its row.
		const nested = screen
			.getAllByRole("button")
			.find((b) => within(b).queryByText("Canvas AI Module"));
		expect(nested).toBeTruthy();
		expect(within(nested!).queryByText("FIX")).not.toBeInTheDocument();
		expect(within(nested!).queryByText("LEGACY")).not.toBeInTheDocument();
	});

	it("collapses and re-expands a folder of instruction sets", async () => {
		setupInvoke({ list_agent_docs: deviatingListing() });
		renderView();
		await waitFor(() => {
			expect(screen.getByText("Canvas AI Module")).toBeInTheDocument();
		});
		const folder = screen.getByText("core/canvas/");
		fireEvent.click(folder);
		await waitFor(() => {
			expect(screen.queryByText("Canvas AI Module")).not.toBeInTheDocument();
		});
		fireEvent.click(folder);
		await waitFor(() => {
			expect(screen.getByText("Canvas AI Module")).toBeInTheDocument();
		});
	});

	it("grounds instruction-set selection in the canonical real file", async () => {
		setupInvoke({
			list_agent_docs: deviatingListing(),
			read_agent_doc: (rel) => content(rel, `# ${rel}\n`, rel),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# CLAUDE.md/)).toBeInTheDocument();
		});
		// The nested set has a real AGENTS.md → editing grounds there, not in
		// the CLAUDE.md companion.
		fireEvent.click(screen.getByText("Canvas AI Module"));
		await waitFor(() => {
			expect(
				screen.getByDisplayValue(/# core\/canvas\/AGENTS.md/),
			).toBeInTheDocument();
		});
		expect(screen.getByText(/editing/)).toHaveTextContent(
			"editing core/canvas/AGENTS.md",
		);
	});

	// ── Fix banner ──

	it("shows one banner with one action when the layout deviates", async () => {
		setupInvoke({ list_agent_docs: deviatingListing() });
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		expect(banner).toHaveTextContent(/other agents read AGENTS\.md/i);
		expect(
			within(banner).getByRole("button", { name: /Fix layout/i }),
		).toBeInTheDocument();
		// No second layout-action surface anywhere.
		expect(screen.queryByText(/Apply links/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Migrate now/i)).not.toBeInTheDocument();
	});

	it("previews the plan, toggles an opt-in nested step, and applies", async () => {
		const applied: AgentDocFixPlan[] = [];
		setupInvoke({
			list_agent_docs: deviatingListing(),
			fix_apply: (plan) => {
				applied.push(plan);
				return {
					applied: true,
					executed: [
						{ id: 0, dir: "", action: "promote" },
						{ id: 1, dir: "", action: "remove_legacy_link" },
						{ id: 2, dir: "agents", action: "promote" },
					],
					backups: ["/tmp/b/a", "/tmp/b/b"],
				};
			},
		});
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		await act(async () => {
			fireEvent.click(
				within(banner).getByRole("button", { name: /Fix layout/i }),
			);
		});
		// Plan dialog lists required and opt-in steps.
		await waitFor(() => {
			expect(
				screen.getByText(/rename CLAUDE\.md → AGENTS\.md/),
			).toBeInTheDocument();
		});
		expect(
			screen.getByText(/remove legacy link AGENT\.md/),
		).toBeInTheDocument();
		// Toggle the opt-in nested promotion (the other checkbox is the
		// commit opt-in, which carries its own testid).
		const commitBox = screen.getByTestId("agent-docs-commit-optin");
		const optin = screen
			.getAllByRole("checkbox")
			.find((cb) => cb !== commitBox)!;
		expect(optin).not.toBeChecked();
		act(() => {
			fireEvent.click(optin);
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("agent-docs-fix-apply"));
		});
		await waitFor(() => {
			expect(applied.length).toBe(1);
		});
		const nestedStep = applied[0].steps.find((s) => s.id === 2);
		expect(nestedStep?.selected).toBe(true);
		// Dialog closes after a successful apply.
		await waitFor(() => {
			expect(
				screen.queryByTestId("agent-docs-fix-apply"),
			).not.toBeInTheDocument();
		});
	});

	it("passes the opt-in commit flag through to fix apply", async () => {
		const applyArgs: Array<Record<string, unknown>> = [];
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown) => {
				if (cmd === "list_agent_docs") return deviatingListing();
				if (cmd === "read_agent_doc") {
					const a = (args ?? {}) as { relativePath: string };
					return content(a.relativePath, "# stub\n");
				}
				if (cmd === "agent_docs_fix_plan") return fixPlan();
				if (cmd === "agent_docs_fix_apply") {
					applyArgs.push((args ?? {}) as Record<string, unknown>);
					return {
						applied: true,
						executed: [{ id: 0, dir: "", action: "promote" }],
						backups: [],
						commit: { committed: true, sha: "abc1234", reason: null },
					};
				}
				if (cmd === "harness_list") return [];
				return undefined;
			},
		);
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		await act(async () => {
			fireEvent.click(
				within(banner).getByRole("button", { name: /Fix layout/i }),
			);
		});
		const optin = await screen.findByTestId("agent-docs-commit-optin");
		act(() => {
			fireEvent.click(optin);
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("agent-docs-fix-apply"));
		});
		await waitFor(() => {
			expect(applyArgs.length).toBe(1);
		});
		expect(applyArgs[0].commit).toBe(true);
	});

	it("defaults to no commit when the checkbox is untouched", async () => {
		const applyArgs: Array<Record<string, unknown>> = [];
		setupInvoke({
			list_agent_docs: deviatingListing(),
			fix_apply: () => ({
				applied: true,
				executed: [{ id: 0, dir: "", action: "promote" }],
				backups: [],
			}),
		});
		const base = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "agent_docs_fix_apply") {
				applyArgs.push((args ?? {}) as Record<string, unknown>);
			}
			return base(cmd, args as never);
		});
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		await act(async () => {
			fireEvent.click(
				within(banner).getByRole("button", { name: /Fix layout/i }),
			);
		});
		await screen.findByTestId("agent-docs-fix-apply");
		await act(async () => {
			fireEvent.click(screen.getByTestId("agent-docs-fix-apply"));
		});
		await waitFor(() => {
			expect(applyArgs.length).toBe(1);
		});
		expect(applyArgs[0].commit).toBe(false);
	});

	it("aborts cleanly when disk changed between preview and apply", async () => {
		setupInvoke({
			list_agent_docs: deviatingListing(),
			fix_apply: () => ({
				applied: false,
				error: "disk_changed",
				mismatches: [{ step: 0, rel: "CLAUDE.md" }],
				executed: [],
				backups: [],
			}),
		});
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		await act(async () => {
			fireEvent.click(
				within(banner).getByRole("button", { name: /Fix layout/i }),
			);
		});
		await waitFor(() => {
			expect(
				screen.getByText(/rename CLAUDE\.md → AGENTS\.md/),
			).toBeInTheDocument();
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("agent-docs-fix-apply"));
		});
		// Dialog closes without partial application; the banner stays so the
		// user can re-preview the changed disk state.
		await waitFor(() => {
			expect(
				screen.queryByTestId("agent-docs-fix-apply"),
			).not.toBeInTheDocument();
		});
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"agent_docs_fix_apply",
			expect.objectContaining({ projectPath: "/p" }),
		);
		expect(screen.getByTestId("agent-docs-fix-banner")).toBeInTheDocument();
	});

	it("blocks fix apply while an editor buffer is dirty (preview still allowed)", async () => {
		setupInvoke({
			list_agent_docs: deviatingListing(),
			read_agent_doc: () => content("CLAUDE.md", "# original\n", "hashA"),
		});
		renderView();
		await waitFor(() => {
			expect(screen.getByDisplayValue(/# original/)).toBeInTheDocument();
		});
		act(() => {
			fireEvent.change(screen.getByDisplayValue(/# original/), {
				target: { value: "# dirty\n" },
			});
		});
		const banner = screen.getByTestId("agent-docs-fix-banner");
		await act(async () => {
			fireEvent.click(
				within(banner).getByRole("button", { name: /Fix layout/i }),
			);
		});
		await waitFor(() => {
			expect(
				screen.getByText(/rename CLAUDE\.md → AGENTS\.md/),
			).toBeInTheDocument();
		});
		expect(screen.getByTestId("agent-docs-fix-apply")).toBeDisabled();
		expect(screen.getAllByText(/save or discard/i).length).toBeGreaterThan(0);
	});

	it("offers Compare with explicit keeps for a divergent root conflict", async () => {
		const conflictList = deviatingListing();
		const rootSet = conflictList.instruction_sets[0];
		rootSet.verdict = "conflict";
		rootSet.flags = [];
		rootSet.formats.AGENT.exists = true;
		const resolveCalls: Array<{ op: string }> = [];
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown) => {
				if (cmd === "list_agent_docs") return conflictList;
				if (cmd === "read_agent_doc") {
					const a = (args ?? {}) as { relativePath: string };
					return content(a.relativePath, `# ${a.relativePath} version\n`);
				}
				if (cmd === "agent_docs_resolve") {
					const a = (args ?? {}) as { op: string };
					resolveCalls.push(a);
					return { applied: true, op: a.op, backups: ["/tmp/b"] };
				}
				if (cmd === "harness_list") return [];
				return undefined;
			},
		);
		renderView();
		const banner = await screen.findByTestId("agent-docs-fix-banner");
		expect(banner).toHaveTextContent(/diverged/i);
		await act(async () => {
			fireEvent.click(within(banner).getByRole("button", { name: /Compare/i }));
		});
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Keep AGENTS\.md/i }),
			).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /Keep CLAUDE\.md/i }),
		).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Keep AGENTS\.md/i }));
		});
		await waitFor(() => {
			expect(resolveCalls).toEqual([expect.objectContaining({ op: "keep_agents" })]);
		});
	});

	it("renders a derived-pointer stub for an @AGENTS.md CLAUDE.md and offers to open AGENTS.md", async () => {
		const pointerContent = (rel: string) => ({
			...content(rel, "@AGENTS.md\n"),
			is_derived_pointer: rel === "CLAUDE.md",
		});
		vi.mocked(invoke).mockImplementation(
			async (cmd: string, args?: unknown) => {
				if (cmd === "list_agent_docs") return listing();
				if (cmd === "read_agent_doc") {
					const a = (args ?? {}) as { relativePath: string };
					return pointerContent(a.relativePath);
				}
				if (cmd === "write_agent_doc") return writeResult("CLAUDE.md", "hashB");
				if (cmd === "harness_list") return [];
				if (cmd === "hub_cmd") return { success: true, output: "" };
				return undefined;
			},
		);
		renderView();
		// Selecting the root CLAUDE.md should surface the derived-pointer stub.
		const claudeRows = await screen.findAllByRole("button", {
			name: /CLAUDE\.md/,
		});
		const rootRow = claudeRows.find((b) =>
			b.title?.endsWith("/p/CLAUDE.md"),
		);
		expect(rootRow).toBeTruthy();
		await act(async () => {
			fireEvent.click(rootRow!);
		});
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Open AGENTS\.md/i }),
			).toBeInTheDocument();
		});
		expect(screen.getByText(/Derived from/i)).toBeInTheDocument();
	});
});
