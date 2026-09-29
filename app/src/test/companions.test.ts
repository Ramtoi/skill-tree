import { describe, it, expect } from "vitest";
import {
	parseNeedsCompanions,
	companionsIndex,
	groupByHarness,
	harnessSummary,
	verdictLabel,
	activationWords,
	removalSentence,
	NEVER_FOLD,
	glyphStateFor,
	statusLine,
	groupRows,
	draftFromDeclared,
	blockFromDraft,
	reconcileSentence,
	removalConsequences,
	defaultHookScriptPath,
	validateNewHook,
	type CompanionItem,
	type CompanionsPayload,
	type CompanionState,
	type NeedsCompanions,
	type NewHookDraft,
	type NewHookTaken,
	type ReconcileResult,
	type ShipsWith,
} from "@/lib/companions";
import type { Registry } from "@/types";

function baseRegistry(overrides: Partial<Registry> = {}): Registry {
	return {
		version: "1",
		skills: {},
		projects: {},
		bundles: {},
		...overrides,
	};
}

// ─── parseNeedsCompanions ───────────────────────────────────────────────────

describe("parseNeedsCompanions", () => {
	const payload: NeedsCompanions = {
		skill: "orchestrate-advanced",
		project: "moon-base",
		items: [
			{
				kind: "hook",
				name: "orch-scope-guard",
				harness: "claude-code",
				target: "<repo>/.claude/settings.local.json",
				verdict: "will_write",
				activation: "while-running",
			},
		],
	};

	it("parses a payload-first line with trailing sync chatter", () => {
		const output = `${JSON.stringify({ needs_provisioning: payload })}\nSyncing {moon-base} → /repo\nsync complete {ok}`;
		expect(parseNeedsCompanions(output)).toEqual(payload);
	});

	it("parses a pretty-printed payload", () => {
		const output = JSON.stringify({ needs_provisioning: payload }, null, 2);
		expect(parseNeedsCompanions(output)).toEqual(payload);
	});

	it("returns null on a plain failure with no payload", () => {
		expect(parseNeedsCompanions("error: unknown skill 'nope'\n")).toBeNull();
	});

	it("returns null when the parsed object carries no needs_provisioning field", () => {
		expect(parseNeedsCompanions(JSON.stringify({ ok: true }))).toBeNull();
	});
});

// ─── companionsIndex: shippedBy vs via (A11) ────────────────────────────────

describe("companionsIndex", () => {
	function registryWithMirrorAndLedger(): Registry {
		return baseRegistry({
			skills: {
				"orchestrate-advanced": {
					version: "0.1.0",
					description: "d",
					source: "s",
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
							ask: ["Bash(gh pr merge:*)"],
						},
					},
				},
			},
			projects: {
				"moon-base": {
					path: "/repo/moon-base",
					bundles: [],
					enabled: ["orchestrate-advanced"],
					companions: {
						"orchestrate-advanced": {
							hooks: ["orch-scope-guard"],
							agents: ["orch-implementer"],
							permissions: [{ pattern: "Bash(git push --force:*)", kind: "deny" }],
							provisioned_at: "2026-09-05T00:00:00Z",
						},
					},
				},
				// A project where the skill is registered (mirror is global) but
				// never provisioned — its ledger has no entry at all.
				"other-project": {
					path: "/repo/other",
					bundles: [],
					enabled: [],
				},
			},
		});
	}

	it("shippedBy finds the declaring skill for an agent and a hook", () => {
		const idx = companionsIndex(registryWithMirrorAndLedger());
		expect(idx.shippedBy("agent", "orch-implementer")).toEqual({
			skill: "orchestrate-advanced",
		});
		expect(idx.shippedBy("hook", "orch-scope-guard")).toEqual({
			skill: "orchestrate-advanced",
		});
	});

	it("shippedBy misses a name no skill declares", () => {
		const idx = companionsIndex(registryWithMirrorAndLedger());
		expect(idx.shippedBy("hook", "no-such-hook")).toBeNull();
	});

	it("via finds the provisioning skill on the project that has a ledger entry", () => {
		const idx = companionsIndex(registryWithMirrorAndLedger());
		expect(idx.via("moon-base", "hook", "orch-scope-guard")).toEqual({
			skill: "orchestrate-advanced",
		});
		expect(idx.via("moon-base", "agent", "orch-implementer")).toEqual({
			skill: "orchestrate-advanced",
		});
	});

	it("a hook in the mirror but absent from the project's ledger gets shippedBy, never via", () => {
		const idx = companionsIndex(registryWithMirrorAndLedger());
		// `other-project` never provisioned anything — the mirror still knows
		// about the hook (it's global to the skill), but this project's ledger
		// carries no entry at all.
		expect(idx.shippedBy("hook", "orch-scope-guard")).toEqual({
			skill: "orchestrate-advanced",
		});
		expect(idx.via("other-project", "hook", "orch-scope-guard")).toBeNull();
	});

	it("via on (pattern, kind) matches the exact pair; a different kind on the same pattern misses", () => {
		const idx = companionsIndex(registryWithMirrorAndLedger());
		expect(
			idx.via("moon-base", "permission", { pattern: "Bash(git push --force:*)", kind: "deny" }),
		).toEqual({ skill: "orchestrate-advanced" });
		expect(
			idx.via("moon-base", "permission", { pattern: "Bash(git push --force:*)", kind: "ask" }),
		).toBeNull();
	});

	it("returns null for every lookup against an undefined registry", () => {
		const idx = companionsIndex(undefined);
		expect(idx.shippedBy("hook", "anything")).toBeNull();
		expect(idx.via("moon-base", "agent", "anything")).toBeNull();
	});
});

