import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { SubagentEditor } from "@/screens/SubagentEditor";
import { SkillPreloadedBy } from "@/components/subagents/SkillPreloadedBy";
import { useAppStore, type HarnessStatus } from "@/store";
import {
	renderWithProviders,
	makeQueryClient,
	primeRegistry,
	sampleRegistry,
} from "./helpers";

// ─── Wave 5: attach-skill provisioning (D5) UI ────────────────────────────────
// The two-phase protocol from the UI's side: a save blocked purely by an
// unresolved, newly-attached registry skill raises a consequence prompt; on
// confirm we provision (--global / --project per scope_fix), then re-save the
// same payload; refusals surface verbatim (affinity → distinct widen confirm;
// remote quarantine → dead stop).

function agentHarnesses(): HarnessStatus[] {
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
	];
}

/** A minimal user-scope Claude agent with no skills yet. */
const claudeShow = {
	name: "probe",
	scope: "user",
	harness: "claude-code",
	file: "probe.md",
	exists: true,
	safe: {
		name: "probe",
		description: "A probe.",
		model: "",
		tools_mode: "all",
		tools: [],
		disallowed_tools: [],
		allow_skill_discovery: true,
		skills: [],
		color: "",
	},
	advanced_yaml: "",
	advanced_format: "yaml",
	foreign_skill_entries: [],
	body: "Do the thing.",
	disabled: false,
	validation: { valid: true, warnings: [] },
	link: null,
	drift: null,
};

/** `needs-global` is registry-known + invocable but unresolved in scope. */
const attachableWithUnresolved = [
	{
		name: "brainstorm",
		description: "Brainstorm.",
		resolved: true,
		invocable: true,
		project_only: false,
		attachable: true,
		reason: "",
	},
	{
		name: "needs-global",
		description: "Not yet global.",
		resolved: false,
		invocable: true,
		project_only: false,
		attachable: false,
		reason: "not synced/resolvable in this scope",
	},
];

interface ProvOpts {
	/** Result the FIRST provision call returns (default: ok). */
	firstProvision?: unknown;
	/** Result a widen (widenAffinity:true) provision returns (default: ok). */
	widenProvision?: unknown;
}

/** Editor mock: first save with `needs-global` blocks with needs_provisioning;
 *  after a SUCCESSFUL provision the re-save validates clean. */
function mockEditor(opts: ProvOpts = {}) {
	let provisioned = false;
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		const a = (args ?? {}) as Record<string, unknown>;
		switch (cmd) {
			case "read_registry":
				return sampleRegistry;
			case "harness_list":
				return agentHarnesses();
			case "subagent_show":
				return claudeShow;
			case "subagent_attachable_skills":
				return attachableWithUnresolved;
			case "subagent_skill_usage":
				return {};
			case "subagent_set_disabled":
				return { ok: true, disabled: false };
			case "subagent_provision_skill": {
				const widen = !!a.widenAffinity;
				const res = widen
					? opts.widenProvision ?? {
							ok: true,
							skill: a.skill,
							mode: "make-global",
							path: "/x",
							widened_affinity: true,
						}
					: opts.firstProvision ?? {
							ok: true,
							skill: a.skill,
							mode: "make-global",
							path: "/x",
							widened_affinity: false,
						};
				if ((res as { ok?: boolean }).ok) provisioned = true;
				return res;
			}
			case "subagent_save": {
				const payload = a.payload as {
					safe: { name: string; skills: string[] };
				};
				const skills = payload.safe.skills ?? [];
				if (!provisioned && skills.includes("needs-global")) {
					return {
						ok: false,
						warnings: [],
						errors: [
							{
								field: "skills",
								level: "error",
								message: "needs-global does not resolve in this scope yet.",
								value: "needs-global",
								needs_provisioning: {
									skill: "needs-global",
									scope_fix: "make-global",
									consequence:
										"Makes 'needs-global' global — installed into every harness's user-level skill directory.",
								},
							},
						],
					};
				}
				return {
					ok: true,
					name: payload.safe.name,
					file: "probe.md",
					warnings: [],
					renamed_from: null,
				};
			}
			default:
				return undefined;
		}
	}) as never);
}

async function openEditorAndAttach() {
	const client = makeQueryClient();
	primeRegistry(client);
	renderWithProviders(
		<SubagentEditor
			scope="user"
			project={null}
			name="probe"
			onBack={vi.fn()}
		/>,
		{ client },
	);
	// Check the unresolved skill → makes the form dirty and the payload carry it.
	const row = (await screen.findByText("needs-global")).closest(
		".subagent-skill-row",
	) as HTMLElement;
	await userEvent.click(within(row).getByRole("checkbox"));
	await userEvent.click(screen.getByRole("button", { name: /^Save/i }));
}

