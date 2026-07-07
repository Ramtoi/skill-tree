import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { SubagentList } from "@/components/subagents/SubagentList";
import { SubagentEditor } from "@/screens/SubagentEditor";
import { ToastContainer } from "@/components/Toast";
import { useAppStore, type HarnessStatus } from "@/store";
import { queryClient } from "@/lib/queryClient";
import {
	renderWithProviders,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeHarnesses(): HarnessStatus[] {
	return [
		{
			id: "claude-code",
			label: "Claude Code",
			installed: true,
			on_globally: true,
			used_by_projects: [],
			path: "/usr/bin/claude",
			version: "1.0",
			agents: {
				supported: true,
				format: "md",
				agents_dir: "~/.claude/agents",
				project_agents_dir: ".claude/agents",
			},
		},
		{
			id: "codex",
			label: "Codex",
			installed: true,
			on_globally: false,
			used_by_projects: [],
			path: "/usr/bin/codex",
			version: "0.142.2",
			agents: {
				supported: true,
				format: "toml",
				agents_dir: "~/.codex/agents",
				project_agents_dir: ".codex/agents",
			},
		},
		{
			id: "pi",
			label: "Pi",
			installed: true,
			on_globally: false,
			used_by_projects: [],
			path: "/usr/bin/pi",
			version: "0.1",
			agents: {
				supported: false,
				format: null,
				agents_dir: null,
				project_agents_dir: null,
			},
		},
	];
}

const CLAUDE_DRIFT_DESC = "Drift twin — the Claude description.";
const CODEX_DRIFT_DESC = "Drift twin — the Codex description (diverged).";

interface Agent {
	name: string;
	description: string;
	body: string;
	skills: string[];
	model: string;
	sandbox_mode?: string;
}

/**
 * A compact stateful backend that mirrors the D3 wire contract so the real
 * components run unmodified — two user-scope stores + a links set, with
 * link/unlink/drift/co-write/resolve. Seeds:
 *  - clean-twin : linked, no drift        (co-write / unlink / delete)
 *  - drift-twin : linked, description drift (banner / resolve / field lock)
 *  - sug-twin   : same name in both, NOT linked (suggestion)
 *  - solo-agent : claude only              (copy-to)
 */
function makeBackend() {
	const claude: Agent[] = [
		{
			name: "clean-twin",
			description: "A cleanly-linked twin.",
			body: "Shared body.",
			skills: ["code-review"],
			model: "sonnet",
		},
		{
			name: "drift-twin",
			description: CLAUDE_DRIFT_DESC,
			body: "Shared drift body.",
			skills: [],
			model: "",
		},
		{
			name: "sug-twin",
			description: "Same name in both, unlinked.",
			body: "Suggest body.",
			skills: [],
			model: "",
		},
		{
			name: "solo-agent",
			description: "Exists only in Claude.",
			body: "Solo body.",
			skills: [],
			model: "",
		},
	];
	const codex: Agent[] = [
		{
			name: "clean-twin",
			description: "A cleanly-linked twin.",
			body: "Shared body.",
			skills: ["code-review"],
			model: "",
			sandbox_mode: "read-only",
		},
		{
			name: "drift-twin",
			description: CODEX_DRIFT_DESC,
			body: "Shared drift body.",
			skills: [],
			model: "",
			sandbox_mode: "",
		},
		{
			name: "sug-twin",
			description: "Same name in both, unlinked.",
			body: "Suggest body.",
			skills: [],
			model: "",
			sandbox_mode: "",
		},
	];
	const links = new Set<string>(["clean-twin", "drift-twin"]);

	const otherStore = (h: string) => (h === "codex" ? claude : codex);
	const otherH = (h: string) => (h === "codex" ? "claude-code" : "codex");
	const nameSet = (s: Agent[]) => new Set(s.map((a) => a.name));
	const core = (a: Agent) => ({
		description: a.description,
		instructions: (a.body || "").replace(/\s+$/, ""),
		skills: [...a.skills],
	});
	function drift(name: string) {
		const c = claude.find((a) => a.name === name);
		const x = codex.find((a) => a.name === name);
		if (!c || !x) return [];
		const cc = core(c);
		const xc = core(x);
		const out: Array<{ field: string; values: Record<string, unknown> }> = [];
		for (const f of ["description", "instructions", "skills"] as const) {
			const eq =
				f === "skills"
					? JSON.stringify(cc.skills) === JSON.stringify(xc.skills)
					: cc[f] === xc[f];
			if (!eq)
				out.push({ field: f, values: { "claude-code": cc[f], codex: xc[f] } });
		}
		return out;
	}
	function linkInfo(a: Agent, h: string) {
		const others = nameSet(otherStore(h));
		if (links.has(a.name))
			return {
				linked: true,
				harnesses: ["claude-code", "codex"],
				twin_lost: !others.has(a.name),
				suggested: false,
			};
		if (others.has(a.name))
			return {
				linked: false,
				harnesses: [otherH(h), h].sort(),
				twin_lost: false,
				suggested: true,
			};
		return null;
	}
	function listItem(a: Agent, h: string) {
		const isCodex = h === "codex";
		return {
			name: a.name,
			file: `${a.name}.${isCodex ? "toml" : "md"}`,
			relpath: `${a.name}.${isCodex ? "toml" : "md"}`,
			description: a.description,
			model: a.model,
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			skills: a.skills,
			color: "",
			disabled: false,
			builtin: false,
			valid: true,
			warnings: [],
			link: linkInfo(a, h),
			...(isCodex
				? {
						sandbox_mode: a.sandbox_mode ?? "",
						model_reasoning_effort: "",
						nickname_candidates: [],
					}
				: {}),
		};
	}
	const attachable = [
		{
			name: "code-review",
			description: "Review the diff.",
			resolved: true,
			invocable: true,
			project_only: false,
			attachable: true,
			reason: "",
		},
	];

	return function dispatch(cmd: string, args?: unknown): unknown {
		const a = (args ?? {}) as {
			harnessId?: string;
			name?: string;
			scope?: string;
			copyFrom?: string;
			decisions?: Record<string, string>;
			linkAction?: string;
			payload?: {
				harness?: string;
				original_name?: string | null;
				body?: string;
				safe?: { name: string; description: string; skills: string[] };
			};
		};
		const harness = a.harnessId ?? "claude-code";
		const store = harness === "codex" ? codex : claude;
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return makeHarnesses();
			case "subagent_attachable_skills":
				return attachable;
			case "subagent_skill_usage":
				return {};
			case "subagent_set_disabled":
				return { ok: true, disabled: false };
			case "subagent_list":
				return {
					harness,
					scope: "user",
					project: null,
					agents_dir: "/home/test/agents",
					settings_path: harness === "codex" ? "" : "/home/test/settings.json",
					agents: store.map((ag) => listItem(ag, harness)),
					builtins: [],
					links_warning: null,
				};
			case "subagent_show": {
				const ag = store.find((x) => x.name === a.name);
				if (!ag)
					return {
						name: a.name ?? "",
						scope: "user",
						harness,
						file: "",
						exists: false,
						safe: {
							name: a.name ?? "",
							description: "",
							model: "",
							tools_mode: "all",
							tools: [],
							disallowed_tools: [],
							allow_skill_discovery: true,
							skills: [],
							color: "",
						},
						advanced_yaml: "",
						advanced_format: harness === "codex" ? "toml" : "yaml",
						foreign_skill_entries: [],
						body: "",
						disabled: false,
						validation: { valid: true, warnings: [] },
						link: null,
						drift: null,
						links_warning: null,
					};
				const isCodex = harness === "codex";
				return {
					name: ag.name,
					scope: "user",
					harness,
					file: `${ag.name}.${isCodex ? "toml" : "md"}`,
					exists: true,
					safe: {
						name: ag.name,
						description: ag.description,
						model: ag.model,
						tools_mode: "all",
						tools: [],
						disallowed_tools: [],
						allow_skill_discovery: true,
						skills: ag.skills,
						color: "",
						...(isCodex
							? {
									sandbox_mode: ag.sandbox_mode ?? "",
									model_reasoning_effort: "",
									nickname_candidates: [],
								}
							: {}),
					},
					advanced_yaml: "",
					advanced_format: isCodex ? "toml" : "yaml",
					foreign_skill_entries: [],
					body: ag.body,
					disabled: false,
					validation: { valid: true, warnings: [] },
					link: linkInfo(ag, harness),
					drift: links.has(ag.name) ? drift(ag.name) : null,
					links_warning: null,
				};
			}
			case "subagent_save": {
				const p = a.payload;
				if (!p?.safe)
					return { ok: false, warnings: [], errors: [] };
				const saveH = p.harness ?? "claude-code";
				const saveStore = saveH === "codex" ? codex : claude;
				const linkName = p.original_name ?? p.safe.name;
				const isLinked = links.has(linkName);
				const preDrift = new Set(
					isLinked ? drift(linkName).map((d) => d.field) : [],
				);
				const self = saveStore.find((x) => x.name === linkName);
				const oldCore = self ? core(self) : null;
				if (self) {
					self.name = p.safe.name;
					self.description = p.safe.description;
					self.body = p.body ?? "";
					self.skills = [...p.safe.skills];
				}
				let cowrote_twin = false;
				let twin_harness: string | null = null;
				if (isLinked && oldCore && self) {
					const twinStore = otherStore(saveH);
					const twin = twinStore.find((x) => x.name === linkName);
					if (twin) {
						let changed = false;
						if (
							!preDrift.has("description") &&
							self.description !== oldCore.description
						) {
							twin.description = self.description;
							changed = true;
						}
						if (
							!preDrift.has("instructions") &&
							(self.body || "").replace(/\s+$/, "") !== oldCore.instructions
						) {
							twin.body = self.body;
							changed = true;
						}
						if (changed) {
							cowrote_twin = true;
							twin_harness = otherH(saveH);
						}
					}
				}
				return {
					ok: true,
					name: p.safe.name,
					file: `${p.safe.name}.md`,
					warnings: [],
					renamed_from: null,
					cowrote_twin,
					twin_harness,
				};
			}
			case "subagent_link": {
				const nm = a.name ?? "";
				links.add(nm);
				return {
					ok: true,
					name: nm,
					harnesses: ["claude-code", "codex"],
					drift: drift(nm),
				};
			}
			case "subagent_unlink": {
				const nm = a.name ?? "";
				const had = links.delete(nm);
				return { ok: true, name: nm, unlinked: had };
			}
			case "subagent_link_status": {
				const claudeNames = nameSet(claude);
				const codexNames = nameSet(codex);
				return {
					links: [...links].map((nm) => ({
						name: nm,
						harnesses: ["claude-code", "codex"],
						twin_lost: !(claudeNames.has(nm) && codexNames.has(nm)),
						drift: drift(nm),
					})),
					suggestions: [...claudeNames]
						.filter((n) => codexNames.has(n) && !links.has(n))
						.map((n) => ({ name: n, harnesses: ["claude-code", "codex"] })),
				};
			}
			case "subagent_resolve_drift": {
				const nm = a.name ?? "";
				const dec = a.decisions ?? {};
				const c = claude.find((x) => x.name === nm);
				const x = codex.find((y) => y.name === nm);
				if (!c || !x) return { ok: false, error: "twin missing" };
				for (const [field, winner] of Object.entries(dec)) {
					const win = winner === "codex" ? x : c;
					const lose = winner === "codex" ? c : x;
					if (field === "description") lose.description = win.description;
					else if (field === "instructions") lose.body = win.body;
					else if (field === "skills") lose.skills = [...win.skills];
				}
				return { ok: true, name: nm, drift: drift(nm) };
			}
			case "subagent_delete": {
				const nm = a.name ?? "";
				const both = a.linkAction === "both";
				const idx = store.findIndex((x) => x.name === nm);
				if (idx >= 0) store.splice(idx, 1);
				if (both) {
					const os = otherStore(harness);
					const oi = os.findIndex((x) => x.name === nm);
					if (oi >= 0) os.splice(oi, 1);
				}
				links.delete(nm);
				return { ok: true };
			}
			default:
				return undefined;
		}
	};
}