// ─── groupByHarness / harnessSummary / activationWords (W7, A1) ─────────────

describe("groupByHarness", () => {
	const items: CompanionItem[] = [
		{
			kind: "agent",
			name: "orch-implementer",
			harness: "claude-code",
			target: "~/.claude/agents/orch-implementer.md",
			verdict: "will_write",
			scope: "user",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "claude-code",
			target: "<repo>/.claude/settings.local.json",
			verdict: "will_write",
			activation: "while-running",
		},
		{
			kind: "permission",
			name: "Bash(git push --force:*)",
			harness: "claude-code",
			target: "<repo>/.claude/settings.json",
			verdict: "will_write",
			rule_kind: "deny",
		},
		{
			kind: "hook",
			name: "orch-scope-guard",
			harness: "codex",
			target: "<repo>",
			verdict: "unsupported",
			reason: "Codex skips project-attached hooks",
			activation: "while-running",
		},
		{
			kind: "trust",
			name: "trust_level",
			harness: "codex",
			target: "~/.codex/config.toml",
			verdict: "will_write",
			reason: "Codex runs a project's committed config.toml and hooks once trusted",
		},
	];

	it("splits each harness into write/folded/pinned, with the trust row pinned (never written or folded)", () => {
		const groups = groupByHarness(items, ["claude-code", "codex"]);
		expect(groups.map((g) => g.harness)).toEqual(["claude-code", "codex"]);

		const claude = groups[0];
		expect(claude.write).toHaveLength(3);
		expect(claude.folded).toHaveLength(0);
		expect(claude.pinned).toHaveLength(0);

		const codex = groups[1];
		expect(codex.pinned).toHaveLength(1);
		expect(codex.pinned[0].kind).toBe("trust");
		expect(codex.write).toHaveLength(0);
		expect(codex.folded).toHaveLength(1);
		expect(codex.folded[0].kind).toBe("hook");
	});

	it("appends a harness present in items but absent from the order list", () => {
		const groups = groupByHarness(items, ["codex"]);
		expect(groups.map((g) => g.harness)).toEqual(["codex", "claude-code"]);
	});

	it("NEVER_FOLD names exactly the trust kind (risk 3)", () => {
		expect(NEVER_FOLD).toEqual(["trust"]);
	});
});

describe("harnessSummary", () => {
	it("reads 'will write N agents, N hooks, N rules' in that order", () => {
		const groups = groupByHarness(
			[
				{
					kind: "agent",
					name: "a1",
					harness: "claude-code",
					target: "~/.claude/agents/a1.md",
					verdict: "will_write",
				},
				{
					kind: "hook",
					name: "h1",
					harness: "claude-code",
					target: "<repo>",
					verdict: "will_write",
				},
				{
					kind: "permission",
					name: "Bash(x:*)",
					harness: "claude-code",
					target: "<repo>",
					verdict: "will_write",
					rule_kind: "deny",
				},
			],
			["claude-code"],
		);
		expect(harnessSummary(groups[0])).toBe("will write 1 agent, 1 hook, 1 rule");
	});

	it("reads 'nothing to write' when the harness has no will_write items", () => {
		const groups = groupByHarness(
			[
				{
					kind: "hook",
					name: "h1",
					harness: "codex",
					target: "<repo>",
					verdict: "unsupported",
					reason: "x",
				},
			],
			["codex"],
		);
		expect(harnessSummary(groups[0])).toBe("nothing to write");
	});
});