beforeEach(() => {
	useAppStore.setState({ harnesses: agentHarnesses(), mutating: false });
});

describe("Attach-skill provisioning — agent editor", () => {
	it("blocks the save, shows the consequence, provisions, then re-saves", async () => {
		mockEditor();
		await openEditorAndAttach();

		// The consequence prompt appears (not a silent write).
		const panel = await screen.findByRole("alertdialog", {
			name: /make skills available/i,
		});
		expect(
			within(panel).getByText(/Makes 'needs-global' global/i),
		).toBeInTheDocument();

		await userEvent.click(
			within(panel).getByRole("button", { name: /Make available & save/i }),
		);

		// Provision was called with the agent's harness + make-global scope.
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_provision_skill", {
				skill: "needs-global",
				global: true,
				project: null,
				harnessId: "claude-code",
				widenAffinity: false,
			}),
		);
		// The prompt closes after the successful re-save.
		await waitFor(() =>
			expect(
				screen.queryByRole("alertdialog", { name: /make skills available/i }),
			).toBeNull(),
		);
	});

	it("cancel keeps the save blocked and leaves the field error inline", async () => {
		mockEditor();
		await openEditorAndAttach();
		const panel = await screen.findByRole("alertdialog", {
			name: /make skills available/i,
		});
		await userEvent.click(within(panel).getByRole("button", { name: /Cancel/i }));

		// Panel gone; no provision ran; the blocking field error still shows.
		await waitFor(() =>
			expect(
				screen.queryByRole("alertdialog", { name: /make skills available/i }),
			).toBeNull(),
		);
		expect(invoke).not.toHaveBeenCalledWith(
			"subagent_provision_skill",
			expect.anything(),
		);
		expect(
			screen.getByText(/needs-global does not resolve/i),
		).toBeInTheDocument();
	});

	it("remote-quarantine refusal is a dead stop (no retry, no re-save)", async () => {
		mockEditor({
			firstProvision: {
				ok: false,
				error:
					"skill 'needs-global' is quarantined (imported from remote 'box'). No override.",
			},
		});
		await openEditorAndAttach();
		const panel = await screen.findByRole("alertdialog", {
			name: /make skills available/i,
		});
		await userEvent.click(
			within(panel).getByRole("button", { name: /Make available & save/i }),
		);
		// The refusal surfaces verbatim, with only a Close (no re-save happened).
		await waitFor(() =>
			expect(screen.getByText(/quarantined/i)).toBeInTheDocument(),
		);
		expect(
			within(panel).getByRole("button", { name: /^Close$/i }),
		).toBeInTheDocument();
		expect(
			within(panel).queryByRole("button", { name: /Make available & save/i }),
		).toBeNull();
		// Only the initial save fired — no second (re-)save.
		const saves = vi
			.mocked(invoke)
			.mock.calls.filter((c) => c[0] === "subagent_save");
		expect(saves.length).toBe(1);
	});

	it("affinity refusal offers a distinct widen confirm, then succeeds", async () => {
		mockEditor({
			firstProvision: {
				ok: false,
				error: "restricted to harnesses ['codex'], which excludes 'claude-code'",
				affinity: ["codex"],
				widen_available: true,
			},
			// widenAffinity:true → success.
		});
		await openEditorAndAttach();
		const panel = await screen.findByRole("alertdialog", {
			name: /make skills available/i,
		});
		await userEvent.click(
			within(panel).getByRole("button", { name: /Make available & save/i }),
		);
		// The distinct widen confirm appears.
		const widenBtn = await within(panel).findByRole("button", {
			name: /Widen affinity/i,
		});
		expect(
			within(panel).getByText(/restricted to/i),
		).toBeInTheDocument();
		await userEvent.click(widenBtn);
		// The second provision carried widenAffinity:true.
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_provision_skill", {
				skill: "needs-global",
				global: true,
				project: null,
				harnessId: "claude-code",
				widenAffinity: true,
			}),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("alertdialog", { name: /make skills available/i }),
			).toBeNull(),
		);
	});
});

// ─── Skill-side attach (cross-harness) → provision with the right harness ──────

