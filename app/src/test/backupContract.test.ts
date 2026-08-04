import { describe, expect, it } from "vitest";
import {
	backupRefusal,
	backupWarning,
	canApplyRestore,
	consequenceCount,
	driftFreshness,
	requiresExecutableConsent,
	requiresTrustConsent,
	requiresTypedConfirmation,
	restoreBlockReason,
	scrubTokens,
	summarizeBackupResult,
	toRestorePlan,
	typedConfirmationMet,
	type BackupStatus,
} from "@/lib/backupContract";

/**
 * The contract adapter is the single seam against the real `hub restore --json`
 * payload (`_restore_public(plan)` in hub.py). The fixtures below are trimmed
 * *captures* of that payload, not invented shapes — `registry.diff.sections`
 * holds the losses, `executable_state` is one object of three typed arrays,
 * out-of-home writes are the `subagents` / `global_docs` three-way verdicts, and
 * quarantined projects are the `projects` entries with `exists: false`.
 */

function status(over: Partial<BackupStatus> = {}): BackupStatus {
	return {
		enabled: true,
		initialized: true,
		configured: true,
		dir: "~/.skill-hub-backup",
		remote: "git@github.com:me/b.git",
		repo: "me/b",
		branch: "main",
		auth: {
			configured: "auto",
			pat_available: true,
			pat_detail: "stored",
			gh_login: "me",
			gh_active_login: "me",
			gh_account_mismatch: false,
		},
		push_failures: 0,
		last_push_error: null,
		pending_reconcile: false,
		last_commit: null,
		ahead: 0,
		behind: 0,
		drift: "in-sync",
		manifest: null,
		warnings: [],
		...over,
	};
}

describe("backupWarning", () => {
	it("is silent for a healthy, configured backup", () => {
		expect(backupWarning(status()).level).toBe("none");
	});

	it("is silent when backup was never configured (nothing to be stale about)", () => {
		expect(backupWarning(status({ configured: false, push_failures: 9 })).level).toBe("none");
		expect(backupWarning(null).level).toBe("none");
	});

	it("stays silent below the failure threshold and shouts at it", () => {
		expect(backupWarning(status({ push_failures: 2 })).level).toBe("none");
		const w = backupWarning(status({ push_failures: 3, last_push_error: "auth expired" }));
		expect(w.level).toBe("danger");
		expect(w.label).toContain("3");
		expect(w.detail).toBe("auth expired");
	});

	it("warns on pending_reconcile, and that outranks a failure count", () => {
		const w = backupWarning(status({ pending_reconcile: true, push_failures: 5 }));
		expect(w.level).toBe("warn");
		expect(w.label).toMatch(/restore pending/i);
	});

	it("escalates a refused publish from the sync report to danger", () => {
		const w = backupWarning(status(), {
			ran: true,
			skipped: null,
			committed: false,
			pushed: false,
			conflict: false,
			error: "credential-shaped string in skills/x/SKILL.md:3",
			error_kind: "secret_leak",
			at: "2026-08-04T09:00:00Z",
		});
		expect(w.level).toBe("danger");
		expect(w.label).toMatch(/refused/i);
		expect(w.detail).toContain("SKILL.md:3");
	});
});

describe("driftFreshness", () => {
	it("maps each drift value onto the shared freshness grammar", () => {
		expect(driftFreshness(status({ drift: "in-sync" })).state).toBe("fresh");
		expect(driftFreshness(status({ drift: "ahead", ahead: 2 })).state).toBe("stale");
		expect(driftFreshness(status({ drift: "behind", behind: 1 })).state).toBe("stale");
		expect(driftFreshness(status({ drift: "diverged" })).state).toBe("error");
		expect(driftFreshness(status({ drift: "unknown" })).state).toBe("unknown");
	});

	it("never claims freshness for an unconfigured or uninitialized hub", () => {
		expect(driftFreshness(status({ configured: false })).state).toBe("unknown");
		expect(driftFreshness(status({ initialized: false })).state).toBe("unknown");
		expect(driftFreshness(null).state).toBe("unknown");
	});
});

