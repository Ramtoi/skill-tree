import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
	detectRisks,
	findingsByPattern,
	worstSeverity,
} from "@/lib/permissionsRisks";
import type {
	NormalizedPermissions,
	RiskSchemaEntry,
} from "@/types/permissions";

// Risk schema mirror — pinned so the test doesn't depend on a build artifact.
// Source-of-truth verification happens via the goldenMatchesPython test below.
const SCHEMA: RiskSchemaEntry[] = [
	{
		code: "UNBOUNDED_BASH",
		severity: "danger",
		explanation:
			"Allow rule grants every Bash invocation. Narrow to specific commands (e.g. Bash(npm:*)).",
	},
	{
		code: "UNBOUNDED_WRITE",
		severity: "danger",
		explanation:
			"Allow rule grants every Write. Scope writes to specific paths.",
	},
	{
		code: "UNBOUNDED_FETCH",
		severity: "warning",
		explanation:
			"Allow rule grants every WebFetch. Scope to specific domains where possible.",
	},
	{
		code: "UNSAFE_CODEX_COMBO",
		severity: "danger",
		explanation:
			"approval_policy=never combined with sandbox_mode=danger-full-access disables every guardrail.",
	},
	{
		code: "HOOK_RUNS_SUDO",
		severity: "danger",
		explanation:
			"Hook command invokes sudo. Hub-managed hooks must not require elevated privileges.",
	},
];

function emptyPerms(): NormalizedPermissions {
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
	};
}

describe("detectRisks", () => {
	it("flags UNBOUNDED_BASH for an unbounded bash allow", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			allow: [{ pattern: "Bash(*)", kind: "allow" }],
		};
		const findings = detectRisks(perms, SCHEMA);
		expect(findings).toHaveLength(1);
		expect(findings[0].code).toBe("UNBOUNDED_BASH");
		expect(findings[0].severity).toBe("danger");
	});

	it("flags UNBOUNDED_FETCH as warning, sorted after danger", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			allow: [
				{ pattern: "WebFetch(*)", kind: "allow" },
				{ pattern: "Bash(*)", kind: "allow" },
			],
		};
		const findings = detectRisks(perms, SCHEMA);
		expect(findings[0].severity).toBe("danger");
		expect(findings[1].severity).toBe("warning");
	});

	it("flags UNSAFE_CODEX_COMBO when both settings line up", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
		};
		const findings = detectRisks(perms, SCHEMA);
		expect(findings.find((f) => f.code === "UNSAFE_CODEX_COMBO")).toBeTruthy();
	});

	it("flags HOOK_RUNS_SUDO on a sudo-bearing hook", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			hooks: [{ event: "PreToolUse", matcher: "Bash", command: "sudo rm -rf" }],
		};
		const findings = detectRisks(perms, SCHEMA);
		expect(findings.find((f) => f.code === "HOOK_RUNS_SUDO")).toBeTruthy();
	});

	it("returns empty for clean payload", () => {
		expect(detectRisks(emptyPerms(), SCHEMA)).toEqual([]);
	});
});

describe("findingsByPattern / worstSeverity", () => {
	it("indexes findings by their detail string", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			allow: [{ pattern: "Bash(*)", kind: "allow" }],
		};
		const findings = detectRisks(perms, SCHEMA);
		const idx = findingsByPattern(findings);
		expect(idx["Bash(*)"]).toHaveLength(1);
	});

	it("deduplicates identical findings so duplicate rows do not multiply badges", () => {
		const perms: NormalizedPermissions = {
			...emptyPerms(),
			allow: [
				{ pattern: "Bash(*)", kind: "allow" },
				{ pattern: "Bash(*)", kind: "allow" },
			],
		};
		const idx = findingsByPattern(detectRisks(perms, SCHEMA));
		expect(idx["Bash(*)"]).toHaveLength(1);
	});

	it("worstSeverity picks danger over warning", () => {
		expect(
			worstSeverity([
				{ code: "X", severity: "warning", explanation: "", detail: "" },
				{ code: "Y", severity: "danger", explanation: "", detail: "" },
			]),
		).toBe("danger");
		expect(
			worstSeverity([
				{ code: "X", severity: "warning", explanation: "", detail: "" },
			]),
		).toBe("warning");
		expect(worstSeverity([])).toBeNull();
	});
});

// ─── Golden parity with Python risks.detect_risks ─────────────────────────

describe("detectRisks matches Python detect_risks", () => {
	const REPO_ROOT = resolve(__dirname, "../../..");
	const CORPUS: { name: string; perms: NormalizedPermissions }[] = [
		{ name: "empty", perms: emptyPerms() },
		{
			name: "unbounded-bash",
			perms: {
				...emptyPerms(),
				allow: [{ pattern: "Bash(*)", kind: "allow" }],
			},
		},
		{
			name: "unbounded-write-and-edit",
			perms: {
				...emptyPerms(),
				allow: [
					{ pattern: "Write(*)", kind: "allow" },
					{ pattern: "Edit(*)", kind: "allow" },
				],
			},
		},
		{
			name: "fetch-warning",
			perms: {
				...emptyPerms(),
				allow: [{ pattern: "WebFetch(*)", kind: "allow" }],
			},
		},
		{
			name: "codex-combo",
			perms: {
				...emptyPerms(),
				approval_policy: "never",
				sandbox_mode: "danger-full-access",
			},
		},
		{
			name: "hook-sudo",
			perms: {
				...emptyPerms(),
				hooks: [
					{
						event: "PreToolUse",
						matcher: "Bash",
						command: "sudo systemctl restart x",
					},
				],
			},
		},
	];

	it("each fixture produces the same findings the Python evaluator would", () => {
		for (const { name, perms } of CORPUS) {
			const ts = detectRisks(perms, SCHEMA).map(
				({ code, severity, detail }) => ({ code, severity, detail }),
			);
			// Run the Python evaluator on the same perms via a tiny inline script.
			const json = JSON.stringify(perms);
			const py = execFileSync(
				"python3",
				[
					"-c",
					`import json, sys
import permissions, risks
data = json.loads(sys.argv[1])
perms = permissions.NormalizedPermissions.from_block(data)
findings = risks.detect_risks(perms)
print(json.dumps([
    {"code": f.code, "severity": f.severity, "detail": f.detail}
    for f in findings
]))
`,
					json,
				],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);
			const pyFindings = JSON.parse(py);
			expect({ [name]: ts }).toEqual({ [name]: pyFindings });
		}
	});
});
