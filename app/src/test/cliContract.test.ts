import { afterAll, beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLOUD_TARGET_CATALOG } from "@/lib/cloud";

const SANDBOX_PREFIX = "skill-tree-cli-";
const STALE_SANDBOX_MS = 60 * 60 * 1000;
const sandboxes: string[] = [];

// A run killed mid-suite never reaches afterAll: 1,984 leftover sandboxes once
// filled the disk. Sweep anything older than an hour — old enough that no
// concurrent run (another worktree, a parallel CI job) can still own it.
// Best-effort on purpose, and async so a big backlog does not block the
// worker's event loop (vitest's worker RPC times out when a hook blocks).
async function sweepStaleSandboxes() {
	const tmpRoot = os.tmpdir();
	let entries: string[];
	try {
		entries = await fs.promises.readdir(tmpRoot);
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_SANDBOX_MS;
	for (const name of entries) {
		if (!name.startsWith(SANDBOX_PREFIX)) continue;
		const dir = path.join(tmpRoot, name);
		try {
			if ((await fs.promises.stat(dir)).mtimeMs < cutoff) {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		} catch {
			// Another run may have removed it between readdir and stat.
		}
	}
}

// Deleting a backlog of sandboxes can take well over the 10s hook default.
beforeAll(sweepStaleSandboxes, 180_000);
afterAll(async () => {
	await Promise.all(
		sandboxes.map((dir) =>
			fs.promises.rm(dir, { recursive: true, force: true }),
		),
	);
}, 60_000);

// What `python3 hub.py` reads from its code home: the nested Python package,
// vendored deps, the built-in hooks + connectors, scripts/, the starter skills,
// and VERSION. `code_home()` detection also wants an `app/` dir beside hub.py
// — an empty one satisfies it. Copying the whole repo used to cost ~100MB /
// 5,500 files per sandbox (the visual gallery, bundled CPython, and Playwright
// output — which a concurrent e2e run deletes mid-copy).
const CODE_HOME_DIRS = ["skill_hub", "vendor", "hooks", "connectors", "scripts", "skills"];
const CODE_HOME_FILES = [
	"VERSION",
	"requirements.txt",
	"ccusage-pricing.json",
	"skill_hub_mcp_server.py",
];

function copyCodeHome(repoRoot: string, hubDir: string) {
	fs.mkdirSync(path.join(hubDir, "app"), { recursive: true });
	for (const name of fs.readdirSync(repoRoot)) {
		if (name === "hub.py" || CODE_HOME_FILES.includes(name)) {
			fs.copyFileSync(path.join(repoRoot, name), path.join(hubDir, name));
		}
	}
	for (const dir of CODE_HOME_DIRS) {
		const src = path.join(repoRoot, dir);
		if (!fs.existsSync(src)) continue;
		fs.cpSync(src, path.join(hubDir, dir), {
			recursive: true,
			filter: (p) => path.basename(p) !== "__pycache__",
		});
	}
}

function setupHub() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
	sandboxes.push(tmp);
	const hubDir = path.join(tmp, ".skill-hub");
	copyCodeHome(path.resolve(process.cwd(), ".."), hubDir);
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
	// HOME is redirected too, not just SKILL_HUB_HOME: a harness's GLOBAL skills
	// dir is an absolute `~/.claude/skills` / `~/.agents/skills` path, so a sync
	// run here would otherwise write (and later sweep) symlinks in the developer's
	// REAL dotfiles — pointing at this throwaway temp dir. That actually happened.
	// The two harness homes that honour an env var of their own are pinned into
	// the sandbox as well. `$HOME` alone does NOT cover them: when the developer
	// (or CI) exports CODEX_HOME / SKILL_HUB_CLAUDE_HOME, `global_docs.doc_path`
	// reads it, and `harness doc link` would follow it straight out of the
	// sandbox into their real dotfiles.
	const sandboxHome = path.dirname(hubDir);
	return spawnSync("python3", ["hub.py", ...args], {
		cwd: hubDir,
		env: {
			...process.env,
			HOME: sandboxHome,
			USERPROFILE: sandboxHome,
			SKILL_HUB_HOME: hubDir,
			SKILL_HUB_CLAUDE_HOME: path.join(sandboxHome, ".claude"),
			CODEX_HOME: path.join(sandboxHome, ".codex"),
		},
		encoding: "utf8",
	});
}

describe("hub CLI contract", () => {
  it("loads worktree defaults through the isolated packaged CLI shape", () => {
    const hubDir = setupHub();
    const shown = run(hubDir, ["project", "worktree-defaults", "show", "--json"]);
    expect(shown.status, shown.stderr).toBe(0);
    const defaults = JSON.parse(shown.stdout);
    expect(defaults.ok).toBe(true);
    expect(defaults.defaults.access_enabled).toBe(false);
    expect(defaults.defaults.include_in_backup).toBe(false);
    const preview = run(hubDir, ["project", "worktree-defaults", "preview", "--name", "alpha", "--path", path.join(hubDir, "alpha"), "--json"]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).preview.path).toBe(path.join(fs.realpathSync(path.dirname(hubDir)), "Dev", "worktrees", "alpha"));
  });

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
			description: string;
			tools: string[];
			matcher: string;
			timeout: number | null;
			harnesses: string[] | null;
			attached_global: boolean;
			attached_projects: string[];
			settings: Record<string, unknown>;
			action: string;
			script: {
				source: string;
				interpreter: string;
				path?: string;
				args?: string;
				body?: string | null;
				body_path?: string | null;
			} | null;
			script_projects: Array<{ project: string; path_exists: boolean }>;
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
				"--description",
				"Lint after edits",
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
		expect(hook.description).toBe("Lint after edits");
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

		// The CLEAR sentinels: empty CSV / empty matcher / empty timeout — and
		// `--description ""`, which the editor sends on EVERY save of a hook with
		// no description (the bare `description` shorthand is "" there, and "" is
		// not nullish). A CLI without --description fails every editor save.
		expect(
			run(hubDir, [
				"hook",
				"edit",
				"lint-x",
				"--command",
				"echo hi",
				"--description",
				"",
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
		expect(hook.description).toBe("");
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

	it("accepts the hook script argv the bridge emits (managed + repo lifecycle)", () => {
		const hubDir = setupHub();
		const projectDir = path.join(hubDir, "fixtures", "project-scripts");
		fs.mkdirSync(projectDir, { recursive: true });

		// Managed create — `--script-args=` MUST be the single `=` token: the
		// value usually starts with a dash (`--fix`), which argparse rejects in
		// the two-token form. push_script_args() emits exactly this shape.
		expect(
			run(hubDir, [
				"hook",
				"new",
				"fmt-x",
				"--event",
				"PostToolUse",
				"--script-source",
				"managed",
				"--script-interpreter",
				"bash",
				"--script-args=--fix",
			]).status,
		).toBe(0);
		let hook = hookShow(hubDir, "fmt-x");
		expect(hook.action).toBe("script:managed");
		expect(hook.command).toBe("");
		expect(hook.script!.source).toBe("managed");
		expect(hook.script!.interpreter).toBe("bash");
		expect(hook.script!.args).toBe("--fix");
		// Managed body: seeded stub on create, round-trips through script save/show.
		expect(typeof hook.script!.body).toBe("string");
		const bodyFile = path.join(hubDir, "fixtures", "body.sh");
		fs.writeFileSync(bodyFile, "#!/usr/bin/env bash\necho hi\n");
		expect(
			run(hubDir, ["hook", "script", "save", "fmt-x", "--body-file", bodyFile])
				.status,
		).toBe(0);
		const shown = JSON.parse(
			run(hubDir, ["hook", "script", "show", "fmt-x", "--json"]).stdout,
		) as { body: string };
		expect(shown.body).toBe("#!/usr/bin/env bash\necho hi\n");

		// Switching to a plain command: the editor sends `--command` PLUS the
		// `--script-source ""` clear sentinel (push_script_args' clearing branch
		// drops the rest of the script group). Pin that exact combination.
		expect(
			run(hubDir, [
				"hook",
				"edit",
				"fmt-x",
				"--command",
				"echo done",
				"--script-source",
				"",
			]).status,
		).toBe(0);
		hook = hookShow(hubDir, "fmt-x");
		expect(hook.action).toBe("command");
		expect(hook.script).toBeNull();

		// And the reverse: setting a script source clears the command (the editor
		// deliberately does not send `--command ""` alongside it).
		expect(
			run(hubDir, [
				"hook",
				"edit",
				"fmt-x",
				"--script-source",
				"repo",
				"--script-interpreter",
				"bash",
				"--script-path",
				"scripts/lint.sh",
			]).status,
		).toBe(0);
		hook = hookShow(hubDir, "fmt-x");
		expect(hook.action).toBe("script:repo");
		expect(hook.command).toBe("");
		expect(hook.script!.path).toBe("scripts/lint.sh");

		// script_projects reports per-attached-project existence for repo scripts.
		expect(run(hubDir, ["project", "add", "scripts-proj", projectDir]).status).toBe(0);
		expect(
			run(hubDir, ["hook", "attach", "fmt-x", "--project", "scripts-proj"]).status,
		).toBe(0);
		hook = hookShow(hubDir, "fmt-x");
		expect(hook.script_projects).toEqual([
			{ project: "scripts-proj", path_exists: false },
		]);
		fs.mkdirSync(path.join(projectDir, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "scripts", "lint.sh"), "echo lint\n");
		expect(hookShow(hubDir, "fmt-x").script_projects).toEqual([
			{ project: "scripts-proj", path_exists: true },
		]);
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
	 * app would fail before it ever reached the packaged restore implementation.
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

	// ─── .skillpack share verbs — the exact argv the UI emits ────────────────
	// SkillEditor        → ["skill","export",<name>,"--out",<path>,"--json"]
	// SkillLibrary       → ["skill","import",<path>,"--dry-run","--json"]
	// ImportSkillDialog  → ["skill","import",<path>,"--json"(,"--name",<slug>)]
	it("round-trips a skill through export → dry-run preview → import", () => {
		const hubDir = setupHub();
		const out = path.join(hubDir, "brainstorm.skillpack");

		const exported = run(hubDir, [
			"skill",
			"export",
			"brainstorm",
			"--out",
			out,
			"--json",
		]);
		expect(`${exported.stderr}`).not.toContain("unrecognized arguments");
		expect(exported.status).toBe(0);
		const exportPayload = JSON.parse(
			exported.stdout.slice(exported.stdout.indexOf("{")),
		) as { exported: string; out: string; files: number };
		expect(exportPayload.exported).toBe("brainstorm");
		expect(exportPayload.out).toBe(out);
		expect(exportPayload.files).toBeGreaterThan(0);
		expect(fs.existsSync(out)).toBe(true);

		// Dry-run against the SAME registry → the name is taken, so the preview
		// must come back valid but flagged as a collision. That flag is exactly
		// what gates the dialog's name-override field.
		const preview = run(hubDir, ["skill", "import", out, "--dry-run", "--json"]);
		expect(`${preview.stderr}`).not.toContain("unrecognized arguments");
		const p = JSON.parse(preview.stdout.slice(preview.stdout.indexOf("{"))) as {
			valid: boolean;
			errors: string[];
			name: string;
			files: Array<{ path: string; bytes: number }>;
			collision: boolean;
		};
		expect(p.name).toBe("brainstorm");
		expect(p.collision).toBe(true);
		expect(p.files.some((f) => f.path === "SKILL.md")).toBe(true);
		expect(typeof p.files[0].bytes).toBe("number");
		// A dry-run writes nothing.
		expect(fs.existsSync(path.join(hubDir, "skills", "brainstorm-copy"))).toBe(
			false,
		);

		// Apply with the override the dialog would send.
		const applied = run(hubDir, [
			"skill",
			"import",
			out,
			"--json",
			"--name",
			"brainstorm-copy",
		]);
		expect(`${applied.stderr}`).not.toContain("unrecognized arguments");
		expect(applied.status).toBe(0);
		const imported = JSON.parse(
			applied.stdout.slice(applied.stdout.indexOf("{")),
		) as { imported: string };
		expect(imported.imported).toBe("brainstorm-copy");
		expect(
			fs.existsSync(path.join(hubDir, "skills", "brainstorm-copy", "SKILL.md")),
		).toBe(true);
		expect(fs.readFileSync(path.join(hubDir, "registry.yaml"), "utf8")).toContain(
			"brainstorm-copy",
		);
	}, 120000);

	// An unreadable pack answers with the OTHER JSON shape — a bare
	// `{"error": "..."}` instead of a preview. `normalizePreview` collapses the
	// two into one renderable invalid preview; this pins the CLI half.
	it("reports an unreadable pack as a JSON error object, not a crash", () => {
		const hubDir = setupHub();
		const bogus = path.join(hubDir, "bogus.skillpack");
		fs.writeFileSync(bogus, "this is not json");

		const preview = run(hubDir, [
			"skill",
			"import",
			bogus,
			"--dry-run",
			"--json",
		]);
		expect(`${preview.stderr}`).not.toContain("unrecognized arguments");
		expect(`${preview.stderr}`).not.toContain("Traceback");
		expect(preview.status).not.toBe(0);
		const payload = JSON.parse(
			preview.stdout.slice(preview.stdout.indexOf("{")),
		) as { valid?: boolean; errors?: string[]; error?: string };
		// Either shape is acceptable; what must hold is that it is machine
		// readable and says "not importable".
		expect(payload.valid ?? false).toBe(false);
		expect(
			(payload.errors?.length ?? 0) > 0 || !!payload.error,
		).toBe(true);
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
	// The cloud catalog is fixed in `skill_hub/infrastructure/filesystem/cloud_targets.py` (it describes somebody
	// else's product), and the frontend mirrors it so the palette needs no
	// subprocess at boot. This is the pin that makes the mirror safe: a backend
	// catalog change fails here instead of silently rotting a palette entry.
	it("matches the frontend's mirrored cloud catalog", () => {
		const hubDir = setupHub();
		const result = run(hubDir, ["cloud", "targets", "--json"]);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout) as Array<{
			id: string;
			label: string;
			upload_url: string;
			upload_path: string;
			equipped: number;
			drift: Record<string, number>;
			last_exported: string | null;
		}>;
		expect(payload.map((t) => ({ id: t.id, label: t.label }))).toEqual(
			CLOUD_TARGET_CATALOG,
		);
		for (const t of payload) {
			expect(typeof t.upload_url).toBe("string");
			expect(typeof t.upload_path).toBe("string");
			// `missing` is part of the rollup: without it a card could read
			// "equipped 1" beside an empty drift cluster.
			expect(Object.keys(t.drift).sort()).toEqual([
				"changed",
				"missing",
				"new",
				"orphaned",
				"up_to_date",
			]);
			// The card's "last exported" meta row. Null until the first export.
			expect(t.last_exported).toBeNull();
		}
	}, 120000);

	it("accepts the cloud argv the UI emits (equip → status → export)", () => {
		const hubDir = setupHub();
		expect(
			run(hubDir, [
				"cloud",
				"equip",
				"claude-ai",
				"--kind",
				"skill",
				"--name",
				"brainstorm",
				"--state",
				"on",
			]).status,
		).toBe(0);

		const status = run(hubDir, ["cloud", "status", "claude-ai", "--json"]);
		expect(status.status).toBe(0);
		const payload = JSON.parse(status.stdout) as {
			skills: { skill: string; status: string; lint: string[] }[];
			summary: { equipped: number };
		};
		expect(payload.summary.equipped).toBe(1);
		expect(payload.skills[0].skill).toBe("brainstorm");
		// Never exported yet → the UI's "new" badge.
		expect(payload.skills[0].status).toBe("new");

		const exported = run(hubDir, ["cloud", "export", "claude-ai", "--json"]);
		expect(exported.status).toBe(0);
		const result = JSON.parse(exported.stdout) as {
			out_dir: string;
			results: { skill: string; zip_path: string; status_before: string }[];
		};
		// The frontend reads `out_dir` (NOT export_dir) for the reveal-in-Finder
		// step, and one `zip_path` per exported skill.
		expect(typeof result.out_dir).toBe("string");
		expect(result.results.map((r) => r.skill)).toEqual(["brainstorm"]);
		expect(result.results[0].status_before).toBe("new");
	}, 120000);

	// global_docs.py lives in the nested package, so `copyCodeHome`'s package
	// copy already ships it into the sandbox — this proves
	// the module is actually importable + wired through `hub harness doc …`
	// from the bundled path, not just in a dev checkout.
	it("links and unlinks a harness's global instructions", () => {
		const hubDir = setupHub();
		const sandboxHome = path.dirname(hubDir);
		const claudeDoc = path.join(sandboxHome, ".claude", "CLAUDE.md");
		fs.mkdirSync(path.dirname(claudeDoc), { recursive: true });
		fs.writeFileSync(claudeDoc, "Shared instructions.\n");

		const before = run(hubDir, ["harness", "doc", "status", "--json"]);
		expect(before.status).toBe(0);
		const beforeRows = JSON.parse(before.stdout) as Array<{
			harness: string;
			state: string;
			follows: string | null;
			followers: string[];
		}>;
		const claudeBefore = beforeRows.find((r) => r.harness === "claude-code");
		expect(claudeBefore?.state).toBe("standalone");

		const linked = run(hubDir, [
			"harness",
			"doc",
			"link",
			"codex",
			"--to",
			"claude-code",
			"--json",
		]);
		expect(linked.status).toBe(0);
		const linkedPayload = JSON.parse(linked.stdout) as {
			changed: boolean;
			follower: string;
			source: string;
		};
		expect(linkedPayload.changed).toBe(true);
		expect(linkedPayload.follower).toBe("codex");
		expect(linkedPayload.source).toBe("claude-code");

		const afterLink = run(hubDir, ["harness", "doc", "status", "--json"]);
		const afterRows = JSON.parse(afterLink.stdout) as Array<{
			harness: string;
			state: string;
			follows: string | null;
			followers: string[];
		}>;
		expect(afterRows.find((r) => r.harness === "codex")?.state).toBe("follows");
		expect(afterRows.find((r) => r.harness === "codex")?.follows).toBe(
			"claude-code",
		);
		const claudeAfter = afterRows.find((r) => r.harness === "claude-code");
		expect(claudeAfter?.state).toBe("source");
		expect(claudeAfter?.followers).toEqual(["codex"]);

		const unlinked = run(hubDir, ["harness", "doc", "unlink", "codex", "--json"]);
		expect(unlinked.status).toBe(0);
		const unlinkedPayload = JSON.parse(unlinked.stdout) as { changed: boolean };
		expect(unlinkedPayload.changed).toBe(true);
		const codexDoc = path.join(sandboxHome, ".codex", "AGENTS.md");
		expect(fs.readFileSync(codexDoc, "utf8")).toBe("Shared instructions.\n");
	}, 120000);

	// Exit 2 is the ONE recoverable failure, and the app has to tell it apart
	// from a plain error (exit 1) to know whether to offer replace/merge. Both
	// arms print their payload on stdout and nothing else.
	it("reports a global-instructions conflict as exit 2 with a payload", () => {
		const hubDir = setupHub();
		const sandboxHome = path.dirname(hubDir);
		const claudeDoc = path.join(sandboxHome, ".claude", "CLAUDE.md");
		fs.mkdirSync(path.dirname(claudeDoc), { recursive: true });
		fs.writeFileSync(claudeDoc, "Shared instructions.\n");
		const codexDoc = path.join(sandboxHome, ".codex", "AGENTS.md");
		fs.mkdirSync(path.dirname(codexDoc), { recursive: true });
		fs.writeFileSync(codexDoc, "Codex has its own.\n");

		const conflict = run(hubDir, [
			"harness",
			"doc",
			"link",
			"codex",
			"--to",
			"claude-code",
			"--json",
		]);
		expect(conflict.status).toBe(2);
		const payload = JSON.parse(conflict.stdout) as {
			error: string;
			existing_bytes: number;
			preview: string;
		};
		expect(payload.error).toBe("conflict");
		expect(payload.existing_bytes).toBe("Codex has its own.\n".length);
		expect(payload.preview).toBe("Codex has its own.\n");
		// Refused, not half-applied.
		expect(fs.lstatSync(codexDoc).isSymbolicLink()).toBe(false);

		const other = run(hubDir, [
			"harness",
			"doc",
			"link",
			"codex",
			"--to",
			"codex",
			"--json",
		]);
		expect(other.status).toBe(1);
		expect((JSON.parse(other.stdout) as { error: string }).error).toBe(
			"same_harness",
		);

		const resolved = run(hubDir, [
			"harness",
			"doc",
			"link",
			"codex",
			"--to",
			"claude-code",
			"--on-conflict",
			"merge",
			"--json",
		]);
		expect(resolved.status).toBe(0);
		expect(fs.lstatSync(codexDoc).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(claudeDoc, "utf8")).toContain("Codex has its own.");
	}, 120000);

	// ships_with (D1-D5, plans/ships-with): the real `python3 hub.py` copy of
	// the D6 fixture, pinned against the contract plan 1 owns (I1/I2/A4/A5) —
	// the app's mock in `src/mocks/tauriCore.ts` models this shape but never
	// proves it against the real CLI.
	describe("ships_with companion provisioning (S6)", () => {
		const FIXTURE_ROOT = path.resolve(
			process.cwd(),
			"..",
			"tests",
			"fixtures",
			"ships_with",
			"orchestrate-advanced",
		);
		const FIXTURE_AGENTS = [
			"orch-sub-orchestrator",
			"orch-researcher",
			"orch-planner",
			"orch-griller",
			"orch-implementer",
			"orch-reviewer",
		];
		const FIXTURE_HOOKS = ["orch-scope-guard", "orch-report-guard", "orch-unit-brief"];
		const FIXTURE_PERMS = [
			{ pattern: "Bash(git push --force:*)", kind: "deny" },
			{ pattern: "Bash(gh pr merge:*)", kind: "ask" },
		];

		// Copies the real fixture into the sandbox `skills/` dir, registers it
		// (a plain `source:` entry — `_ships_with_block` reads the SKILL.md
		// frontmatter directly off disk, A4, so no `ships_with:` registry
		// mirror is needed for the CLI to plan/apply against it), and marks
		// claude-code "installed" the way `harnesses.DotDirWithMarker` checks
		// it (`~/.claude/projects/`) — a fresh sandbox HOME otherwise reports
		// every harness not-installed, `effective` harnesses is always empty,
		// and the skill can never gate at all.
		function setupShipsWith() {
			const hubDir = setupHub();
			const fixtureDest = path.join(hubDir, "skills", "orchestrate-advanced");
			fs.cpSync(FIXTURE_ROOT, fixtureDest, { recursive: true });
			const registryPath = path.join(hubDir, "registry.yaml");
			const registry = fs.readFileSync(registryPath, "utf8").replace(
				"projects: {}",
				[
					"  orchestrate-advanced:",
					'    version: "0.1.0"',
					'    description: "Deep orchestrator: split a large goal into independent chunks."',
					`    source: ${fixtureDest}`,
					"    type: claude-skill",
					"    scope: portable",
					"    upstream: null",
					"projects: {}",
				].join("\n"),
			);
			fs.writeFileSync(registryPath, registry);
			const sandboxHome = path.dirname(hubDir);
			fs.mkdirSync(path.join(sandboxHome, ".claude", "projects"), { recursive: true });
			return hubDir;
		}

		it("gates on the I2 needs_provisioning payload, payload-first (A4)", () => {
			const hubDir = setupShipsWith();
			const projectDir = path.join(hubDir, "fixtures", "gate-project");
			fs.mkdirSync(projectDir, { recursive: true });
			expect(run(hubDir, ["project", "add", "gate-project", projectDir]).status).toBe(0);

			const res = run(hubDir, [
				"enable",
				"orchestrate-advanced",
				"--project",
				"gate-project",
				"--json",
			]);
			expect(res.status).toBe(2);
			// A4: the payload is the FIRST stdout line — `_auto_sync_tail()`
			// prints more (uncolored here, since spawnSync gets no real tty)
			// after it on the same call.
			const firstLine = res.stdout.split("\n")[0];
			const payload = JSON.parse(firstLine) as {
				needs_provisioning: {
					skill: string;
					project: string;
					items: Array<{
						kind: string;
						name: string;
						rule_kind?: string;
						harness: string;
						verdict: string;
					}>;
				};
			};
			const needs = payload.needs_provisioning;
			expect(needs.skill).toBe("orchestrate-advanced");
			expect(needs.project).toBe("gate-project");
			expect(needs.items.length).toBeGreaterThan(0);

			// Item identity (kind/name/pattern) is env-independent; per-harness
			// verdict depends on the machine's `harness_probe` cache, so this
			// asserts WHAT is declared, not every verdict word.
			const agentNames = new Set(
				needs.items.filter((i) => i.kind === "agent").map((i) => i.name),
			);
			expect(agentNames).toEqual(new Set(FIXTURE_AGENTS));
			const hookNames = new Set(
				needs.items.filter((i) => i.kind === "hook").map((i) => i.name),
			);
			expect(hookNames).toEqual(new Set(FIXTURE_HOOKS));
			const permKeys = new Set(
				needs.items
					.filter((i) => i.kind === "permission")
					.map((i) => `${i.rule_kind}:${i.name}`),
			);
			expect(permKeys).toEqual(
				new Set(FIXTURE_PERMS.map((p) => `${p.kind}:${p.pattern}`)),
			);

			// The equip itself already landed (A4: registry saved before the
			// gate payload prints) even though provisioning did not.
			const registryText = fs.readFileSync(path.join(hubDir, "registry.yaml"), "utf8");
			expect(registryText).toMatch(
				/gate-project:[\s\S]*?enabled:\s*\n\s*-\s*orchestrate-advanced/,
			);
		}, 30000);

		it("writes the D4 ledger + agent files on --with-companions", () => {
			const hubDir = setupShipsWith();
			const projectDir = path.join(hubDir, "fixtures", "apply-project");
			fs.mkdirSync(projectDir, { recursive: true });
			expect(run(hubDir, ["project", "add", "apply-project", projectDir]).status).toBe(0);

			// A direct `--with-companions` call, first time equipping this
			// skill on this project — the two-phase gate (above) and the
			// apply are two independent CLI contracts, not chained here.
			const res = run(hubDir, [
				"enable",
				"orchestrate-advanced",
				"--project",
				"apply-project",
				"--json",
				"--with-companions",
			]);
			expect(res.status).toBe(0);
			const payload = JSON.parse(res.stdout.split("\n")[0]) as {
				ok: boolean;
				provisioned: {
					agents: string[];
					hooks: string[];
					permissions: Array<{ pattern: string; kind: string }>;
				};
			};
			expect(payload.ok).toBe(true);
			expect(new Set(payload.provisioned.agents)).toEqual(new Set(FIXTURE_AGENTS));
			expect(new Set(payload.provisioned.hooks)).toEqual(new Set(FIXTURE_HOOKS));
			expect(payload.provisioned.permissions).toEqual(
				expect.arrayContaining(FIXTURE_PERMS),
			);

			// The D4 ledger, read back through the read-only companions verb —
			// every item now reports `provisioned: true`.
			const status = run(hubDir, [
				"skill",
				"companions",
				"orchestrate-advanced",
				"--project",
				"apply-project",
				"--json",
			]);
			expect(status.status).toBe(0);
			const statusPayload = JSON.parse(status.stdout) as {
				items: Array<{ kind: string; name: string; provisioned: boolean }>;
			};
			expect(statusPayload.items.length).toBeGreaterThan(0);
			expect(statusPayload.items.every((i) => i.provisioned)).toBe(true);

			// The agent files land in the SANDBOXED user-scope dir — never the
			// developer's real ~/.claude/agents.
			const sandboxHome = path.dirname(hubDir);
			for (const name of ["orch-implementer", "orch-reviewer"]) {
				expect(
					fs.existsSync(path.join(sandboxHome, ".claude", "agents", `${name}.md`)),
				).toBe(true);
			}
		}, 30000);
	});
});