describe("summarizeBackupResult", () => {
	it("names a refused publish as a refusal, not a miss", () => {
		expect(
			summarizeBackupResult({
				ok: false,
				committed: false,
				pushed: false,
				error: "token found in snippets/a.md",
				error_kind: "secret_leak",
			}),
		).toMatch(/^Refused to publish/);
	});

	it("distinguishes pushed / committed-only / no-change", () => {
		expect(
			summarizeBackupResult({ ok: true, committed: true, pushed: true, push_detail: "pushed to origin/main" }),
		).toBe("pushed to origin/main");
		expect(summarizeBackupResult({ ok: true, committed: true, pushed: false })).toMatch(/locally/);
		expect(summarizeBackupResult({ ok: true, committed: false, pushed: false })).toMatch(/No changes/);
	});
});

/** Trust verdicts as `restore.py::classify_trust` emits them. */
const VERIFIED = {
	state: "verified",
	ok: true,
	hard: false,
	detail: "signed by the key pinned for this source",
	key_id: "SHA256:aaaa1111",
	pinned_key_id: "SHA256:aaaa1111",
};
const NEW_KEY = {
	state: "unverified-new-key",
	ok: false,
	hard: false,
	detail: "UNVERIFIED SNAPSHOT (new signing key SHA256:aaaa1111) — …",
	key_id: "SHA256:aaaa1111",
	pinned_key_id: null,
};
const MISMATCH = {
	state: "key-mismatch",
	ok: false,
	hard: true,
	detail: "this source is pinned to signing key SHA256:bbbb2222 … — refusing.",
	key_id: "SHA256:aaaa1111",
	pinned_key_id: "SHA256:bbbb2222",
};

function rawPlan(over: Record<string, unknown> = {}) {
	return {
		ok: true,
		fatal: false,
		schema_version: 1,
		apply: false,
		source: "git@example/b.git",
		mode: "replace",
		force: false,
		integrity: {
			tree_digest: { ok: true, detail: "tree digest matches" },
			signature: { state: "signed", key_id: "SHA256:aaaa1111" },
			trust: VERIFIED,
			ok: true,
		},
		registry: {
			target_populated: true,
			mode_required: false,
			diff: {
				sections: {
					projects: { added: ["note-board"], lost: ["scratch"], conflicts: [] },
					bundles: { added: [], lost: [], conflicts: ["android"] },
					skills: { added: [], lost: ["local-only-helper"], conflicts: [] },
					hooks: { added: ["fmt"], lost: [], conflicts: [] },
				},
				top_level_added: [],
				top_level_lost: ["permissions_global"],
				totals: { added: 2, lost: 2, conflicts: 1 },
			},
		},
		projects: [
			{ name: "gone", path: "/Users/alice/gone", resolved: "/Users/alice/gone", exists: false },
			{ name: "here", path: "/Users/alice/here", resolved: "/Users/alice/here", exists: true },
		],
		subagents: [
			{
				harness: "claude-code",
				name: "a.md",
				target: "/Users/alice/.claude/agents/a.md",
				action: "write",
				detail: "not present on this machine",
			},
			{
				harness: "claude-code",
				name: "same.md",
				target: "/Users/alice/.claude/agents/same.md",
				action: "skip",
				detail: "identical",
			},
			{
				harness: "codex",
				name: "x.toml",
				target: null,
				action: "unsupported",
				detail: "no target for this harness here",
			},
		],
		global_docs: [
			{
				harness: "claude-code",
				name: "CLAUDE.md",
				target: "/Users/alice/.claude/CLAUDE.md",
				action: "sibling",
				detail: "differs from the local file",
			},
		],
		executable_state: {
			hooks: [
				{
					name: "fmt",
					event: "PostToolUse",
					command: "/bin/fmt.sh --all",
					broken: true,
					missing_paths: ["/bin/fmt.sh"],
				},
			],
			permission_rules: [{ scope: "global", kind: "allow", pattern: "Bash(npm:*)" }],
			codex_trust: [{ project: "here", path: "/Users/alice/here", reason: "1 Bash rule" }],
			any: true,
			broken_hooks: ["fmt"],
			accepted: false,
			requires_consent: true,
		},
		warnings: ["2 env values redacted"],
		errors: [],
		next_steps: ["hub source restore starter", "hub sync"],
		...over,
	};
}