describe("verdictLabel", () => {
	it("has a neutral word for every verdict", () => {
		expect(verdictLabel("will_write")).toBe("will write");
		expect(verdictLabel("already_present")).toBe("already there");
		expect(verdictLabel("unsupported")).toBe("not supported");
		expect(verdictLabel("feature_off")).toBe("feature off");
		expect(verdictLabel("not_installed")).toBe("not installed");
	});
});

describe("activationWords", () => {
	it("reads 'while <skill> runs' for while-running — never the dropped 'project' word (A1)", () => {
		expect(activationWords("while-running", "orchestrate-advanced")).toBe(
			"while orchestrate-advanced runs",
		);
	});

	it("reads 'always on' for always and for an absent activation", () => {
		expect(activationWords("always", "orchestrate-advanced")).toBe("always on");
		expect(activationWords(undefined, "orchestrate-advanced")).toBe("always on");
	});
});

describe("removalSentence", () => {
	it("reads 'Removed N hooks, N agents, N rules', omitting zero counts", () => {
		expect(
			removalSentence({
				removed_companions: {
					hooks: ["orch-scope-guard", "orch-report-guard", "orch-unit-brief"],
					agents: [
						"orch-sub-orchestrator",
						"orch-researcher",
						"orch-planner",
						"orch-griller",
						"orch-implementer",
					],
					permissions: [
						{ pattern: "Bash(git push --force:*)", kind: "deny" },
						{ pattern: "Bash(gh pr merge:*)", kind: "ask" },
					],
				},
			}),
		).toBe("Removed 3 hooks, 5 agents, 2 rules");
	});

	it("reads 'Nothing removed' when every list is empty (a --skill-only disable)", () => {
		expect(
			removalSentence({ removed_companions: { hooks: [], agents: [], permissions: [] } }),
		).toBe("Nothing removed");
	});

	it("uses singular nouns at count 1", () => {
		expect(
			removalSentence({
				removed_companions: {
					hooks: ["orch-scope-guard"],
					agents: [],
					permissions: [{ pattern: "Bash(x:*)", kind: "deny" }],
				},
			}),
		).toBe("Removed 1 hook, 1 rule");
	});
});

// ─── glyphStateFor (D7/wave 2) ──────────────────────────────────────────────

describe("glyphStateFor", () => {
	it("maps every CompanionState to exactly one glyph register", () => {
		const expected: Record<CompanionState, ReturnType<typeof glyphStateFor>> = {
			provisioned: "lit",
			present: "lit",
			drift: "lit",
			outdated: "lit",
			pending: "dim",
			absent: "dim",
			unsupported: "unsupported",
			missing: "none",
			stale: "none",
		};
		for (const [state, glyph] of Object.entries(expected)) {
			expect(glyphStateFor(state as CompanionState)).toBe(glyph);
		}
	});
});

// ─── statusLine (D7/wave 2) ─────────────────────────────────────────────────

