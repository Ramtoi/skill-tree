import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function setupHub() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tree-cli-"));
	const hubDir = path.join(tmp, ".skill-hub");
	const repoRoot = path.resolve(process.cwd(), "..");
	fs.cpSync(repoRoot, hubDir, {
		recursive: true,
		filter: (src) =>
			!src.includes(`${path.sep}node_modules${path.sep}`) &&
			!src.includes(`${path.sep}.git${path.sep}`) &&
			!src.includes(`${path.sep}dist${path.sep}`) &&
			!src.includes(`${path.sep}target${path.sep}`),
	});
	// Reset registry to a minimal state so tests start from a clean slate
	// regardless of what entities exist in the dev registry.
	const skillsDir = path.join(hubDir, "skills");
	const brainstormSrc = path.join(skillsDir, "brainstorm");
	if (!fs.existsSync(brainstormSrc)) fs.mkdirSync(brainstormSrc, { recursive: true });
	fs.writeFileSync(
		path.join(brainstormSrc, "SKILL.md"),
		"---\nname: brainstorm\ndescription: |\n  Brainstorm.\n---\n",
	);
	const minimalRegistry = [
		'version: "1"',
		`hub_path: ${hubDir}`,
		"skills:",
		"  brainstorm:",
		'    version: "1.0.0"',
		'    description: "Brainstorm a feature."',
		`    source: ${brainstormSrc}`,
		"    type: claude-skill",
		"    scope: global",
		"    upstream: null",
		"projects: {}",
		"bundles: {}",
		"",
	].join("\n");
	fs.writeFileSync(path.join(hubDir, "registry.yaml"), minimalRegistry);
	// Drop any pre-existing ui-test-skill / cli-contract-skill source dirs
	// that may have been copied from the dev workspace.
	for (const stale of ["ui-test-skill", "cli-contract-skill"]) {
		const p = path.join(skillsDir, stale);
		if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
	}
	return hubDir;
}

function run(hubDir: string, args: string[]) {
	return spawnSync("python3", ["hub.py", ...args], {
		cwd: hubDir,
		env: { ...process.env, SKILL_HUB_HOME: hubDir },
		encoding: "utf8",
	});
}

