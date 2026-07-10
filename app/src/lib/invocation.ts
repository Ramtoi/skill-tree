// ─── Invocation (Triggering) axis — shared vocabulary + copy ─────────────────
// The invocation axis (design D1/D7) is a sync-time mirror of the SKILL.md
// frontmatter flags Claude Code reads. `auto` (default) = absent key; the three
// deviations are surfaced as badges + pickers. Copy lives here so the editor
// picker, the workspace override control, and the badge all speak with one
// voice.

/** Settable modes. `auto` clears both frontmatter flags. */
export type InvocationMode = "auto" | "user-only" | "model-only";

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
  auto: "You can run /name; Claude sees the description and can trigger it.",
  "user-only":
    "Only you can run it via /name; Claude doesn't see it — saves context. Also skipped for subagent preloading.",
  "model-only": "Claude can use it; hidden from your / menu.",
};

/** Harness-portability hint shown next to any triggering control. */
export const INVOCATION_HARNESS_HINT =
  "Claude-compatible harnesses honor this; Codex/opencode ignore it.";

/** Why the library default is locked for external-source skills (D6). */
export const INVOCATION_EXTERNAL_REASON =
  "This skill is owned by an external source, so its frontmatter is read-only. Use a per-project override to change triggering here instead.";

/** Why the library default is locked for MCP servers (frontmatter contract
 *  does not apply). */
export const INVOCATION_MCP_REASON =
  "Triggering applies only to skills — MCP servers don't use the invocation frontmatter flags.";

/** Why a per-project override is refused for `scope: global` skills (D4). */
export const INVOCATION_GLOBAL_OVERRIDE_REASON =
  "User-level skills take precedence over project-level in Claude Code; change the library default instead.";

/** Warn copy for the derived `conflicted` state. */
export const INVOCATION_CONFLICTED_TOOLTIP =
  "Both invocation flags are set in the frontmatter — a contradiction (Claude can't see it and it's hidden from your / menu). Pick any triggering mode to repair it.";

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
