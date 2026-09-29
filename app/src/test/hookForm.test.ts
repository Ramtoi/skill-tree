import { describe, it, expect } from "vitest";
import {
	deriveActionMode,
	deriveAppliesMode,
	hasLegacyBothMatcherAndTools,
	hookHealth,
	hookHealthChannel,
	hookHealthLabel,
	hookRunsLine,
	hookSummary,
	managedScriptStub,
	normalizeInterpreter,
	validateRepoScriptPath,
} from "@/lib/hookForm";
import * as hookForm from "@/lib/hookForm";
import { COMMON_TOOLS, hookToolGroups, hookToolVocabulary } from "@/lib/hookCatalog";
import { sampleRegistry } from "./helpers";
import type { HookDoctorFinding } from "@/hooks/useHooks";
import type { Registry } from "@/types";

// The redesigned editor presents two SEGMENTED modes over an unchanged registry
// model, so the mode is derived, never stored. If a derivation is wrong the
// editor opens showing controls that do not govern what the hook actually does —
// the exact class of lie this surface exists to remove.

describe("deriveAppliesMode", () => {
	it("empty tools + empty matcher = All tools", () => {
		expect(deriveAppliesMode({ tools: [], matcher: "" })).toBe("all");
		expect(deriveAppliesMode({})).toBe("all");
		expect(deriveAppliesMode({ tools: null, matcher: null })).toBe("all");
	});

	it("tools with no matcher = Specific tools", () => {
		expect(deriveAppliesMode({ tools: ["Edit"], matcher: "" })).toBe("tools");
	});

	it("a matcher WINS over tools (that is the backend's precedence)", () => {
		// `_resolve_matcher` uses the raw matcher and ignores the tool list, so
		// opening in Specific-tools mode would show a list that does not control
		// when the hook fires.
		expect(deriveAppliesMode({ tools: ["Edit"], matcher: "Notebook.*" })).toBe(
			"matcher",
		);
	});

	it("a whitespace-only matcher is not a matcher", () => {
		expect(deriveAppliesMode({ tools: ["Edit"], matcher: "   " })).toBe("tools");
	});

	it("flags the legacy both-set shape so the editor can say the tools are inert", () => {
		expect(hasLegacyBothMatcherAndTools({ tools: ["Edit"], matcher: "N.*" })).toBe(true);
		expect(hasLegacyBothMatcherAndTools({ tools: [], matcher: "N.*" })).toBe(false);
		expect(hasLegacyBothMatcherAndTools({ tools: ["Edit"], matcher: "" })).toBe(false);
	});
});

describe("deriveActionMode", () => {
	it("no script = shell command", () => {
		expect(deriveActionMode({ command: "echo hi" })).toBe("command");
		expect(deriveActionMode({ command: "", script: null })).toBe("command");
	});

	it("reads the script source", () => {
		expect(
			deriveActionMode({ command: "", script: { source: "managed", interpreter: "bash" } }),
		).toBe("managed");
		expect(
			deriveActionMode({
				command: "",
				script: { source: "repo", interpreter: "bash", path: "s.sh" },
			}),
		).toBe("repo");
	});

	it("a script wins even when a stale command is also present", () => {
		// new/edit refuse to create that state; a hand-edited registry can still
		// carry it, and the script is what the editor must show.
		expect(
			deriveActionMode({
				command: "leftover",
				script: { source: "managed", interpreter: "python3" },
			}),
		).toBe("managed");
	});
});