describe("statusLine", () => {
	function payload(overrides: Partial<CompanionsPayload> = {}): CompanionsPayload {
		return {
			skill: "orchestrate-advanced",
			project: null,
			declared: {},
			items: [],
			summary: { provisioned: 0, pending: 0, drift: 0, missing: 0 },
			project_context: false,
			...overrides,
		};
	}

	it("is null when there is nothing to say (no project context, nothing pending/drifted)", () => {
		expect(statusLine(payload())).toBeNull();
	});

	it("reads 'Provisioned on <project>' with project context and nothing pending/drifted", () => {
		expect(
			statusLine(payload({ project: "notes-vault", project_context: true })),
		).toEqual({ text: "Provisioned on notes-vault", tone: "ok", showProvision: false });
	});

	it("reads 'Provisioned globally' for a global-scope skill (A17 — project null, project_context true)", () => {
		expect(statusLine(payload({ project: null, project_context: true }))).toEqual({
			text: "Provisioned globally",
			tone: "ok",
			showProvision: false,
		});
	});

	it("reads 'N pending on <project>' and rungs Provision when pending outranks drift", () => {
		expect(
			statusLine(
				payload({
					project: "notes-vault",
					project_context: true,
					summary: { provisioned: 4, pending: 2, drift: 1, missing: 0 },
				}),
			),
		).toEqual({ text: "2 pending on notes-vault", tone: "pending", showProvision: true });
	});

	it("reads 'N drifted' with no Provision rung when nothing is pending", () => {
		expect(
			statusLine(
				payload({
					project: "notes-vault",
					project_context: true,
					summary: { provisioned: 5, pending: 0, drift: 1, missing: 0 },
				}),
			),
		).toEqual({ text: "1 drifted", tone: "drift", showProvision: false });
	});

	it("tolerates an absent summary/project_context (pre-wave-2 fixture) as all-zero/false", () => {
		expect(
			statusLine({
				skill: "orchestrate-advanced",
				project: "notes-vault",
				declared: {},
				items: [],
			}),
		).toBeNull();
	});

	// ─── D17/F1 — the project-less read's own ledger claim ───────────────────

	function absentItem(overrides: Partial<CompanionItem> = {}): CompanionItem {
		return {
			kind: "hook",
			name: "orch-scope-guard",
			harness: "claude-code",
			target: null,
			verdict: "will_write",
			state: "absent",
			...overrides,
		};
	}

	it("F1/D17: all-absent, project-less, provisioned_on empty → the 'equip it' idle line with an Equip… action", () => {
		expect(
			statusLine(
				payload({ items: [absentItem()], summary: { provisioned: 0, pending: 0, drift: 0, missing: 0 } }),
			),
		).toEqual({
			text: "Not provisioned anywhere — equip orchestrate-advanced on a project to install these",
			tone: "idle",
			showProvision: false,
			action: { label: "Equip…", target: "usedby" },
		});
	});

	it("D17: the post-equip shape from the evidence log — 'Provisioned on scratch', tone ok, no action", () => {
		expect(
			statusLine(
				payload({
					provisioned_on: ["scratch"],
					summary: { provisioned: 2, pending: 0, drift: 0, missing: 0 },
					items: [
						{ ...absentItem({ kind: "agent", name: "orch-implementer" }), state: "present" },
						{ ...absentItem({ kind: "agent", name: "orch-reviewer" }), state: "present" },
						absentItem({ kind: "hook", name: "orch-scope-guard" }),
						absentItem({ kind: "permission", name: "Bash(git push --force:*)", rule_kind: "deny" }),
					],
				}),
			),
		).toEqual({ text: "Provisioned on scratch", tone: "ok", showProvision: false });
	});

	it("D17: 2-3 provisioned_on scopes join with ', '", () => {
		expect(
			statusLine(payload({ provisioned_on: ["a", "b"], items: [absentItem()] })),
		).toEqual({ text: "Provisioned on a, b", tone: "ok", showProvision: false });
	});

	it("D17: 4+ provisioned_on scopes collapse to a count", () => {
		expect(
			statusLine(payload({ provisioned_on: ["a", "b", "c", "d"], items: [absentItem()] })),
		).toEqual({ text: "Provisioned on 4 scopes", tone: "ok", showProvision: false });
	});

	it("S1: the literal 'global' scope token reads as 'the global scope', not a project name", () => {
		expect(
			statusLine(payload({ provisioned_on: ["global"], items: [absentItem()] })),
		).toEqual({ text: "Provisioned on the global scope", tone: "ok", showProvision: false });
	});

	// ─── F3 — a missing {ref} must not silence the section ────────────────────

	it("F3: one missing item plus all-absent others → the 'can't be resolved' line, not null", () => {
		expect(
			statusLine(
				payload({
					summary: { provisioned: 0, pending: 0, drift: 0, missing: 1 },
					items: [absentItem(), absentItem({ name: "orch-unit-brief", state: "missing" })],
				}),
			),
		).toEqual({
			text: "1 reference can't be resolved",
			tone: "idle",
			showProvision: false,
		});
	});

	it("F3: pluralizes 'references' for more than one", () => {
		expect(
			statusLine(
				payload({
					summary: { provisioned: 0, pending: 0, drift: 0, missing: 2 },
					items: [
						absentItem({ name: "a", state: "missing" }),
						absentItem({ name: "b", state: "missing" }),
					],
				}),
			),
		).toEqual({
			text: "2 references can't be resolved",
			tone: "idle",
			showProvision: false,
		});
	});

	// ─── F1 residual hedge — presence with no ledger entry anywhere ───────────

	it("F1: mixed lit + absent, provisioned_on empty → the residual project-less hedge, not null and not the equip line", () => {
		expect(
			statusLine(
				payload({
					items: [
						{ ...absentItem({ kind: "agent", name: "orch-implementer" }), state: "present" },
						absentItem({ kind: "hook", name: "orch-scope-guard" }),
					],
				}),
			),
		).toEqual({
			text: "A project-less read can't see project-scoped hooks and rules — open this skill from a project for its real state",
			tone: "idle",
			showProvision: false,
		});
	});

	// ─── Precedence + edge cases ────────────────────────────────────────────────

	it("all-unsupported → null (excluded from `considered`, so nothing is left to say)", () => {
		expect(
			statusLine(payload({ items: [absentItem({ state: "unsupported", reason: "n/a" })] })),
		).toBeNull();
	});

	it("items: [] → null", () => {
		expect(statusLine(payload({ items: [] }))).toBeNull();
	});

	it("pending still outranks provisioned_on/missing/absent (unchanged precedence)", () => {
		expect(
			statusLine(
				payload({
					provisioned_on: ["scratch"],
					summary: { provisioned: 0, pending: 1, drift: 0, missing: 1 },
					items: [absentItem({ state: "pending" })],
				}),
			),
		).toEqual({ text: "1 pending", tone: "pending", showProvision: true });
	});

	it("drift still outranks provisioned_on/missing/absent (unchanged precedence)", () => {
		expect(
			statusLine(
				payload({
					provisioned_on: ["scratch"],
					summary: { provisioned: 0, pending: 0, drift: 1, missing: 1 },
					items: [absentItem({ state: "drift" })],
				}),
			),
		).toEqual({ text: "1 drifted", tone: "drift", showProvision: false });
	});

	it("project_context still outranks provisioned_on (unchanged precedence)", () => {
		expect(
			statusLine(
				payload({
					project: "notes-vault",
					project_context: true,
					provisioned_on: ["scratch"],
				}),
			),
		).toEqual({ text: "Provisioned on notes-vault", tone: "ok", showProvision: false });
	});
});