describe("toRestorePlan — the real wire shape", () => {
	it("derives losses and conflicts out of registry.diff.sections", () => {
		const plan = toRestorePlan(rawPlan(), "hint");
		expect(plan.source).toBe("git@example/b.git");
		expect(plan.mode).toBe("replace");
		expect(plan.lostEntries).toEqual([
			{ kind: "project", name: "scratch" },
			{ kind: "skill", name: "local-only-helper" },
			// A whole top-level block disappearing is a loss too.
			{ kind: "registry key", name: "permissions_global" },
		]);
		expect(plan.conflicts).toEqual([
			{ kind: "bundle", name: "android", resolution: "replaced by the backup" },
		]);
	});

	it("names the winner by the mode actually being applied", () => {
		expect(toRestorePlan(rawPlan({ mode: "merge" })).conflicts[0].resolution).toBe(
			"backup wins",
		);
	});

	it("flattens the three executable-state arrays, hook command verbatim", () => {
		const plan = toRestorePlan(rawPlan());
		expect(plan.executableState.map((e) => e.kind)).toEqual(["hook", "permission", "trust"]);
		const hook = plan.executableState[0];
		expect(hook.label).toBe("PostToolUse · fmt");
		// The command is what consent is GIVEN to — it must survive untouched.
		expect(hook.detail).toBe("/bin/fmt.sh --all");
		expect(hook.broken).toBe(true);
		expect(plan.executableState[1].detail).toBe("Bash(npm:*)");
		expect(plan.executableState[2].label).toBe("Codex trust · here");
	});

	it("takes quarantined projects from projects[] where exists is false", () => {
		const plan = toRestorePlan(rawPlan());
		expect(plan.unresolvedProjects).toEqual([{ name: "gone", path: "/Users/alice/gone" }]);
	});

	it("counts only three-way verdicts that actually write, at the path written", () => {
		const plan = toRestorePlan(rawPlan());
		expect(plan.outOfHomeTargets).toEqual([
			{
				path: "/Users/alice/.claude/agents/a.md",
				kind: "sub-agent",
				action: "write",
				detail: "not present on this machine",
			},
			{
				// `sibling` never touches the local file — it lands next to it.
				path: "/Users/alice/.claude/CLAUDE.md.from-backup",
				kind: "global doc",
				action: "sibling",
				detail: "differs from the local file",
			},
		]);
	});

	it("reads the consent gates off the real flags, not off list lengths", () => {
		const plan = toRestorePlan(rawPlan());
		expect(plan.requiresExecConsent).toBe(true);
		expect(requiresExecutableConsent(plan)).toBe(true);
		// requires_consent is authoritative even against a non-empty list.
		const noConsent = toRestorePlan(
			rawPlan({
				executable_state: {
					hooks: [{ name: "h", event: "PostToolUse", command: "x" }],
					permission_rules: [],
					codex_trust: [],
					any: true,
					requires_consent: false,
					accepted: true,
				},
			}),
		);
		expect(noConsent.executableState).toHaveLength(1);
		expect(noConsent.requiresExecConsent).toBe(false);
	});

	it("surfaces registry.mode_required and target_populated", () => {
		const plan = toRestorePlan(
			rawPlan({
				mode: null,
				registry: { target_populated: true, mode_required: true, diff: { sections: {} } },
			}),
		);
		expect(plan.targetPopulated).toBe(true);
		expect(plan.modeRequired).toBe(true);
		expect(canApplyRestore(plan, { executableState: true })).toBe(false);
		expect(restoreBlockReason(plan, { executableState: true })).toMatch(/replace or merge/i);
	});

	it("counts every destructive class in the headline", () => {
		// 3 lost + 1 conflict + 3 executable + 2 out-of-home = 9.
		expect(consequenceCount(toRestorePlan(rawPlan()))).toBe(9);
	});

	it("degrades to empty lists instead of throwing on junk", () => {
		for (const junk of [null, undefined, {}, 42, "nope", []]) {
			const plan = toRestorePlan(junk);
			expect(plan.lostEntries).toEqual([]);
			expect(plan.executableState).toEqual([]);
			expect(plan.warnings).toEqual([]);
			expect(consequenceCount(plan)).toBe(0);
		}
	});

	it("still absorbs a flat/legacy payload through the fallback spellings", () => {
		const plan = toRestorePlan({
			lost: [{ type: "skill", id: "old" }],
			executable: [{ type: "hook", id: "h", detail: "echo hi" }],
			quarantined_projects: [{ project: "p", expected_path: "/gone" }],
			outside_data_home: ["/Users/alice/.codex/agents/x.toml"],
		});
		expect(plan.lostEntries[0]).toMatchObject({ kind: "skill", name: "old" });
		expect(plan.executableState[0].detail).toBe("echo hi");
		expect(plan.unresolvedProjects[0]).toEqual({ name: "p", path: "/gone" });
		expect(plan.outOfHomeTargets[0].path).toBe("/Users/alice/.codex/agents/x.toml");
	});
});

