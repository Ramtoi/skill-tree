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
	});

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
	});
});