describe("hub CLI contract", () => {
	it("supports the command shapes used by the UI", () => {
		const hubDir = setupHub();
		const projectDir = path.join(hubDir, "fixtures", "project-alpha");
		fs.mkdirSync(projectDir, { recursive: true });

		expect(
			run(hubDir, [
				"new",
				"skill",
				"ui-test-skill",
				"--scope",
				"portable",
				"--description",
				"UI created skill",
			]).status,
		).toBe(0);
		expect(
			run(hubDir, [
				"set-meta",
				"ui-test-skill",
				"--version",
				"1.2.3",
				"--description",
				"Updated skill",
				"--scope",
				"global",
				"--upstream",
				"https://example.com/repo",
			]).status,
		).toBe(0);
		expect(run(hubDir, ["project", "add", "alpha", projectDir]).status).toBe(0);
		expect(
			run(hubDir, [
				"bundle",
				"new",
				"workflow-test",
				"--skills",
				"ui-test-skill",
				"--description",
				"Workflow",
				"--icon",
				"⚡",
				"--scope",
				"project-specific",
			]).status,
		).toBe(0);
		expect(
			run(hubDir, [
				"bundle",
				"update",
				"workflow-test",
				"--skills",
				"ui-test-skill",
				"--description",
				"Workflow updated",
				"--icon",
				"✨",
				"--scope",
				"project-specific",
			]).status,
		).toBe(0);
		expect(
			run(hubDir, ["bundle", "apply", "workflow-test", "--project", "alpha"])
				.status,
		).toBe(0);
		expect(
			run(hubDir, ["enable", "ui-test-skill", "--project", "alpha"]).status,
		).toBe(0);
		expect(
			run(hubDir, ["disable", "ui-test-skill", "--project", "alpha"]).status,
		).toBe(0);
		expect(run(hubDir, ["project", "remove", "alpha"]).status).toBe(0);
	}, 60000);

	it("rejects applying a global bundle to a single project", () => {
		const hubDir = setupHub();
		const projectDir = path.join(hubDir, "fixtures", "project-alpha");
		fs.mkdirSync(projectDir, { recursive: true });

		expect(run(hubDir, ["project", "add", "alpha", projectDir]).status).toBe(0);
		expect(
			run(hubDir, [
				"bundle",
				"new",
				"global-workflow",
				"--skills",
				"brainstorm",
				"--scope",
				"global",
			]).status,
		).toBe(0);

		const result = run(hubDir, [
			"bundle",
			"apply",
			"global-workflow",
			"--project",
			"alpha",
		]);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("already applies everywhere");
	}, 120000);

	// ─── `hub hook …` — the argv shapes commands/hooks.rs marshals ──────────────
	// The Rust bridge is the only place the UI's intent becomes CLI argv, and the
	// CLI's semantics are SENTINEL-based: an empty `--tools ""` clears the list,
	// `--matcher ""` clears the matcher, `--timeout ""` clears the timeout (the
	// Option<String> encoding added after a shipped review-panel bug), and
	// `--yes` is what turns `hook delete` from a dry run into a real delete.
	// Nothing pinned those argv shapes against the real hub.py before this.

	function hookShow(hubDir: string, name: string) {
		const res = run(hubDir, ["hook", "show", name, "--json"]);
		expect(res.status).toBe(0);
		return JSON.parse(res.stdout) as {
			name: string;
			command: string;
			tools: string[];
			matcher: string;
			timeout: number | null;
			harnesses: string[] | null;
			attached_global: boolean;
			attached_projects: string[];
			settings: Record<string, unknown>;
		};
	}

	it("accepts the hook argv the Tauri bridge emits (new/edit/attach/detach/delete)", () => {
		const hubDir = setupHub();
		const projectDir = path.join(hubDir, "fixtures", "project-hooks");
		fs.mkdirSync(projectDir, { recursive: true });
		expect(run(hubDir, ["project", "add", "alpha", projectDir]).status).toBe(0);

		// `hook new` — the exact flag order push_common_def_args produces.
		expect(
			run(hubDir, [
				"hook",
				"new",
				"lint-x",
				"--event",
				"PostToolUse",
				"--command",
				"echo hi",
				"--timeout",
				"45",
				"--tools",
				"Edit,Write",
				"--matcher",
				"",
				"--harnesses",
				"claude-code",
			]).status,
		).toBe(0);

		let hook = hookShow(hubDir, "lint-x");
		expect(hook.command).toBe("echo hi");
		expect(hook.tools).toEqual(["Edit", "Write"]);
		expect(hook.timeout).toBe(45);
		expect(hook.harnesses).toEqual(["claude-code"]);

		// A raw matcher WINS over the tools list — it must round-trip verbatim.
		expect(
			run(hubDir, [
				"hook",
				"edit",
				"lint-x",
				"--command",
				"echo hi",
				"--tools",
				"Edit,Write",
				"--matcher",
				"Notebook.*",
				"--harnesses",
				"claude-code,codex",
			]).status,
		).toBe(0);
		hook = hookShow(hubDir, "lint-x");
		expect(hook.matcher).toBe("Notebook.*");
		expect(hook.harnesses).toEqual(["claude-code", "codex"]);

		// The CLEAR sentinels: empty CSV / empty matcher / empty timeout.
		expect(
			run(hubDir, [
				"hook",
				"edit",
				"lint-x",
				"--command",
				"echo hi",
				"--timeout",
				"",
				"--tools",
				"",
				"--matcher",
				"",
				"--harnesses",
				"",
			]).status,
		).toBe(0);
		hook = hookShow(hubDir, "lint-x");
		expect(hook.tools).toEqual([]);
		expect(hook.matcher).toBe("");
		expect(hook.timeout).toBeNull();
		expect(hook.harnesses).toBeNull();

		// Scope flags.
		expect(run(hubDir, ["hook", "attach", "lint-x", "--global"]).status).toBe(0);
		expect(
			run(hubDir, ["hook", "attach", "lint-x", "--project", "alpha"]).status,
		).toBe(0);
		hook = hookShow(hubDir, "lint-x");
		expect(hook.attached_global).toBe(true);
		expect(hook.attached_projects).toEqual(["alpha"]);

		expect(run(hubDir, ["hook", "detach", "lint-x", "--global"]).status).toBe(0);
		expect(hookShow(hubDir, "lint-x").attached_global).toBe(false);

		// set-settings marshals the JSON object as a single --json argument.
		expect(
			run(hubDir, [
				"hook",
				"set-settings",
				"lint-x",
				"--global",
				"--json",
				JSON.stringify({ voice: { name: "Karen" } }),
			]).status,
		).toBe(0);
		expect(hookShow(hubDir, "lint-x").settings).toEqual({
			voice: { name: "Karen" },
		});

		// `--yes` is load-bearing: without it delete is a dry run that still
		// exits 0, so a bridge that drops `confirm` would report a phantom
		// success while the hook survives.
		expect(run(hubDir, ["hook", "delete", "lint-x"]).status).toBe(0);
		expect(hookShow(hubDir, "lint-x").name).toBe("lint-x");
		expect(run(hubDir, ["hook", "delete", "lint-x", "--yes"]).status).toBe(0);
		const listed = JSON.parse(
			run(hubDir, ["hook", "list", "--json"]).stdout,
		) as { hooks: Array<{ name: string; provenance: string }> };
		expect(listed.hooks.map((h) => h.name)).not.toContain("lint-x");
		// The built-in still ships from code_home (not the registry).
		expect(
			listed.hooks.find((h) => h.name === "lsp-report")?.provenance,
		).toBe("builtin");
	}, 120000);

	it("rejects an attach with no scope flag (scope_args' silent no-flag case)", () => {
		const hubDir = setupHub();
		expect(
			run(hubDir, [
				"hook",
				"new",
				"lint-y",
				"--event",
				"PostToolUse",
				"--command",
				"echo hi",
			]).status,
		).toBe(0);
		// scope_args() emits `hub hook attach <name>` with NO flag when the UI
		// passes global=false and project=None — the CLI must fail closed rather
		// than guessing a scope.
		const res = run(hubDir, ["hook", "attach", "lint-y"]);
		expect(res.status).not.toBe(0);
		expect(`${res.stdout}${res.stderr}`).toContain(
			"exactly one of --global or --project",
		);
	}, 120000);

	/**
	 * The exact argv `src-tauri/src/commands/backup.rs::restore_args` builds.
	 *
	 * This is the gate that would have caught the integration bug it now pins:
	 * the source is a `--from` OPTION, and passing it as a bare positional makes
	 * argparse exit 2 with "unrecognized arguments" — i.e. every restore from the
	 * app would fail before it ever reached restore.py.
	 */
	it("accepts the restore argv the Tauri bridge emits (--from, both consent flags)", () => {
		const hubDir = setupHub();
		// A source that cannot resolve: the plan bails in `resolve_snapshot`
		// before anything is inspected, let alone written — so even the --apply
		// form below is inert.
		const missing = path.join(hubDir, "no-such-snapshot");

		const preview = run(hubDir, ["restore", "--from", missing, "--json", "--mode", "merge"]);
		expect(`${preview.stderr}`).not.toContain("unrecognized arguments");
		expect(() => JSON.parse(preview.stdout)).not.toThrow();

		const apply = run(hubDir, [
			"restore",
			"--from",
			missing,
			"--json",
			"--mode",
			"replace",
			"--apply",
			"--accept-executable-state",
			"--trust-new-key",
			"--force",
		]);
		expect(`${apply.stderr}`).not.toContain("unrecognized arguments");
		const payload = JSON.parse(apply.stdout) as { ok: boolean; error?: string };
		expect(payload.ok).toBe(false);
		expect(payload.error).toBeTruthy();

		// And the shape that must NEVER be emitted again.
		const positional = run(hubDir, ["restore", missing, "--json"]);
		expect(positional.status).not.toBe(0);
		expect(`${positional.stderr}`).toContain("unrecognized arguments");
	}, 120000);

	it("lists built-in permission presets (git-safe + android-gradle)", () => {
		const hubDir = setupHub();
		const result = run(hubDir, ["permissions", "presets", "list", "--json"]);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout) as Array<{
			id: string;
			builtin: boolean;
			rule_count: number;
		}>;
		const ids = payload.map((p) => p.id);
		expect(ids).toContain("git-safe");
		expect(ids).toContain("android-gradle");
		const gitSafe = payload.find((p) => p.id === "git-safe");
		expect(gitSafe?.builtin).toBe(true);
		expect((gitSafe?.rule_count ?? 0) > 0).toBe(true);
	}, 120000);
});