describe("interpreter helpers", () => {
	it("coerces registry drift to a supported interpreter", () => {
		expect(normalizeInterpreter("python3")).toBe("python3");
		expect(normalizeInterpreter("bash")).toBe("bash");
		expect(normalizeInterpreter("zsh")).toBe("bash");
		expect(normalizeInterpreter(undefined)).toBe("bash");
	});

	it("exports NO helper that composes a managed script's absolute path", () => {
		// The hooks dir hangs off `data_home()` ($SKILL_HUB_HOME, $SKILL_HUB_DIR, a
		// legacy ~/Dev/.skill-hub/), so a path assembled in the frontend is a guess
		// — and it was being shown inside a "this file will be deleted" confirm on
		// exactly the installs where the guess is wrong. Only the backend's real
		// path, or prose, may name that file.
		expect(Object.keys(hookForm)).not.toContain("managedScriptDisplayPath");
		expect(
			Object.values(hookForm).some(
				(v) => typeof v === "function" && String(v).includes(".skill-hub/hooks"),
			),
		).toBe(false);
	});

	it("seeds a runnable stub per interpreter", () => {
		expect(managedScriptStub("bash")).toContain("#!/usr/bin/env bash");
		expect(managedScriptStub("python3")).toContain("#!/usr/bin/env python3");
	});
});

describe("validateRepoScriptPath", () => {
	it("accepts a plain relative POSIX path", () => {
		expect(validateRepoScriptPath("scripts/lint.sh")).toBeNull();
		expect(validateRepoScriptPath("lint.sh")).toBeNull();
	});

	it("rejects an empty path", () => {
		expect(validateRepoScriptPath("   ")).toMatch(/required/);
	});

	it("rejects absolute paths (a repo script is per-project by definition)", () => {
		expect(validateRepoScriptPath("/usr/local/bin/lint")).toMatch(/relative/);
		expect(validateRepoScriptPath("~/bin/lint.sh")).toMatch(/relative/);
		expect(validateRepoScriptPath("C:\\lint.bat")).toMatch(/relative/);
	});

	it("rejects traversal out of the project root", () => {
		expect(validateRepoScriptPath("../../etc/evil.sh")).toMatch(/escape/);
		expect(validateRepoScriptPath("scripts/../../x.sh")).toMatch(/escape/);
		// A directory whose NAME merely starts with dots is fine.
		expect(validateRepoScriptPath("..config/lint.sh")).toBeNull();
	});

	it("rejects windows separators (the backend wants POSIX)", () => {
		expect(validateRepoScriptPath("scripts\\lint.sh")).toMatch(/forward slashes/);
	});
});

describe("hookSummary", () => {
	const base = {
		event: "PostToolUse",
		appliesMode: "all" as const,
		tools: [] as string[],
		matcher: "",
		actionMode: "command" as const,
		affinity: [] as string[],
	};

	it("describes the simplest hook end to end", () => {
		expect(hookSummary(base)).toBe(
			"On PostToolUse · all tools · runs a shell command · every effective harness",
		);
	});

	it("spells out the first two tools and collapses the rest", () => {
		expect(
			hookSummary({
				...base,
				appliesMode: "tools",
				tools: ["Edit", "Write", "MultiEdit"],
			}),
		).toContain("Edit, Write +1");
	});

	it("does not fabricate a `+0` for exactly two tools", () => {
		expect(
			hookSummary({ ...base, appliesMode: "tools", tools: ["Edit", "Write"] }),
		).toContain("· Edit, Write ·");
	});

	it("shows the matcher when the mode is Raw matcher", () => {
		expect(
			hookSummary({ ...base, appliesMode: "matcher", matcher: "Notebook.*" }),
		).toContain("matching /Notebook.*/");
	});

	it("names the action per mode, including the repo script's path", () => {
		expect(hookSummary({ ...base, actionMode: "managed" })).toContain(
			"runs a managed script",
		);
		expect(
			hookSummary({ ...base, actionMode: "repo", scriptPath: "scripts/lint.sh" }),
		).toContain("runs the repo script scripts/lint.sh");
		// Before the path is typed it must not claim a script that doesn't exist.
		expect(hookSummary({ ...base, actionMode: "repo" })).toContain("runs a repo script");
	});

	it("says a built-in runs a built-in script, not a generic shell command", () => {
		// hooks-screen-polish Wave C nit: the built-in's action is a read-only
		// shipped script, not something the user typed as a shell one-liner.
		expect(hookSummary({ ...base, builtin: true })).toContain(
			"runs a built-in script",
		);
		expect(hookSummary({ ...base, builtin: true })).not.toContain(
			"runs a shell command",
		);
		// A script-backed action still wins over `builtin` — an actual managed/
		// repo script never gets mislabelled as the built-in's baked one.
		expect(hookSummary({ ...base, actionMode: "managed", builtin: true })).toContain(
			"runs a managed script",
		);
	});

	it("names the targeted harnesses by LABEL once affinity is narrowed", () => {
		expect(
			hookSummary({ ...base, affinity: ["claude-code", "codex"] }),
		).toContain("Claude Code, Codex");
	});

	it("tracks a Specific-tools mode that has no tools yet without lying", () => {
		// Mid-edit state: the mode says "specific" but nothing is picked. Claiming
		// a narrowed set here would be wrong; `all tools` is what would be saved.
		expect(hookSummary({ ...base, appliesMode: "tools", tools: [] })).toContain(
			"all tools",
		);
	});
});