describe("Attach-skill provisioning — skill screen (cross-harness)", () => {
	const codexUserAgent = {
		name: "pr_explorer",
		file: "pr_explorer.toml",
		relpath: "pr_explorer.toml",
		description: "Codex explorer.",
		model: "",
		tools_mode: "all",
		tools: [],
		disallowed_tools: [],
		skills: [],
		color: "",
		disabled: false,
		builtin: false,
		valid: true,
		warnings: [],
		sandbox_mode: "",
		model_reasoning_effort: "",
		nickname_candidates: [],
	};

	const codexShow = {
		name: "pr_explorer",
		scope: "user",
		harness: "codex",
		file: "pr_explorer.toml",
		exists: true,
		safe: {
			name: "pr_explorer",
			description: "Codex explorer.",
			model: "",
			tools_mode: "all",
			tools: [],
			disallowed_tools: [],
			allow_skill_discovery: true,
			skills: [],
			color: "",
			sandbox_mode: "",
			model_reasoning_effort: "",
			nickname_candidates: [],
		},
		advanced_yaml: "",
		advanced_format: "toml",
		foreign_skill_entries: [],
		body: "Explore.",
		disabled: false,
		validation: { valid: true, warnings: [] },
		link: null,
		drift: null,
	};

	function mockSkillScreen() {
		let provisioned = false;
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
			const a = (args ?? {}) as Record<string, unknown>;
			const harness = (a.harnessId as string) ?? "claude-code";
			switch (cmd) {
				case "read_registry":
					return sampleRegistry;
				case "harness_list":
					return agentHarnesses();
				case "subagent_skill_usage":
					return {};
				case "subagent_list":
					// Only the codex user store has an agent for this journey.
					return harness === "codex" && a.scope === "user"
						? {
								harness: "codex",
								scope: "user",
								project: null,
								agents_dir: "/x",
								settings_path: "",
								agents: [codexUserAgent],
								builtins: [],
							}
						: {
								harness,
								scope: a.scope,
								project: a.project ?? null,
								agents_dir: "/x",
								settings_path: "/x",
								agents: [],
								builtins: [],
							};
				case "subagent_attachable_skills":
					// brainstorm is registry-known but NOT resolved for codex → the
					// user-scope target is provisionable (make-global).
					return [
						{
							name: "brainstorm",
							description: "Brainstorm.",
							resolved: false,
							invocable: true,
							project_only: false,
							attachable: false,
							reason: "not synced/resolvable in this scope",
						},
					];
				case "subagent_show":
					return codexShow;
				case "subagent_provision_skill":
					provisioned = true;
					return {
						ok: true,
						skill: a.skill,
						mode: "make-global",
						path: "/x",
						widened_affinity: false,
					};
				case "subagent_save": {
					const payload = a.payload as {
						harness?: string;
						safe: { name: string; skills: string[] };
					};
					if (
						!provisioned &&
						(payload.safe.skills ?? []).includes("brainstorm")
					) {
						return {
							ok: false,
							warnings: [],
							errors: [
								{
									field: "skills",
									level: "error",
									message: "brainstorm does not resolve for codex yet.",
									value: "brainstorm",
									needs_provisioning: {
										skill: "brainstorm",
										scope_fix: "make-global",
										consequence:
											"Makes 'brainstorm' global across every harness.",
									},
								},
							],
						};
					}
					return {
						ok: true,
						name: payload.safe.name,
						file: "pr_explorer.toml",
						warnings: [],
						renamed_from: null,
					};
				}
				default:
					return undefined;
			}
		}) as never);
	}

	it("attaches from the skill screen and provisions with the codex harness", async () => {
		mockSkillScreen();
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<SkillPreloadedBy skillName="brainstorm" />, { client });

		await userEvent.click(
			await screen.findByRole("button", { name: /Attach to sub-agent/i }),
		);
		// The codex user agent is offered (provisionable, "will provision").
		const opt = await screen.findByRole("button", { name: /pr_explorer/i });
		expect(within(opt).getByText(/will provision/i)).toBeInTheDocument();
		await userEvent.click(opt);

		// Consequence prompt → confirm.
		const panel = await screen.findByRole("alertdialog", {
			name: /make skills available/i,
		});
		await userEvent.click(
			within(panel).getByRole("button", { name: /Make available & save/i }),
		);

		// Provisioned for the codex harness (not the claude default).
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("subagent_provision_skill", {
				skill: "brainstorm",
				global: true,
				project: null,
				harnessId: "codex",
				widenAffinity: false,
			}),
		);
		// The re-save carried the codex harness in its payload.
		await waitFor(() => {
			const saves = vi
				.mocked(invoke)
				.mock.calls.filter((c) => c[0] === "subagent_save");
			const last = saves[saves.length - 1]?.[1] as {
				payload?: { harness?: string; safe?: { skills?: string[] } };
			};
			expect(last?.payload?.harness).toBe("codex");
			expect(last?.payload?.safe?.skills).toContain("brainstorm");
		});
	});
});
