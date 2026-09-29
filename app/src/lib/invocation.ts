// ─── Invocation (Triggering) axis — shared vocabulary + copy ─────────────────
// The invocation axis (design D1/D7) is a sync-time mirror of the SKILL.md
// frontmatter flags Claude Code reads. `auto` (default) = absent key; the three
// deviations are surfaced as badges + pickers. Copy lives here so the editor
// picker, the workspace override control, and the badge all speak with one
// voice.

/** Settable modes. `auto` clears both frontmatter flags. */
export type InvocationMode = "auto" | "user-only" | "model-only";
export type InvocationSettled = "synced" | "saved" | null;

/** Registry mirror values. `conflicted` is a read-only derived state (both
 *  frontmatter flags set by hand); absence means `auto`. */
export type InvocationValue = "user-only" | "model-only" | "conflicted";

/** A per-project override choice — the settable modes plus `inherit` (clears). */
export type OverrideChoice = InvocationMode | "inherit";

/** Short human labels for the settable modes. */
export const INVOCATION_LABEL: Record<InvocationMode, string> = {
  auto: "Auto",
  "user-only": "User-only",
  "model-only": "Model-only",
};

/** One-line consequence per settable mode (design D7 / Context table). */
export const INVOCATION_CONSEQUENCE: Record<InvocationMode, string> = {
  auto: "Use each harness's normal invocation behavior. See the results below.",
  "user-only": "Require explicit invocation where supported. See any limits below.",
  "model-only": "Allow model invocation and hide manual entry points where supported.",
};

export const INVOCATION_HARNESS_HINT =
  "Harnesses chooses where Hub sends this skill. Triggering controls how each harness can invoke it.";

/** Why the library default is locked for external-source skills (D6). */
export const INVOCATION_EXTERNAL_REASON =
  "This source owns the library default. Use a project override where available.";

/** Why the library default is locked for MCP servers (frontmatter contract
 *  does not apply). */
export const INVOCATION_MCP_REASON =
  "Triggering applies only to skills — MCP servers don't use the invocation frontmatter flags.";

/** Why a per-project override is refused for `scope: global` skills (D4). */
export const INVOCATION_GLOBAL_OVERRIDE_REASON =
  "Global skills use the library default. Project overrides are unavailable for this scope.";

/** Warn copy for the derived `conflicted` state. */
export const INVOCATION_CONFLICTED_TOOLTIP =
  "The library has conflicting invocation flags. Pick a mode to repair them.";

/** Effective *library* mode: the registry mirror collapsed to a settable mode.
 *  Absent / unknown / `conflicted` all read as their own value — callers that
 *  only care about the settable default use this to fold `conflicted`/absent to
 *  `auto`. */
export function effectiveLibraryMode(invocation?: string): InvocationMode {
  return invocation === "user-only" || invocation === "model-only"
    ? invocation
    : "auto";
}

/** True when the registry mirror is the hand-authored contradiction. */
export function isConflicted(invocation?: string): boolean {
  return invocation === "conflicted";
}


export interface InvocationOutcome {
  skill: string;
  harness: string;
  project?: string | null;
  requested_mode: string;
  mode_origin: string;
  capability_profile: string;
  support: "enforced" | "native" | "unsupported" | "unknown";
	implicit_behavior: InvocationBehavior;
	explicit_behavior: InvocationBehavior;
  mechanism: string;
  limitations: string[];
  delivery: "pending" | "applied" | "unchanged" | "failed" | "not-targeted";
  reason_code?: string | null;
  reason?: string;
  input_fingerprint?: string;
  observed_at?: string;
  applied_mode?: string;
}

export interface InvocationStatus {
  ok: boolean;
  skill: string;
  project?: string | null;
  library: string;
  override?: InvocationMode | null;
  effective: string;
  targets: string[];
  outcomes: InvocationOutcome[];
  previews: Record<InvocationMode, InvocationOutcome[]>;
	overridden_projects: string[];
}

export type InvocationBehavior = "enabled" | "disabled" | "available" | "hidden" | "unknown";

/** Human-facing status for a resolver row. Delivery state takes precedence over
 * capability support so a stale/failed write never reads as Enforced. */
export function invocationOutcomeLabel(
	outcome: InvocationOutcome,
	preview = false,
): { label: string; channel: "ok" | "info" | "warn" | "error" | "neutral" } {
	if (outcome.delivery === "failed") return { label: "Delivery failed", channel: "error" };
	if (outcome.delivery === "not-targeted") return { label: "Not sent", channel: "neutral" };
	if (outcome.support === "unsupported") return { label: "Unsupported", channel: "warn" };
	if (outcome.support === "unknown") return { label: "Not verified", channel: "neutral" };
	if (preview || outcome.delivery === "pending") return { label: "Will apply on sync", channel: "info" };
	if (outcome.support === "enforced") return { label: "Enforced", channel: "ok" };
	return { label: "Native behavior", channel: "info" };
}