describe("toRestorePlan — trust and integrity", () => {
	it("treats a verified snapshot as needing no trust consent", () => {
		const plan = toRestorePlan(rawPlan());
		expect(plan.trust.state).toBe("verified");
		expect(plan.unverified).toBe(false);
		expect(plan.requiresTrustConsent).toBe(false);
		expect(canApplyRestore(plan, { executableState: true })).toBe(true);
	});

	it("gates a new signing key behind consent and carries the CLI's sentence", () => {
		const plan = toRestorePlan(
			rawPlan({
				ok: false,
				integrity: {
					tree_digest: { ok: true, detail: "tree digest matches" },
					trust: NEW_KEY,
					ok: false,
				},
				errors: [`trust: ${NEW_KEY.detail}`],
			}),
		);
		expect(plan.unverified).toBe(true);
		expect(plan.requiresTrustConsent).toBe(true);
		expect(requiresTrustConsent(plan)).toBe(true);
		expect(plan.trust.detail).toContain("new signing key");
		// A consent-gated refusal is NOT a hard error — that would disable the
		// very button whose checkbox clears it.
		expect(plan.error).toBeNull();
		expect(canApplyRestore(plan, { executableState: true })).toBe(false);
		expect(canApplyRestore(plan, { executableState: true, trustNewKey: true })).toBe(true);
	});

	it("offers NO consent path for a hard key mismatch", () => {
		const plan = toRestorePlan({
			ok: false,
			fatal: true,
			source: "git@example/b.git",
			integrity: {
				tree_digest: { ok: true, detail: "tree digest matches" },
				trust: MISMATCH,
				ok: false,
			},
			errors: [`trust: ${MISMATCH.detail}`],
			warnings: [],
		});
		expect(plan.fatal).toBe(true);
		expect(plan.trust.hard).toBe(true);
		expect(plan.requiresTrustConsent).toBe(false);
		expect(plan.error).toContain("refusing");
		expect(canApplyRestore(plan, { executableState: true, trustNewKey: true })).toBe(false);
	});

	it("handles the TRUNCATED fatal payload (no registry / projects / exec state)", () => {
		// A bad tree digest returns right after `manifest` — every section the
		// UI would otherwise read is simply absent.
		const plan = toRestorePlan({
			ok: false,
			fatal: true,
			source: "/snap",
			mode: null,
			integrity: {
				tree_digest: { ok: false, detail: "tree digest mismatch — snapshot is incomplete" },
				trust: NEW_KEY,
				ok: false,
			},
			warnings: [],
			errors: ["integrity: tree digest mismatch — snapshot is incomplete"],
		});
		expect(plan.treeDigestOk).toBe(false);
		expect(plan.lostEntries).toEqual([]);
		expect(plan.executableState).toEqual([]);
		expect(plan.error).toContain("tree digest mismatch");
		expect(canApplyRestore(plan, { executableState: true, trustNewKey: true })).toBe(false);
	});

	it("never reads a missing trust block as trusted", () => {
		const plan = toRestorePlan({ ok: true });
		expect(plan.trust.state).toBe("unknown");
		expect(plan.trust.ok).toBe(false);
		expect(plan.unverified).toBe(true);
	});

	it("reports the CLI's own top-level {ok:false,error} bail-out as the error", () => {
		const plan = toRestorePlan({ ok: false, applied: false, error: "no snapshot at /nope" });
		expect(plan.error).toBe("no snapshot at /nope");
		expect(canApplyRestore(plan)).toBe(false);
	});
});

