import { describe, it, expect } from "vitest";
import {
	orphanSettings,
	partitionSettings,
	settingsDiffer,
	settingValueLabels,
	supportingHarnesses,
	SETTING_FEATURES,
} from "@/lib/permissionSettingSupport";
import { codexRuleLines } from "@/components/permissions/CodexRulesSection";
import { emptyPermissions } from "@/types/permissions";
import type { Capabilities } from "@/types/permissions";

describe("SETTING_FEATURES", () => {
	it("is the four harness-level settings, in a fixed order", () => {
		expect(SETTING_FEATURES).toEqual([
			"sandbox_mode",
			"approval_policy",
			"project_trust",
			"additional_directories",
		]);
	});
});

describe("supportingHarnesses", () => {
	it("returns only installed harnesses whose capability set includes the feature", () => {
		const caps: Capabilities = {
			"claude-code": ["tool_allowlist"],
			codex: ["sandbox_mode"],
			pi: ["sandbox_mode", "project_trust"],
		};
		expect(
			supportingHarnesses("sandbox_mode", ["claude-code", "codex", "pi"], caps),
		).toEqual(["codex", "pi"]);
		expect(
			supportingHarnesses("project_trust", ["claude-code", "codex"], caps),
		).toEqual([]);
	});
});

describe("partitionSettings", () => {
	it("puts a feature supported by >=2 installed harnesses into shared", () => {
		const caps: Capabilities = {
			"claude-code": ["additional_directories"],
			codex: ["additional_directories"],
		};
		const { shared, exclusive } = partitionSettings(
			["claude-code", "codex"],
			caps,
		);
		expect(shared).toEqual(["additional_directories"]);
		expect(exclusive).toEqual({});
	});

	it("puts a feature supported by exactly one of several installed harnesses into exclusive", () => {
		const caps: Capabilities = {
			"claude-code": ["additional_directories"],
			codex: ["sandbox_mode", "approval_policy", "additional_directories"],
			pi: ["project_trust", "additional_directories"],
		};
		const { shared, exclusive } = partitionSettings(
			["claude-code", "codex", "pi"],
			caps,
		);
		expect(shared).toEqual(["additional_directories"]);
		expect(exclusive).toEqual({
			codex: ["sandbox_mode", "approval_policy"],
			pi: ["project_trust"],
		});
	});

	it("with exactly one installed harness, treats everything it supports as shared", () => {
		const caps: Capabilities = {
			codex: ["sandbox_mode", "project_trust"],
		};
		const { shared, exclusive } = partitionSettings(["codex"], caps);
		expect(shared).toEqual(["sandbox_mode", "project_trust"]);
		expect(exclusive).toEqual({});
	});

	it("with zero installed harnesses, every setting is still shared (live, never hidden)", () => {
		const { shared, exclusive } = partitionSettings([], {});
		expect(shared).toEqual(SETTING_FEATURES);
		expect(exclusive).toEqual({});
	});

	it("a feature no installed harness supports appears in neither bucket", () => {
		const caps: Capabilities = { "claude-code": ["tool_allowlist"] };
		const { shared, exclusive } = partitionSettings(["claude-code"], caps);
		expect(shared).toEqual([]);
		expect(exclusive).toEqual({});
	});
});

describe("orphanSettings", () => {
	it("flags a draft value set on a feature no installed harness honors", () => {
		const caps: Capabilities = { "claude-code": ["tool_allowlist"] };
		const draft = { ...emptyPermissions(), sandbox_mode: "workspace-write" };
		expect(orphanSettings(draft, ["claude-code"], caps)).toEqual([
			"sandbox_mode",
		]);
	});

	it("does not flag an unset feature", () => {
		const caps: Capabilities = { "claude-code": ["tool_allowlist"] };
		expect(orphanSettings(emptyPermissions(), ["claude-code"], caps)).toEqual(
			[],
		);
	});

	it("does not flag a feature a supported harness honors", () => {
		const caps: Capabilities = { codex: ["sandbox_mode"] };
		const draft = { ...emptyPermissions(), sandbox_mode: "workspace-write" };
		expect(orphanSettings(draft, ["codex"], caps)).toEqual([]);
	});

	it("treats a non-empty additional_dirs as set", () => {
		const caps: Capabilities = { "claude-code": ["tool_allowlist"] };
		const draft = { ...emptyPermissions(), additional_dirs: ["/tmp"] };
		expect(orphanSettings(draft, ["claude-code"], caps)).toEqual([
			"additional_directories",
		]);
	});

	it("with zero installed harnesses, nothing is ever an orphan", () => {
		const draft = { ...emptyPermissions(), sandbox_mode: "workspace-write" };
		expect(orphanSettings(draft, [], {})).toEqual([]);
	});
});