describe("hookRunsLine", () => {
	// hooks-screen-polish Wave A: the library row's third line — what actually
	// runs, in one glance. Four cases, one per action shape.

	it("a command hook shows its raw command", () => {
		expect(hookRunsLine({ command: "say done" })).toBe("say done");
	});

	it("a managed script shows interpreter + baked filename, ext by interpreter", () => {
		expect(
			hookRunsLine({
				command: "",
				script: { source: "managed", interpreter: "bash" },
			}),
		).toBe("bash script.sh");
		expect(
			hookRunsLine({
				command: "",
				script: { source: "managed", interpreter: "python3", args: "--fix" },
			}),
		).toBe("python3 script.py --fix");
	});

	it("a repo script shows interpreter + its project-relative path and args", () => {
		expect(
			hookRunsLine({
				command: "",
				script: {
					source: "repo",
					interpreter: "python3",
					path: "scripts/lint.py",
				},
			}),
		).toBe("python3 scripts/lint.py");
		expect(
			hookRunsLine({
				command: "",
				script: {
					source: "repo",
					interpreter: "bash",
					path: "scripts/lint.sh",
					args: "--strict",
				},
			}),
		).toBe("bash scripts/lint.sh --strict");
	});

	it("a built-in with a baked command shows the baked command compacted to basenames, not the template", () => {
		expect(
			hookRunsLine({
				command: "lsp-report --config {config}",
				provenance: "builtin",
				baked_command: "python3 /a/b/lsp_report.py --config /a/b/state.json",
			}),
		).toBe("python3 lsp_report.py --config state.json");
		expect(
			hookRunsLine({
				command: "template",
				provenance: "builtin",
				baked_command:
					"'/Applications/Skill Tree.app/Contents/Resources/python/bin/python3' '/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report/lsp_report.py' --config '/Users/alice/.skill-hub/state/hooks/lsp-report.global.json'",
			}),
		).toBe("python3 lsp_report.py --config lsp-report.global.json");
	});

	it("a built-in with no baked command falls back to the template command", () => {
		expect(
			hookRunsLine({
				command: "lsp-report --config {config}",
				provenance: "builtin",
				baked_command: null,
			}),
		).toBe("lsp-report --config {config}");
	});

	it("a user hook ignores baked_command even if present", () => {
		expect(
			hookRunsLine({
				command: "say done",
				provenance: "user",
				baked_command: "should not be used",
			}),
		).toBe("say done");
	});

	it("an empty definition renders an em dash", () => {
		expect(hookRunsLine({ command: "" })).toBe("—");
		expect(hookRunsLine({ command: null })).toBe("—");
		expect(hookRunsLine({})).toBe("—");
	});
});