describe("toRestorePlan — applied", () => {
	it("reads the boolean off `apply`, not off the `applied` OBJECT", () => {
		const applied = toRestorePlan(
			rawPlan({
				apply: true,
				applied: {
					applied: true,
					writes: [{ kind: "registry", target: "~/.skill-hub/registry.yaml" }],
					backups: [],
					warnings: [],
				},
			}),
		);
		expect(applied.applied).toBe(true);
		expect(toRestorePlan(rawPlan()).applied).toBe(false);
	});
});

describe("toRestorePlan — the frozen request", () => {
	/**
	 * The request is captured on the plan at preview time so a destructive apply
	 * can be built from what the user was SHOWN, never from a form they may have
	 * edited since. The reported bug was exactly that gap: preview A in merge
	 * mode, edit the fields to B/replace, and the apply went to B while the
	 * dialog still described A.
	 */
	it("freezes the requested source and mode, independent of what the payload echoes", () => {
		const p = toRestorePlan(
			rawPlan({ source: "~/.skill-hub/state/restore-cache/deadbeef", mode: "replace" }),
			"git@github.com:me/b.git",
			"merge",
		);
		// The echo is still available for display…
		expect(p.source).toBe("~/.skill-hub/state/restore-cache/deadbeef");
		expect(p.mode).toBe("replace");
		// …but the REQUEST is what an apply must be built from.
		expect(p.requestedSource).toBe("git@github.com:me/b.git");
		expect(p.requestedMode).toBe("merge");
	});

	it("falls back to the payload when no hint was given (legacy callers)", () => {
		const p = toRestorePlan(rawPlan({ source: "/snap", mode: "merge" }));
		expect(p.requestedSource).toBe("/snap");
		expect(p.requestedMode).toBe("merge");
	});

	it("survives a payload that echoes neither", () => {
		const p = toRestorePlan({ ok: true }, "/snap", "replace");
		expect(p.requestedSource).toBe("/snap");
		expect(p.requestedMode).toBe("replace");
	});
});

describe("requiresTypedConfirmation", () => {
	it("asks whenever the restore can destroy something", () => {
		expect(
			requiresTypedConfirmation(toRestorePlan(rawPlan())),
			"the base fixture lists a lost entry",
		).toBe(true);
		expect(
			requiresTypedConfirmation(
				toRestorePlan(
					rawPlan({ registry: { target_populated: true, mode_required: false, diff: {} } }),
				),
			),
		).toBe(true);
	});

	it("stays out of the way for a genuinely empty target", () => {
		const empty = toRestorePlan(
			rawPlan({ registry: { target_populated: false, mode_required: false, diff: { sections: {} } } }),
		);
		expect(empty.lostEntries).toHaveLength(0);
		expect(requiresTypedConfirmation(empty)).toBe(false);
		expect(requiresTypedConfirmation(null)).toBe(false);
	});

	it("accepts the word case- and whitespace-insensitively, and nothing else", () => {
		expect(typedConfirmationMet("RESTORE")).toBe(true);
		expect(typedConfirmationMet("  restore ")).toBe(true);
		expect(typedConfirmationMet("restor")).toBe(false);
		expect(typedConfirmationMet("")).toBe(false);
	});
});

describe("backupRefusal", () => {
	const slot = {
		ran: true,
		skipped: null,
		committed: false,
		pushed: false,
		conflict: false,
		error: "credential-shaped string in skills/x/SKILL.md:3",
		error_kind: "secret_leak",
		at: "2026-08-04T09:00:00Z",
	};

	it("reads the sync-report slot", () => {
		expect(backupRefusal(status(), slot)).toMatchObject({
			kind: "secret_leak",
			origin: "sync-report",
		});
	});

	/** `backup status --json` is growing its own `error_kind`; the adapter must
	 *  already accept it, under either spelling, without requiring it. */
	it("also reads a top-level error_kind off backup status", () => {
		expect(
			backupRefusal(status({ error_kind: "prefix_leak", error: "home prefix in state/x" })),
		).toMatchObject({ kind: "prefix_leak", detail: "home prefix in state/x", origin: "status" });
		expect(
			backupRefusal(status({ last_error_kind: "secret_leak", last_error: "in snippets/a.md" })),
		).toMatchObject({ kind: "secret_leak", detail: "in snippets/a.md" });
	});

	it("ignores an ordinary failure, an unknown kind, and a missing field", () => {
		expect(backupRefusal(status(), { ...slot, error_kind: "network" })).toBeNull();
		expect(backupRefusal(status({ error_kind: "something_new" }))).toBeNull();
		expect(backupRefusal(status())).toBeNull();
		expect(backupRefusal(null)).toBeNull();
	});

	it("still escalates the chip when only the status carries the kind", () => {
		const w = backupWarning(status({ error_kind: "secret_leak", error: "found in x" }));
		expect(w.level).toBe("danger");
		expect(w.label).toMatch(/refused/);
		expect(w.detail).toBe("found in x");
	});
});