describe("settingsDiffer", () => {
	it("is false when the four settings match", () => {
		const a = { ...emptyPermissions(), sandbox_mode: "workspace-write" };
		const b = { ...emptyPermissions(), sandbox_mode: "workspace-write" };
		expect(settingsDiffer(a, b)).toBe(false);
	});

	it("treats null/undefined/empty-string as equally unset", () => {
		const a = { ...emptyPermissions(), approval_policy: "" };
		const b = { ...emptyPermissions(), approval_policy: null };
		expect(settingsDiffer(a, b)).toBe(false);
	});

	it("is true when a scalar setting changed", () => {
		const a = { ...emptyPermissions(), project_trust: true };
		const b = { ...emptyPermissions(), project_trust: null };
		expect(settingsDiffer(a, b)).toBe(true);
	});

	it("compares additional_dirs as an array (order and length both matter)", () => {
		const a = { ...emptyPermissions(), additional_dirs: ["/a", "/b"] };
		const b = { ...emptyPermissions(), additional_dirs: ["/a"] };
		expect(settingsDiffer(a, b)).toBe(true);
		const c = { ...emptyPermissions(), additional_dirs: ["/a", "/b"] };
		expect(settingsDiffer(a, c)).toBe(false);
	});
});

describe("settingValueLabels", () => {
	it("is empty when nothing is set", () => {
		expect(settingValueLabels(emptyPermissions())).toEqual([]);
	});

	it("names each set value, project_trust as trusted/untrusted", () => {
		const draft = {
			...emptyPermissions(),
			sandbox_mode: "workspace-write",
			approval_policy: "on-failure",
			project_trust: true,
			additional_dirs: ["/a", "/b"],
		};
		expect(settingValueLabels(draft)).toEqual([
			"workspace-write",
			"on-failure",
			"trusted",
			"2 dirs",
		]);
	});

	it("singularizes a lone directory", () => {
		const draft = { ...emptyPermissions(), additional_dirs: ["/a"] };
		expect(settingValueLabels(draft)).toEqual(["1 dir"]);
	});
});

describe("codexRuleLines", () => {
	it("translates a bounded Bash prefix rule into a prefix_rule line, ordered allow/deny/ask", () => {
		const draft = {
			...emptyPermissions(),
			allow: [{ pattern: "Bash(npm:*)", kind: "allow" as const }],
			deny: [{ pattern: "Bash(rm -rf:*)", kind: "deny" as const }],
			ask: [{ pattern: "Bash(git push:*)", kind: "ask" as const }],
		};
		const { lines, rows, skipped } = codexRuleLines(draft);
		expect(skipped).toBe(0);
		expect(rows).toEqual([
			{ tokens: ["npm"], decision: "allow", kind: "allow" },
			{ tokens: ["rm", "-rf"], decision: "forbidden", kind: "deny" },
			{ tokens: ["git", "push"], decision: "prompt", kind: "ask" },
		]);
		expect(lines).toEqual([
			'prefix_rule(pattern = ["npm"], decision = "allow")',
			'prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden")',
			'prefix_rule(pattern = ["git", "push"], decision = "prompt")',
		]);
	});

	it("skips a non-Bash or unbounded rule and counts it", () => {
		const draft = {
			...emptyPermissions(),
			allow: [
				{ pattern: "Read(src/**)", kind: "allow" as const },
				{ pattern: "Bash(*)", kind: "allow" as const },
			],
		};
		const { lines, rows, skipped } = codexRuleLines(draft);
		expect(rows).toEqual([]);
		expect(lines).toEqual([]);
		expect(skipped).toBe(2);
	});

	it("empty draft produces no lines and no skips", () => {
		expect(codexRuleLines(emptyPermissions())).toEqual({
			lines: [],
			rows: [],
			skipped: 0,
		});
	});
});