// ─── groupRows (D7, A18/C5 — an inline and a ref hook) ──────────────────────

describe("groupRows", () => {
	const sw: ShipsWith = {
		agents: ["orch-implementer"],
		hooks: [
			{
				name: "orch-scope-guard",
				event: "PreToolUse",
				command: "scripts/scope-guard.sh",
				activation: "while-running",
			},
			{ ref: "lsp-report", name: "lsp-report" },
		],
		permissions: {
			deny: ["Bash(git push --force:*)"],
			ask: ["Bash(gh pr merge:*)"],
		},
	};

	it("slices into AGENTS/HOOKS/RULES, each labeled, in that order", () => {
		const groups = groupRows(sw);
		expect(groups.map((g) => g.kind)).toEqual(["agent", "hook", "permission"]);
		expect(groups.map((g) => g.label)).toEqual(["AGENTS", "HOOKS", "RULES"]);
	});

	it("keys both an inline and a ref hook row on `name`, flagging only the ref", () => {
		const hooks = groupRows(sw).find((g) => g.kind === "hook")!.rows;
		expect(hooks.map((r) => r.name)).toEqual(["orch-scope-guard", "lsp-report"]);
		expect(hooks.find((r) => r.name === "orch-scope-guard")?.isRef).toBeFalsy();
		expect(hooks.find((r) => r.name === "lsp-report")?.isRef).toBe(true);
	});

	it("carries the rule kind on a permission row", () => {
		const rules = groupRows(sw).find((g) => g.kind === "permission")!.rows;
		expect(rules).toEqual([
			{ kind: "permission", name: "Bash(git push --force:*)", rule_kind: "deny" },
			{ kind: "permission", name: "Bash(gh pr merge:*)", rule_kind: "ask" },
		]);
	});

	it("omits a group entirely when it has no declared rows", () => {
		const groups = groupRows({ agents: ["a1"] });
		expect(groups.map((g) => g.kind)).toEqual(["agent"]);
	});

	it("returns an empty list for an empty block", () => {
		expect(groupRows({})).toEqual([]);
	});
});

