// Skill descriptions hit three real ceilings, in this order. Feedback derived
// here is passive — it explains what a length costs, it never blocks a save.

/** Mirrors DESCRIPTION_MAX in cloud_targets.py — keep in sync by hand. */
export const CLOUD_DESCRIPTION_MAX = 200;
/** Claude Code truncates each description at this length when deciding whether
 *  to auto-trigger a skill.
 *  Source: Claude Code v2.1.86 changelog / anthropics/claude-code#40121. */
export const TRIGGER_TRUNCATION_CAP = 250;
/** Agent Skills spec hard limit — Codex refuses to load a longer description.
 *  Source: agentskills.io spec, enforced per openai/codex#13941. */
export const SPEC_DESCRIPTION_MAX = 1024;

export type DescriptionTier = "ok" | "cloud" | "truncate" | "spec";

export interface DescriptionLengthState {
  tier: DescriptionTier;
  note: string | null;
}

export function descriptionLengthState(length: number): DescriptionLengthState {
  if (length > SPEC_DESCRIPTION_MAX) {
    return {
      tier: "spec",
      note: `Exceeds the Agent Skills spec limit of ${SPEC_DESCRIPTION_MAX}. Codex refuses to load it.`,
    };
  }
  if (length > TRIGGER_TRUNCATION_CAP) {
    return {
      tier: "truncate",
      note: `Claude Code truncates at ${TRIGGER_TRUNCATION_CAP} when deciding to trigger; claude.ai caps at ${CLOUD_DESCRIPTION_MAX}.`,
    };
  }
  if (length > CLOUD_DESCRIPTION_MAX) {
    return {
      tier: "cloud",
      note: `Over claude.ai's ${CLOUD_DESCRIPTION_MAX}-char limit.`,
    };
  }
  return { tier: "ok", note: null };
}
