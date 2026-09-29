// Pure TS command-decision evaluator that mirrors Python's
// permission_adapters.evaluate_decision (Claude-family semantics). Given a
// NormalizedPermissions block and a concrete command string, it predicts the
// runtime verdict — "allow" | "ask" | "deny" — by picking the most specific
// matching Bash rule (deny > ask > allow on a specificity tie). This is the
// "test a command" simulator's engine. Only Bash rules are modelled (the
// backend simulator is Bash-only too); non-Bash patterns never match.

import { bashPrefixTokens, type Capabilities, type NormalizedPermissions, type Rule, type RuleKind } from "@/types/permissions";
import { ruleAppliesToHarness } from "@/lib/permissionHarnessFilter";

const BASH_PATTERN_RE = /^Bash\(.*\)$/;

// deny beats ask beats allow when two rules match at the same specificity.
const KIND_RANK: Record<RuleKind, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Match specificity of `pattern` against the already-tokenized command.
 * Returns the number of prefix tokens matched (0 = matches any command via a
 * `Bash(*)`-style wildcard), or `null` if the pattern does not match / is not
 * a Bash pattern this simulator can model.
 *
 * NOTE the `bashPrefixTokens` quirk: it returns `null` for BOTH non-Bash
 * patterns AND unbounded `Bash(*)`. We disambiguate via `BASH_PATTERN_RE`: a
 * null result on a Bash-shaped pattern means "unbounded" (specificity 0); a
 * null on a non-Bash pattern means "skip".
 */
function matchSpecificity(pattern: string, cmdTokens: string[]): number | null {
	const isBash = BASH_PATTERN_RE.test(pattern.trim());
	if (!isBash) return null; // simulator only models Bash
	const tokens = bashPrefixTokens(pattern);
	if (tokens === null) return 0; // Bash(*) / Bash() — matches any command
	if (tokens.length > cmdTokens.length) return null;
	for (let i = 0; i < tokens.length; i++) {
		if (cmdTokens[i] !== tokens[i]) return null;
	}
	return tokens.length;
}

/**
 * Shared scoring core: pick the verdict for a concrete command over a set of
 * (allow / ask / deny) rule lists. Most-specific Bash-prefix match wins; ties
 * are broken deny>ask>allow. No matching rule ⇒ "ask" (the implicit prompt).
 *
 * Both `evaluateDecision` (full draft) and `evaluateDecisionForHarness`
 * (applicability-filtered per harness) funnel through this so the scoring logic
 * lives in exactly one place.
 *
 * NOTE: subtle real-world eval-ORDER differences across harnesses (Claude's
 * first-match, opencode's last-match-wins, Codex's most-restrictive Starlark
 * resolution) are intentionally *approximated* by this single deny-first /
 * most-specific model. The modeled cross-harness differentiator is rule
 * APPLICABILITY — which rules a harness can even express — not eval order.
 */
function scoreDecision(
	allow: readonly Rule[],
	ask: readonly Rule[],
	deny: readonly Rule[],
	command: string,
): RuleKind {
	const cmdTokens = command.trim().split(/\s+/).filter(Boolean);
	let best: { spec: number; rank: number; kind: RuleKind } | null = null;
	const consider = (rule: Rule, kind: RuleKind) => {
		const spec = matchSpecificity(rule.pattern, cmdTokens);
		if (spec === null) return;
		const rank = KIND_RANK[kind];
		if (
			best === null ||
			spec > best.spec ||
			(spec === best.spec && rank > best.rank)
		) {
			best = { spec, rank, kind };
		}
	};
	for (const r of allow) consider(r, "allow");
	for (const r of ask) consider(r, "ask");
	for (const r of deny) consider(r, "deny");
	return best === null ? "ask" : (best as { kind: RuleKind }).kind;
}

/**
 * Predict the harness verdict for a concrete command under `perms`. Mirrors the
 * Claude-family resolution: most-specific match wins, ties broken deny>ask>allow.
 * No matching rule anywhere ⇒ "ask" (the implicit harness prompt).
 */
export function evaluateDecision(
	perms: NormalizedPermissions,
	command: string,
): RuleKind {
	return scoreDecision(perms.allow, perms.ask, perms.deny, command);
}

/**
 * Per-harness verdict: keep only the rules that `ruleAppliesToHarness` accepts
 * for `harnessId` (capability + Bash-only caveat + affinity), then run the SAME
 * scoring as `evaluateDecision` over the surviving set.
 *
 * Why this differs across harnesses: a deny/path rule a Bash-only harness can't
 * express simply isn't in its rule set, so it drops out of the scoring — which
 * can flip the verdict relative to a harness that *can* express it. Eval-order
 * nuances are approximated (see `scoreDecision`); applicability is the modeled
 * differentiator.
 */
export function evaluateDecisionForHarness(
	perms: NormalizedPermissions,
	command: string,
	harnessId: string,
	capabilities: Capabilities,
): RuleKind {
	const keep = (r: Rule) => ruleAppliesToHarness(r, harnessId, capabilities);
	return scoreDecision(
		perms.allow.filter(keep),
		perms.ask.filter(keep),
		perms.deny.filter(keep),
		command,
	);
}