// ─── blockFromDraft round-trip (Approach 9) ─────────────────────────────────

describe("blockFromDraft", () => {
	it("round-trips a declared block through draftFromDeclared → blockFromDraft", () => {
		const sw: ShipsWith = {
			agents: ["orch-implementer", "orch-reviewer"],
			hooks: [
				{
					name: "orch-scope-guard",
					event: "PreToolUse",
					command: "scripts/scope-guard.sh",
					activation: "while-running",
				},
				{ ref: "lsp-report", name: "lsp-report" },
			],
			permissions: { deny: ["Bash(git push --force:*)"], ask: ["Bash(gh pr merge:*)"] },
		};
		const block = blockFromDraft(draftFromDeclared(sw));
		expect(block.agents).toEqual([{ name: "orch-implementer" }, { name: "orch-reviewer" }]);
		expect(block.hooks).toEqual([
			{
				name: "orch-scope-guard",
				event: "PreToolUse",
				command: "scripts/scope-guard.sh",
				activation: "while-running",
			},
			// A ref hook drops its convenience `name` — the SET body's ref
			// shape is `{ref}` only.
			{ ref: "lsp-report" },
		]);
		expect(block.permissions).toEqual({
			allow: [],
			deny: ["Bash(git push --force:*)"],
			ask: ["Bash(gh pr merge:*)"],
		});
	});

	it("produces independent copies — mutating the draft never touches the source block", () => {
		const sw: ShipsWith = { agents: ["a1"], hooks: [], permissions: { deny: [] } };
		const draft = draftFromDeclared(sw);
		draft.agents.push("a2");
		expect(sw.agents).toEqual(["a1"]);
	});
});

// ─── reconcileSentence (I7, wave 2) ─────────────────────────────────────────

describe("reconcileSentence", () => {
	function record(overrides: Partial<ReconcileResult["projects"][string]> = {}) {
		return {
			pending: [],
			stale_removed: [],
			reattached: [],
			drift: [],
			missing_refs: [],
			...overrides,
		};
	}

	it("reads 'N pending on P' for a single project", () => {
		const result: ReconcileResult = {
			projects: { "notes-vault": record({ pending: ["orch-unit-brief", "orch-reviewer"] }) },
		};
		expect(reconcileSentence(result)).toBe("2 pending on notes-vault");
	});

	it("reads 'pending on N projects' once more than one project has a pending name", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": record({ pending: ["orch-unit-brief"] }),
				"moon-base": record({ pending: ["orch-reviewer"] }),
			},
		};
		expect(reconcileSentence(result)).toBe("pending on 2 projects");
	});

	it("appends a kept count", () => {
		const result: ReconcileResult = {
			projects: { "notes-vault": record({ kept: ["orch-unit-brief"] }) },
		};
		expect(reconcileSentence(result)).toBe("kept 1");
	});

	it("appends an error count, pluralised", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": record({ errors: ["hook attach failed", "rule write failed"] }),
			},
		};
		expect(reconcileSentence(result)).toBe("2 errors");
	});

	it("joins pending + kept + errors when several are present", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": record({
					pending: ["orch-unit-brief"],
					kept: ["orch-reviewer"],
					errors: ["hook attach failed"],
				}),
			},
		};
		expect(reconcileSentence(result)).toBe("1 pending on notes-vault · kept 1 · 1 error");
	});

	it("reads 'Reconciled' when every project's record is empty", () => {
		expect(reconcileSentence({ projects: { "notes-vault": record() } })).toBe("Reconciled");
		expect(reconcileSentence({ projects: {} })).toBe("Reconciled");
	});
});

// ─── removalConsequences (Approach 9/W12) ───────────────────────────────────

