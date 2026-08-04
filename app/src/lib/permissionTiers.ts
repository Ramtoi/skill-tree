// Risk-tier taxonomy for permission rules. Groups `Bash(<cmd>:*)` rules by the
// danger profile of their leading command so the editor can present rules by
// "what can it break?" instead of an alphabetical wall of Bash().
//
// The taxonomy is intentionally small and data-driven: each command maps to a
// tier by its first token. Non-Bash tools and unclassified commands fall into
// `other`. The classifier is the single source of truth — the editor's tier
// grouping and the tests both read from here.
//
// Design note (color = meaning): tiers map to the app's semantic accents —
//   read    → --green  (safe to run, observes only)
//   build   → --amber  (mutates the project / installs)
//   network → --red    (network egress or destructive)
//   other   → neutral  (non-Bash or unrecognized)

import { bashPrefixTokens } from "@/types/permissions";

export type PermissionTier = "read" | "build" | "network" | "other";

export interface TierMeta {
	key: PermissionTier;
	label: string;
	caption: string;
	accent: string;
}

/** Display metadata per tier, in render order (lowest → highest risk → other). */
export const TIER_META: Record<PermissionTier, TierMeta> = {
	read: {
		key: "read",
		label: "Read & inspect",
		caption: "low risk",
		accent: "var(--green)",
	},
	build: {
		key: "build",
		label: "Build & package",
		caption: "mutates project",
		accent: "var(--amber)",
	},
	network: {
		key: "network",
		label: "Network & destructive",
		caption: "review carefully",
		accent: "var(--red)",
	},
	other: {
		key: "other",
		label: "Other",
		caption: "non-Bash or unclassified",
		accent: "var(--fg-mute)",
	},
};

/** The fixed render order for tier groups. */
export const TIER_ORDER: PermissionTier[] = [
	"read",
	"build",
	"network",
	"other",
];

// Single-token commands.
const READ_CMDS = new Set([
	"ls",
	"cat",
	"grep",
	"find",
	"echo",
	"cd",
	"pwd",
	"head",
	"tail",
	"wc",
	"which",
	"env",
]);

const BUILD_CMDS = new Set([
	// Bare `git` (status/add/commit/diff) mutates the project locally; the
	// riskier `git push` (network egress) is escalated via MULTI_TOKEN below.
	"git",
	"npm",
	"npx",
	"node",
	"pnpm",
	"yarn",
	"pip",
	"python",
	"python3",
	"pytest",
	"cargo",
	"go",
	"make",
	"gradle",
	"./gradlew",
	"mvn",
	"tsc",
	"vite",
]);

const NETWORK_CMDS = new Set([
	"rm",
	"curl",
	"wget",
	"ssh",
	"scp",
	"sudo",
	"kill",
	"dd",
	"docker",
]);

// Multi-token prefixes (matched against the joined first N tokens).
const MULTI_TOKEN: { tokens: string[]; tier: PermissionTier }[] = [
	{ tokens: ["git", "push"], tier: "network" },
];

/**
 * Classify a rule into a risk tier by its leading Bash command.
 *
 * Returns `other` for any non-Bash tool (`Read(...)`, `WebFetch(...)`, …),
 * an unbounded `Bash(*)`, or an unrecognized command.
 */
export function classifyTier(pattern: string): PermissionTier {
	const tokens = bashPrefixTokens(pattern);
	if (tokens === null || tokens.length === 0) return "other";

	// Multi-token prefixes win over the single-token map (e.g. "git push").
	for (const m of MULTI_TOKEN) {
		if (
			m.tokens.length <= tokens.length &&
			m.tokens.every((t, i) => tokens[i] === t)
		) {
			return m.tier;
		}
	}

	// The part before a `:` is always the command name (the `:` separates the
	// command from its arg-pattern), so `Bash(npm:test)` classifies by `npm`.
	const head = tokens[0].split(":")[0];
	if (READ_CMDS.has(head)) return "read";
	if (BUILD_CMDS.has(head)) return "build";
	if (NETWORK_CMDS.has(head)) return "network";
	return "other";
}