describe("scrubTokens", () => {
	it("replaces every documented credential prefix, longest first", () => {
		for (const t of [
			"ghp_abc123DEF456",
			"gho_oauthtoken00",
			"ghu_usertoken000",
			"ghs_servertoken0",
			"ghr_refreshtoken",
			"github_pat_11ABCDE_xyz789",
		]) {
			const out = scrubTokens(`remote rejected ${t} bad`);
			expect(out, t).toBe("remote rejected *** bad");
			expect(out).not.toContain(t);
		}
	});

	it("scrubs a token embedded in a URL, and every occurrence", () => {
		expect(scrubTokens("https://x:ghp_secretvalue1@github.com/o/r.git")).toBe(
			"https://x:***@github.com/o/r.git",
		);
		expect(scrubTokens("a ghp_one11111111 b github_pat_two22222 c")).toBe("a *** b *** c");
	});

	it("leaves a bare prefix (documentation) and ordinary text alone", () => {
		expect(scrubTokens("use a token with the ghp_ prefix")).toBe(
			"use a token with the ghp_ prefix",
		);
		expect(scrubTokens("café — ok")).toBe("café — ok");
	});

	it("accepts a thrown Error, not just a string", () => {
		expect(scrubTokens(new Error("push failed for ghp_deadbeefcafe1"))).toContain("***");
		expect(scrubTokens(undefined)).toBe("");
	});
});

describe("toRestorePlan — code_dirs (restored connector / MCP-server source)", () => {
	/** A snapshot whose ONLY executable state is restored code. Before the
	 *  fourth loop existed this produced `requiresExecConsent: true` with an
	 *  EMPTY list — a consent dialog asking the user to accept nothing. */
	function codeOnly(dirs: unknown[]) {
		return toRestorePlan(
			rawPlan({
				executable_state: {
					hooks: [],
					permission_rules: [],
					codex_trust: [],
					code_dirs: dirs,
					any: true,
					broken_hooks: [],
					accepted: false,
					requires_consent: true,
				},
			}),
		);
	}

	it("enumerates a code-only plan instead of consenting to an empty list", () => {
		const p = codeOnly([
			{
				kind: "connector",
				section: "connectors",
				name: "hermes",
				files: ["__init__.py", "hermes.py"],
				action: "new",
			},
		]);

		expect(p.requiresExecConsent).toBe(true);
		// The whole point: the consent list is NOT empty.
		expect(p.executableState).toHaveLength(1);
		expect(p.executableState[0]).toMatchObject({
			kind: "connector",
			label: "hermes",
			code: true,
			action: "new",
		});
		expect(p.executableState[0].files).toEqual(["__init__.py", "hermes.py"]);
	});

	it("counts an mcp-server dir the same way and marks an overwrite", () => {
		const p = codeOnly([
			{ kind: "mcp-server", section: "mcp-servers", name: "search", files: ["server.py"], action: "overwrite" },
		]);
		expect(p.executableState[0]).toMatchObject({
			kind: "mcp-server",
			label: "search",
			action: "overwrite",
			code: true,
		});
	});

	/** `identical` installs nothing new and does not count toward consent on the
	 *  Python side — listing it would inflate the dialog with non-events. */
	it("drops identical dirs, matching the Python consent semantics", () => {
		const p = codeOnly([
			{ kind: "connector", section: "connectors", name: "same", files: ["a.py"], action: "identical" },
			{ kind: "connector", section: "connectors", name: "changed", files: ["b.py"], action: "overwrite" },
		]);
		expect(p.executableState.map((e) => e.label)).toEqual(["changed"]);
	});

	it("sits alongside hooks and permission rules, not instead of them", () => {
		const p = toRestorePlan(
			rawPlan({
				executable_state: {
					hooks: [{ name: "fmt", event: "PostToolUse", command: "/bin/fmt.sh", broken: false }],
					permission_rules: [{ kind: "allow", scope: "global", pattern: "Bash(npm:*)" }],
					codex_trust: [],
					code_dirs: [
						{ kind: "connector", section: "connectors", name: "hermes", files: [], action: "new" },
					],
					requires_consent: true,
				},
			}),
		);
		expect(p.executableState).toHaveLength(3);
		expect(p.executableState.filter((e) => e.code)).toHaveLength(1);
		// The non-code items keep their existing shape (command verbatim).
		expect(p.executableState[0].detail).toBe("/bin/fmt.sh");
	});

	it("is absent-tolerant: a payload without code_dirs is unchanged", () => {
		const p = toRestorePlan(rawPlan());
		expect(p.executableState.every((e) => !e.code)).toBe(true);
	});
});

