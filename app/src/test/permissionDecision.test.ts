import { describe, it, expect } from "vitest";
import {
	evaluateDecision,
	evaluateDecisionForHarness,
} from "@/lib/permissionDecision";
import type {
	Capabilities,
	NormalizedPermissions,
	Rule,
} from "@/types/permissions";

function perms(over: Partial<NormalizedPermissions>): NormalizedPermissions {
	return {
		allow: [],
		deny: [],
		ask: [],
		hooks: [],
		sandbox_mode: null,
		approval_policy: null,
		project_trust: null,
		additional_dirs: [],
		extras: {},
		_unmanaged: [],
		...over,
	};
}
const allow = (pattern: string): Rule => ({ pattern, kind: "allow" });
const deny = (pattern: string): Rule => ({ pattern, kind: "deny" });
const ask = (pattern: string): Rule => ({ pattern, kind: "ask" });

describe("evaluateDecision", () => {
	it("deny on a more specific prefix beats a broader allow", () => {
		const p = perms({
			allow: [allow("Bash(git:*)")],
			deny: [deny("Bash(git push:*)")],
		});
		expect(evaluateDecision(p, "git status")).toBe("allow");
		expect(evaluateDecision(p, "git push origin main")).toBe("deny");
	});

	it("returns ask for a command nothing matches", () => {
		const p = perms({ allow: [allow("Bash(git:*)")] });
		expect(evaluateDecision(p, "npm install")).toBe("ask");
	});

	it("Bash(*) allow matches any command", () => {
		const p = perms({ allow: [allow("Bash(*)")] });
		expect(evaluateDecision(p, "anything goes here")).toBe("allow");
		expect(evaluateDecision(p, "rm -rf /")).toBe("allow");
	});

	it("an equally-specific deny beats an allow", () => {
		const p = perms({
			allow: [allow("Bash(curl:*)")],
			deny: [deny("Bash(curl:*)")],
		});
		expect(evaluateDecision(p, "curl example.com")).toBe("deny");
	});

	it("an equally-specific ask beats an allow but loses to a deny", () => {
		const p = perms({
			allow: [allow("Bash(npm:*)")],
			ask: [ask("Bash(npm:*)")],
		});
		expect(evaluateDecision(p, "npm install")).toBe("ask");
	});

	it("ignores non-Bash rules entirely", () => {
		const p = perms({ allow: [allow("Read(./x)"), allow("Bash(ls:*)")] });
		// Read(./x) is not modelled; only Bash(ls:*) can match.
		expect(evaluateDecision(p, "ls -la")).toBe("allow");
		expect(evaluateDecision(p, "cat ./x")).toBe("ask");
	});

	it("empty command resolves to ask", () => {
		const p = perms({ allow: [allow("Bash(git:*)")] });
		expect(evaluateDecision(p, "")).toBe("ask");
	});
});

describe("evaluateDecisionForHarness", () => {
	// claude-code expresses every tool kind + any pattern; codex/opencode are
	// Bash-only, so a non-Bash rule drops out of THEIR rule set.
	const CAPS: Capabilities = {
		"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
		codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
		opencode: ["tool_allowlist", "tool_denylist", "tool_ask"],
	};

	it("all-Bash rules give the same verdict on every harness", () => {
		// Both rules are plain Bash prefixes — expressible everywhere — so the
		// deny on the more specific prefix wins identically across harnesses.
		const p = perms({
			allow: [allow("Bash(git:*)")],
			deny: [deny("Bash(git push:*)")],
		});
		for (const id of ["claude-code", "codex", "opencode"]) {
			expect(evaluateDecisionForHarness(p, "git push origin main", id, CAPS)).toBe(
				"deny",
			);
			expect(evaluateDecisionForHarness(p, "git status", id, CAPS)).toBe("allow");
		}
	});

	it("a deny capability only claude-code has flips the verdict", () => {
		// codex here lacks `tool_denylist` — so the deny never enters codex's rule
		// set, while claude-code (which has it) lets the deny override the allow.
		const CAPS_NO_CODEX_DENY: Capabilities = {
			"claude-code": ["tool_allowlist", "tool_denylist", "tool_ask"],
			codex: ["tool_allowlist", "tool_ask"], // no tool_denylist
		};
		const p = perms({
			allow: [allow("Bash(git:*)")],
			deny: [deny("Bash(git push:*)")],
		});
		expect(
			evaluateDecisionForHarness(
				p,
				"git push origin main",
				"claude-code",
				CAPS_NO_CODEX_DENY,
			),
		).toBe("deny");
		expect(
			evaluateDecisionForHarness(
				p,
				"git push origin main",
				"codex",
				CAPS_NO_CODEX_DENY,
			),
		).toBe("allow");
	});

	it("a non-Bash deny is inert in the scorer (Bash-only model) on every harness", () => {
		// The scorer only matches Bash patterns, so a non-Bash deny never scores —
		// even on claude-code, which CAN express it. Applicability filtering is
		// the modeled differentiator (see capability/affinity cases), not non-Bash
		// scoring. Documents the limitation so it can't silently regress.
		const p = perms({
			allow: [allow("Bash(cat:*)")],
			deny: [deny("Read(secrets/**)")],
		});
		for (const id of ["claude-code", "codex", "opencode"]) {
			expect(evaluateDecisionForHarness(p, "cat secrets/key", id, CAPS)).toBe(
				"allow",
			);
		}
	});

	it("affinity that excludes a harness drops the rule for that harness", () => {
		// The deny is affinity-pinned to claude-code only; codex sees just the
		// broad allow. Command exactly matches the pinned prefix tokens.
		const p = perms({
			allow: [allow("Bash(curl:*)")],
			deny: [
				{ pattern: "Bash(curl evil:*)", kind: "deny", harnesses: ["claude-code"] },
			],
		});
		expect(
			evaluateDecisionForHarness(p, "curl evil host", "claude-code", CAPS),
		).toBe("deny");
		expect(evaluateDecisionForHarness(p, "curl evil host", "codex", CAPS)).toBe(
			"allow",
		);
	});
});