describe("hookToolGroups", () => {
	it("puts the curated Common group first", () => {
		const groups = hookToolGroups(sampleRegistry as Registry);
		expect(groups[0].id).toBe("common");
		expect(groups[0].tools).toEqual([...COMMON_TOOLS]);
	});

	it("partitions the WHOLE vocabulary exactly once (no token is unreachable)", () => {
		const groups = hookToolGroups(sampleRegistry as Registry);
		const flat = groups.flatMap((g) => g.tools);
		// A duplicate would let one token show two independent checked states;
		// a missing one would be invisible in the picker but still valid in the
		// registry — both are silent correctness bugs.
		expect(new Set(flat).size).toBe(flat.length);
		expect([...flat].sort()).toEqual(
			[...hookToolVocabulary(sampleRegistry as Registry)].sort(),
		);
	});

	it("routes the registry's dynamic mcp__* tokens into the MCP group", () => {
		const mcp = hookToolGroups(sampleRegistry as Registry).find((g) => g.id === "mcp");
		expect(mcp?.tools).toContain("mcp__fs-mcp");
	});

	it("emits no empty groups", () => {
		for (const g of hookToolGroups(undefined)) {
			expect(g.tools.length).toBeGreaterThan(0);
		}
	});
});

describe("hookHealth", () => {
	// hooks-screen-polish Wave C: `hub hook doctor --json` findings, aggregated
	// per hook. Attribution is by the `hook` field alone — never by scanning
	// `detail` — so the tests below lean on that field to prove isolation.
	function finding(over: Partial<HookDoctorFinding> = {}): HookDoctorFinding {
		return {
			hook: "fmt",
			scope: "global",
			harness: "claude-code",
			code: "HOOK_BROKEN_SCRIPT",
			severity: "warning",
			explanation: "…",
			detail: "…",
			...over,
		};
	}

	it("is empty/null-worst for an undefined or empty findings list", () => {
		expect(hookHealth(undefined, "fmt")).toEqual({ worst: null, count: 0, items: [] });
		expect(hookHealth([], "fmt")).toEqual({ worst: null, count: 0, items: [] });
	});

	it("only counts findings attributed to the named hook", () => {
		const findings = [finding({ hook: "fmt" }), finding({ hook: "other" })];
		const health = hookHealth(findings, "fmt");
		expect(health.count).toBe(1);
		expect(health.items.every((f) => f.hook === "fmt")).toBe(true);
	});

	it("worst is danger even when it sorts after a warning in the input", () => {
		const findings = [
			finding({ code: "HOOK_BROKEN_SCRIPT", severity: "warning" }),
			finding({ code: "HOOK_RUNS_SUDO", severity: "danger" }),
		];
		const health = hookHealth(findings, "fmt");
		expect(health.worst).toBe("danger");
		expect(health.items[0].code).toBe("HOOK_RUNS_SUDO");
	});

	it("hookHealthLabel names the single severity when every finding shares it", () => {
		expect(hookHealthLabel(hookHealth([finding({ severity: "warning" })], "fmt"))).toBe(
			"1 warning",
		);
		expect(
			hookHealthLabel(
				hookHealth(
					[finding({ severity: "info" }), finding({ severity: "info" })],
					"fmt",
				),
			),
		).toBe("2 infos");
	});

	it("hookHealthLabel says 'N findings' once severities mix", () => {
		const health = hookHealth(
			[finding({ severity: "danger" }), finding({ severity: "info" })],
			"fmt",
		);
		expect(hookHealthLabel(health)).toBe("2 findings");
	});

	it("hookHealthLabel is empty for a clean hook", () => {
		expect(hookHealthLabel(hookHealth([], "fmt"))).toBe("");
	});

	it("hookHealthChannel maps danger/warning/info to error/warn/info", () => {
		expect(hookHealthChannel("danger")).toBe("error");
		expect(hookHealthChannel("warning")).toBe("warn");
		expect(hookHealthChannel("info")).toBe("info");
	});
});