let dispatch: (cmd: string, args?: unknown) => unknown;

// Use the app-singleton queryClient so a mutation's `invalidateSubagents`
// (which targets that singleton, not a fresh test client) actually refetches
// the open list/show queries — exercising durability + banner-clear behavior.
beforeEach(() => {
	dispatch = makeBackend();
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) =>
		dispatch(cmd, args)) as never);
	queryClient.clear();
	primeRegistry(queryClient);
	useAppStore.setState({ harnesses: makeHarnesses(), toasts: [], mutating: false });
});

function renderList() {
	return renderWithProviders(
		<SubagentList
			harness="claude-code"
			scope="user"
			project={null}
			onScopeChange={vi.fn()}
			onOpen={vi.fn()}
		/>,
		{ client: queryClient },
	);
}

function renderEditor(name: string, extra?: ReactNode) {
	return renderWithProviders(
		<>
			<SubagentEditor
				harness="claude-code"
				scope="user"
				project={null}
				name={name}
				onBack={vi.fn()}
				onDeleted={vi.fn()}
			/>
			{extra}
		</>,
		{ client: queryClient },
	);
}

// ── List: link presence chips ────────────────────────────────────────────────

describe("SubagentList link presence", () => {
	it("shows an 'also in <other>' chip on a linked card", async () => {
		renderList();
		const card = (await screen.findByText("clean-twin")).closest(
			".subagent-card",
		) as HTMLElement;
		expect(within(card).getByText(/also in/i)).toBeInTheDocument();
		// The other harness (Codex) is named on the chip.
		expect(within(card).getAllByText(/Codex/i).length).toBeGreaterThan(0);
	});

	it("offers a 'Link?' action on a same-name suggestion", async () => {
		renderList();
		const card = (await screen.findByText("sug-twin")).closest(
			".subagent-card",
		) as HTMLElement;
		expect(
			within(card).getByRole("button", { name: /Link\?/i }),
		).toBeInTheDocument();
		// A solo agent (no twin) shows no link row.
		const solo = (await screen.findByText("solo-agent")).closest(
			".subagent-card",
		) as HTMLElement;
		expect(solo.querySelector(".subagent-link-row")).toBeNull();
	});

	it("suggestion → Link calls subagent_link and re-lists as linked", async () => {
		renderList();
		const card = (await screen.findByText("sug-twin")).closest(
			".subagent-card",
		) as HTMLElement;
		await userEvent.click(
			within(card).getByRole("button", { name: /Link\?/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"subagent_link",
				expect.objectContaining({ name: "sug-twin" }),
			),
		);
		// Durable: after the invalidation refetch, the card is now linked.
		const relisted = (await screen.findByText("sug-twin")).closest(
			".subagent-card",
		) as HTMLElement;
		await waitFor(() =>
			expect(within(relisted).getByText(/also in/i)).toBeInTheDocument(),
		);
	});
});

// ── Editor: drift banner + field lock + resolve ──────────────────────────────

describe("SubagentEditor drift banner", () => {
	it("renders both sides' values and locks the drifted field", async () => {
		const { container } = renderEditor("drift-twin");
		// Banner header + both description values are shown inside the banner.
		expect(
			await screen.findByText(/Linked files have drifted/i),
		).toBeInTheDocument();
		const banner = container.querySelector(
			".subagent-drift-banner",
		) as HTMLElement;
		expect(within(banner).getByText(CLAUDE_DRIFT_DESC)).toBeInTheDocument();
		expect(within(banner).getByText(CODEX_DRIFT_DESC)).toBeInTheDocument();
		// The description field is frozen (read-only) with a lock hint.
		const descField = screen.getByDisplayValue(CLAUDE_DRIFT_DESC);
		expect(descField).toHaveAttribute("readonly");
		expect(screen.getByText(/resolve above to edit/i)).toBeInTheDocument();
	});

	it("Apply sends the chosen winner to subagent_resolve_drift", async () => {
		const { container } = renderEditor("drift-twin");
		await screen.findByText(/Linked files have drifted/i);
		const banner = container.querySelector(
			".subagent-drift-banner",
		) as HTMLElement;
		// Choose the Codex value for `description`.
		const codexChoice = within(banner)
			.getByText(CODEX_DRIFT_DESC)
			.closest(".subagent-drift-choice") as HTMLElement;
		await userEvent.click(within(codexChoice).getByRole("radio"));
		await userEvent.click(
			screen.getByRole("button", { name: /Apply resolution/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_resolve_drift", {
				name: "drift-twin",
				decisions: { description: "codex" },
			}),
		);
		// After resolving, the banner clears on refetch.
		await waitFor(() =>
			expect(screen.queryByText(/Linked files have drifted/i)).toBeNull(),
		);
	});
});

// ── Editor: link actions (unlink / copy-to / delete one-or-both) ─────────────

describe("SubagentEditor link actions", () => {
	it("unlink is durable — the panel flips to a link suggestion", async () => {
		renderEditor("clean-twin");
		await userEvent.click(await screen.findByRole("button", { name: /^Unlink$/i }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_unlink", {
				name: "clean-twin",
			}),
		);
		// Durable: refetch shows the pair as a suggestion (not re-linked).
		expect(
			await screen.findByRole("button", { name: /Link with Codex/i }),
		).toBeInTheDocument();
	});

	it("copy-to a solo agent calls subagent_link with copyFrom", async () => {
		renderEditor("solo-agent");
		await userEvent.click(
			await screen.findByRole("button", { name: /Copy to Codex/i }),
		);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_link", {
				name: "solo-agent",
				copyFrom: "claude-code",
			}),
		);
	});

	it("delete offers one-or-both and passes the chosen link action", async () => {
		renderEditor("clean-twin");
		await userEvent.click(
			await screen.findByRole("button", { name: /Delete this agent/i }),
		);
		// Both radio options are present for a linked agent.
		expect(
			screen.getByRole("radio", { name: /only this harness/i }),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("radio", { name: /both linked files/i }),
		);
		await userEvent.click(screen.getByRole("button", { name: /Confirm delete/i }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"subagent_delete",
				expect.objectContaining({ name: "clean-twin", linkAction: "both" }),
			),
		);
	});
});

// ── Editor: co-write toast ───────────────────────────────────────────────────

describe("SubagentEditor co-write", () => {
	it("surfaces 'also updated <twin>' after a linked save co-writes", async () => {
		renderEditor("clean-twin", <ToastContainer />);
		const desc = await screen.findByDisplayValue("A cleanly-linked twin.");
		await userEvent.clear(desc);
		await userEvent.type(desc, "Edited shared description.");
		// Save via ⌘S (the primary button's accessible name carries its kbd hint).
		await userEvent.keyboard("{Control>}s{/Control}");
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"subagent_save",
				expect.anything(),
			),
		);
		expect(await screen.findByText(/Also updated Codex/i)).toBeInTheDocument();
	});
});
