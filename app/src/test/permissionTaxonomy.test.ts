import { describe, expect, it } from "vitest";

import {
	affinityIncludes,
	ruleAppliesToHarness,
	ruleIsCommon,
	ruleMatchesFilter,
} from "@/lib/permissionHarnessFilter";
import { classifyTier } from "@/lib/permissionTiers";
import type { Capabilities, Rule } from "@/types/permissions";

// ─── classifyTier: risk-tier taxonomy ──────────────────────────────────────
describe("classifyTier", () => {
	it("classifies read-only coreutils as `read`", () => {
		for (const p of ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)"])
			expect(classifyTier(p)).toBe("read");
	});

	it("classifies build/lang toolchain (incl. bare git) as `build`", () => {
		for (const p of [
			"Bash(npm:*)",
			"Bash(pytest:*)",
			"Bash(cargo:*)",
			"Bash(./gradlew:*)",
			"Bash(git:*)",
		])
			expect(classifyTier(p)).toBe("build");
	});

	it("classifies destructive/network commands as `network`", () => {
		for (const p of ["Bash(rm:*)", "Bash(curl:*)", "Bash(sudo:*)"])
			expect(classifyTier(p)).toBe("network");
	});

	it("escalates `git push` to `network` via the multi-token rule", () => {
		expect(classifyTier("Bash(git push:*)")).toBe("network");
	});

	it("classifies a `cmd:arg` form by its base command (colon hardening)", () => {
		// `Bash(npm:test)` has no trailing `:*`; the command is still `npm`.
		expect(classifyTier("Bash(npm:test)")).toBe("build");
	});

	it("returns `other` for non-Bash tools and unbounded Bash", () => {
		for (const p of ["Read(./src/**)", "WebFetch(domain:example.com)", "Bash(*)"])
			expect(classifyTier(p)).toBe("other");
	});
});

// ─── harness filter derivation ──────────────────────────────────────────────
const CAPS: Capabilities = {
	"claude-code": [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"hooks",
		"additional_directories",
	],
	codex: [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"sandbox_mode",
		"approval_policy",
		"project_trust",
	],
	opencode: ["tool_allowlist", "tool_denylist", "tool_ask"],
};
const INSTALLED = ["claude-code", "codex", "opencode"];

const bashAllow: Rule = { pattern: "Bash(npm:*)", kind: "allow" };
const pathDeny: Rule = { pattern: "Read(secrets/**)", kind: "deny" };

describe("permissionHarnessFilter", () => {
	it("affinityIncludes: null affinity ⇒ every harness; explicit list narrows", () => {
		expect(affinityIncludes(bashAllow, "codex")).toBe(true);
		const scoped: Rule = { ...bashAllow, harnesses: ["claude-code"] };
		expect(affinityIncludes(scoped, "claude-code")).toBe(true);
		expect(affinityIncludes(scoped, "codex")).toBe(false);
	});

	it("a Bash rule is Common (expressible on every installed harness)", () => {
		expect(ruleIsCommon(bashAllow, INSTALLED, CAPS)).toBe(true);
	});

	it("a path-scoped rule is NOT Common (Codex can't express it)", () => {
		// Codex's pattern caveat rejects non-Bash patterns.
		expect(ruleAppliesToHarness(pathDeny, "claude-code", CAPS)).toBe(true);
		expect(ruleAppliesToHarness(pathDeny, "codex", CAPS)).toBe(false);
		expect(ruleIsCommon(pathDeny, INSTALLED, CAPS)).toBe(false);
	});

	it("ruleMatchesFilter respects all / common / per-harness / affinity", () => {
		expect(ruleMatchesFilter(pathDeny, "all", INSTALLED, CAPS)).toBe(true);
		expect(ruleMatchesFilter(pathDeny, "common", INSTALLED, CAPS)).toBe(false);
		expect(
			ruleMatchesFilter(bashAllow, { harness: "codex" }, INSTALLED, CAPS),
		).toBe(true);
		expect(
			ruleMatchesFilter(pathDeny, { harness: "codex" }, INSTALLED, CAPS),
		).toBe(false);
		const scoped: Rule = { ...bashAllow, harnesses: ["claude-code"] };
		expect(
			ruleMatchesFilter(scoped, { harness: "codex" }, INSTALLED, CAPS),
		).toBe(false);
	});

	it("nothing is Common when no harness is installed", () => {
		expect(ruleIsCommon(bashAllow, [], CAPS)).toBe(false);
	});
});