/** Exact consequence wording shared by the editor and project override rows. */
export function invocationConsequence(outcome: InvocationOutcome, mode: InvocationMode): string {
	if (outcome.delivery === "failed" && outcome.reason) return outcome.reason;
	if (outcome.support === "unknown") {
		if (outcome.harness === "opencode") {
			return "Invocation support could not be verified for this opencode build. The selected restriction is not guaranteed.";
		}
		const harness = outcome.harness === "claude-code" ? "Claude Code" : outcome.harness[0]?.toUpperCase() + outcome.harness.slice(1);
		return `Invocation support could not be verified for ${harness}. The selected restriction is not guaranteed.`;
	}
	const name = outcome.harness;
	if (name === "claude-code") {
		if (mode === "user-only") return `Run /${outcome.skill} yourself. Automatic loading and subagent preloading are disabled.`;
		if (mode === "model-only") return `Claude can load it. It is hidden from the / menu.`;
		return `You can run /${outcome.skill}; Claude can load it when relevant.`;
	}
	if (name === "codex") {
		if (mode === "user-only") return `Automatic invocation is disabled. Invoke it explicitly, for example with $${outcome.skill} in Codex CLI.`;
		if (mode === "model-only") return "Codex can use it automatically, but explicit invocation remains available. Codex has no verified Model-only setting.";
		if (outcome.implicit_behavior === "disabled") return "The source disables automatic invocation. Explicit invocation remains available; Auto preserves the source setting.";
		return "You can invoke this skill explicitly; Codex can also choose it automatically.";
	}
	if (name === "pi") {
		if (mode === "user-only") return `Hidden from Pi's automatic skill list. Run /skill:${outcome.skill} yourself.`;
		if (mode === "model-only") return `Pi can discover it, but /skill:${outcome.skill} remains available. This restriction is unsupported.`;
		return `Pi can discover it; you can run /skill:${outcome.skill}.`;
	}
	if (name === "opencode") {
		if (outcome.mechanism === "opencode command-only delivery") return `Run /${outcome.skill} yourself. Hub delivers a command without registering a model skill.`;
		if (outcome.capability_profile.includes("model-tool-only") || outcome.mechanism.includes("native model skill tool")) {
			if (mode === "model-only") return "The model loads this skill through opencode's native skill tool. No extra restriction is needed.";
			return "opencode loads skills through the model's skill tool. Hub adds no manual command.";
		}
		if (outcome.capability_profile.includes("v2")) {
			if (mode === "user-only") return "Hidden from the model's available skill list; its manual command remains available. Loading a known skill ID is still possible.";
			if (mode === "model-only") return "The model can discover this skill. Its manual command is hidden.";
			return "The model can discover this skill, and its manual command is available.";
		}
		if (mode === "user-only" && outcome.support === "unsupported" && outcome.reason_code === "command-eligibility-unverified") {
			return `/${outcome.skill} can run explicitly, but opencode can still discover the skill through another skill location. User-only cannot be enforced here.`;
		}
		if (mode === "model-only") return `Model loading is native. This version also exposes /${outcome.skill}; Hub cannot hide that entry point.`;
		if (mode === "user-only" && outcome.support === "unsupported" && outcome.limitations?.length) {
			return outcome.limitations[0];
		}
		return `The model can load this skill, and /${outcome.skill} is also available.`;
	}
	if (outcome.support === "unsupported" && outcome.limitations?.length) {
		return outcome.limitations[0];
	}
	return mode === "auto" ? "Use this harness's normal invocation behavior." : INVOCATION_CONSEQUENCE[mode];
}

/** Compact behavior derived from resolver evidence, never from intent alone. */
export function invocationSummary(outcome: InvocationOutcome, mode: InvocationMode): string {
	if (outcome.delivery === "not-targeted") return "Excluded by target selection";
	if (outcome.delivery === "failed") {
		const applied = INVOCATION_LABEL[outcome.applied_mode as InvocationMode];
		return applied ? `Still using ${applied}` : "Could not deliver this skill";
	}
	if (outcome.support === "unknown") return "Behavior not verified";
	if (outcome.support === "unsupported") {
		if (mode === "model-only" && outcome.explicit_behavior === "available") return "Manual invocation stays available";
		if (mode === "user-only" && outcome.implicit_behavior === "enabled") return "Automatic loading stays enabled";
		return "Restriction cannot be enforced";
	}
	if (outcome.implicit_behavior === "disabled" && outcome.explicit_behavior === "available") {
		return mode === "auto" ? "Manual only, set by source" : "Manual invocation only";
	}
	if (outcome.implicit_behavior === "enabled" && outcome.explicit_behavior === "hidden") return "Automatic loading only";
	if (outcome.implicit_behavior === "enabled" && outcome.explicit_behavior === "available") return "Automatic and manual invocation";
	return "Uses native invocation behavior";
}