describe("removalConsequences", () => {
	function registryWithTwoLedgers(): Registry {
		return {
			version: "1",
			skills: {},
			bundles: {},
			projects: {
				"notes-vault": {
					path: "/repo/notes-vault",
					bundles: [],
					enabled: ["orchestrate-advanced"],
					companions: {
						"orchestrate-advanced": {
							hooks: ["orch-unit-brief"],
							agents: ["orch-implementer"],
							permissions: [{ pattern: "Bash(git push --force:*)", kind: "deny" }],
						},
					},
				},
				"moon-base": {
					path: "/repo/moon-base",
					bundles: [],
					enabled: ["orchestrate-advanced"],
					companions: {
						"orchestrate-advanced": {
							hooks: ["orch-unit-brief"],
							agents: [],
							permissions: [],
						},
					},
				},
				"other-project": {
					path: "/repo/other",
					bundles: [],
					enabled: [],
				},
			},
		};
	}

	it("names every project whose ledger currently references the hook", () => {
		const reg = registryWithTwoLedgers();
		expect(removalConsequences(reg, "hook", "orch-unit-brief")).toEqual([
			"notes-vault",
			"moon-base",
		]);
	});

	it("names only the project whose ledger references the agent", () => {
		const reg = registryWithTwoLedgers();
		expect(removalConsequences(reg, "agent", "orch-implementer")).toEqual(["notes-vault"]);
	});

	it("names the project whose ledger references the exact (pattern, kind) pair", () => {
		const reg = registryWithTwoLedgers();
		expect(
			removalConsequences(reg, "permission", {
				pattern: "Bash(git push --force:*)",
				kind: "deny",
			}),
		).toEqual(["notes-vault"]);
	});

	it("returns an empty list for a name no ledger references", () => {
		const reg = registryWithTwoLedgers();
		expect(removalConsequences(reg, "hook", "no-such-hook")).toEqual([]);
	});

	it("returns an empty list for an undefined registry", () => {
		expect(removalConsequences(undefined, "hook", "orch-unit-brief")).toEqual([]);
	});
});

// ─── T9 — defaultHookScriptPath parity with ships_with.default_hook_script_rel ──
// The Python twin (`ships_with.py`): strip().lower() -> collapse every run of
// non-[a-z0-9] characters to one "-" -> strip("-"); `None` when nothing is
// left. Both suites must move in lockstep — a change to one side without the
// other is exactly the drift this parity test exists to catch.

describe("defaultHookScriptPath (T9, parity with ships_with.default_hook_script_rel)", () => {
	const CASES: [string, string | null][] = [
		["scope-guard", "scripts/scope-guard.sh"],
		["Scope Guard!!", "scripts/scope-guard.sh"],
		["  leading-trailing  ", "scripts/leading-trailing.sh"],
		["___", null],
		["", null],
		["  ", null],
	];

	it.each(CASES)("%j -> %j", (input, expected) => {
		expect(defaultHookScriptPath(input)).toBe(expected);
	});
});

// ─── T10 — validateNewHook ──────────────────────────────────────────────────

describe("validateNewHook (T10)", () => {
	const taken: NewHookTaken = {
		inline: ["already-inline"],
		refs: ["already-ref"],
		library: ["lint-report"],
	};
	const valid: NewHookDraft = {
		name: "new-guard",
		event: "PreToolUse",
		tools: [],
		activation: "while-running",
	};

	it("rejects an empty name, field 'name'", () => {
		expect(validateNewHook({ ...valid, name: "   " }, taken)).toMatchObject({
			ok: false,
			field: "name",
		});
	});

	it("rejects a name that slugifies to nothing, field 'name' (suggestion 12)", () => {
		expect(validateNewHook({ ...valid, name: "###" }, taken)).toMatchObject({
			ok: false,
			field: "name",
		});
	});

	it("accepts a name with spaces/mixed case that slugifies fine, kept verbatim (suggestion 12)", () => {
		expect(validateNewHook({ ...valid, name: "Scope Guard" }, taken)).toEqual({ ok: true });
	});

	it("rejects a name already declared inline, field 'name'", () => {
		expect(validateNewHook({ ...valid, name: "already-inline" }, taken)).toMatchObject({
			ok: false,
			field: "name",
		});
	});

	it("rejects a name already used as a ref, field 'name'", () => {
		expect(validateNewHook({ ...valid, name: "already-ref" }, taken)).toMatchObject({
			ok: false,
			field: "name",
		});
	});

	it("rejects a name that collides with a library hook, field 'name'", () => {
		expect(validateNewHook({ ...valid, name: "lint-report" }, taken)).toMatchObject({
			ok: false,
			field: "name",
		});
	});

	it("rejects an event outside CANONICAL_EVENTS, field 'event'", () => {
		expect(validateNewHook({ ...valid, event: "NotARealEvent" }, taken)).toMatchObject({
			ok: false,
			field: "event",
		});
	});

	it("accepts a valid, non-colliding draft", () => {
		expect(validateNewHook(valid, taken)).toEqual({ ok: true });
	});
});