describe("toRestorePlan — additive fields from the Python wave", () => {
	it("accepts pinned_key_ids alongside (or instead of) pinned_key_id", () => {
		const many = toRestorePlan(
			rawPlan({
				integrity: {
					tree_digest: { ok: true },
					ok: true,
					trust: {
						state: "verified",
						ok: true,
						hard: false,
						detail: "signed",
						key_id: "SHA256:aaaa",
						pinned_key_ids: ["SHA256:aaaa", "SHA256:bbbb"],
					},
				},
			}),
		);
		expect(many.trust.pinnedKeyIds).toEqual(["SHA256:aaaa", "SHA256:bbbb"]);
		expect(many.trust.pinnedKeyId).toBe("SHA256:aaaa");

		// The older single-key payload still reads the same both ways.
		const one = toRestorePlan(rawPlan());
		expect(one.trust.pinnedKeyId).toBe("SHA256:aaaa1111");
		expect(one.trust.pinnedKeyIds).toEqual(["SHA256:aaaa1111"]);
	});

	it("counts retained files across data sections and the report tail", () => {
		const p = toRestorePlan(
			rawPlan({
				data: {
					skills: { retained: ["skills/local-only/SKILL.md", "skills/x/y.md"] },
					snippets: { retained: ["snippets/a.md"] },
					connectors: {},
				},
				report: { retained_extra_files: ["state/x.json"] },
			}),
		);
		expect(p.retainedFiles).toBe(4);
		// A pre-counted number is accepted too.
		expect(
			toRestorePlan(rawPlan({ report: { retained_extra_files: 7 } })).retainedFiles,
		).toBe(7);
		// And an absent block is simply zero, never NaN.
		expect(toRestorePlan(rawPlan()).retainedFiles).toBe(0);
	});

	it("carries the audit-ledger note verbatim, or null", () => {
		const p = toRestorePlan(
			rawPlan({ report: { audit_ledgers_note: "2 append-only ledgers were merged, not replaced" } }),
		);
		expect(p.auditLedgersNote).toBe("2 append-only ledgers were merged, not replaced");
		expect(toRestorePlan(rawPlan()).auditLedgersNote).toBeNull();
		expect(toRestorePlan(rawPlan({ report: { audit_ledgers_note: null } })).auditLedgersNote).toBeNull();
	});
});

describe("backupWarning — a skipped pass", () => {
	function slot(over: Record<string, unknown> = {}) {
		return {
			ran: false,
			skipped: null,
			committed: false,
			pushed: false,
			conflict: false,
			error: null,
			error_kind: null,
			at: "2026-08-04T09:00:00Z",
			...over,
		};
	}

	/** Not-configured is not stale. A hub with no backup set up has nothing to
	 *  be behind on, and a chip that fires for it is a chip nobody reads. */
	it("raises nothing for a pass skipped as not-configured", () => {
		expect(backupWarning(status(), slot({ skipped: "not-configured" })).level).toBe("none");
		// …even when stale counters linger on a half-configured status.
		expect(
			backupWarning(
				status({ push_failures: 9, pending_reconcile: true }),
				slot({ skipped: "not-configured" }),
			).level,
		).toBe("none");
	});

	it("still warns for an ordinary skip that is not about configuration", () => {
		expect(backupWarning(status({ pending_reconcile: true }), slot({ skipped: "unchanged" })).level).toBe(
			"warn",
		);
	});
});
