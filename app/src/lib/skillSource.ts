import type { Registry, Skill, SourceView } from "@/types";

/** Built-in source views surfaced even when no Git source is configured. */
export const BUILTIN_LOCAL: SourceView = {
  id: "local",
  type: "local",
  name: "Local",
  builtin: true,
  status: "local",
};

export const BUILTIN_STARTER: SourceView = {
  id: "starter",
  type: "starter",
  name: "Starter Pack",
  builtin: true,
  status: "bundled",
};

/** Heuristic for inferring starter-pack ownership when a skill carries no
 *  ownership metadata. The Python side checks ``code_home()/skills/`` paths;
 *  the UI uses a string-match against ``hub_path`` plus a starter folder name
 *  fallback. Anything else is treated as local. */
const STARTER_PATH_SIGNALS = ["/Resources/hub/skills/", "/code-home/skills/"];

/** Resolve which source owns a skill. Mirrors hub.py ``infer_skill_ownership``.
 *  Returns the SOURCE id, not the full view; pair with ``getSourceView``. */
export function inferSkillSourceId(skill: Skill | undefined): string {
  if (!skill) return "local";
  if (skill.managed === "starter") return "starter";
  if (skill.managed === "local") return "local";
  if (skill.managed === "external") {
    return skill.origin?.source ?? "unknown";
  }
  const src = skill.source ?? "";
  if (STARTER_PATH_SIGNALS.some((sig) => src.includes(sig))) return "starter";
  return "local";
}

/** Stable accent color per source id. Uses CSS custom-property names where
 *  available (built-ins) and derives a hue from a quick FNV-style hash so
 *  externally added sources keep a consistent color across renders. */
export function sourceAccent(sourceId: string): string {
  if (sourceId === "local") return "var(--violet)";
  if (sourceId === "starter") return "var(--amber)";
  if (sourceId === "unknown") return "var(--fg-mute)";
  let hash = 2166136261;
  for (let i = 0; i < sourceId.length; i++) {
    hash ^= sourceId.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

/** Build the full ordered list of SourceViews — built-ins first, then sources
 *  declared in the registry. Skill counts are derived from the registry so the
 *  UI can render Library chips without a separate ``hub source list`` call. */
export function deriveSources(registry: Registry | undefined): SourceView[] {
  if (!registry) return [BUILTIN_LOCAL, BUILTIN_STARTER];

  const counts: Record<string, number> = {};
  for (const [, skill] of Object.entries(registry.skills ?? {})) {
    const sid = inferSkillSourceId(skill);
    counts[sid] = (counts[sid] ?? 0) + 1;
  }

  const out: SourceView[] = [
    { ...BUILTIN_LOCAL, skill_count: counts.local ?? 0 },
    { ...BUILTIN_STARTER, skill_count: counts.starter ?? 0 },
  ];

  for (const [id, cfg] of Object.entries(registry.sources ?? {})) {
    if (cfg.type === "git") {
      out.push({
        id,
        type: "git",
        name: cfg.name ?? id,
        builtin: false,
        status: cfg.status ?? "unknown",
        skill_count: counts[id] ?? 0,
        url: cfg.url,
        branch: cfg.branch ?? null,
        path: cfg.path,
        current_ref: cfg.current_ref ?? null,
        remote_ref: cfg.remote_ref ?? null,
        last_checked_at: cfg.last_checked_at ?? null,
        last_synced_at: cfg.last_synced_at ?? null,
        error: cfg.error ?? null,
      });
    } else if (cfg.type === "litellm") {
      out.push({
        id,
        type: "litellm",
        name: cfg.name ?? id,
        builtin: false,
        status: cfg.status ?? "unknown",
        skill_count: counts[id] ?? 0,
      });
    }
  }
  return out;
}

/** Look up a source view by id, falling back to a synthetic Local view so
 *  callers always get a renderable chip even mid-recompose. */
export function getSourceView(
  sourceId: string,
  sources: SourceView[] | undefined,
): SourceView {
  if (sources) {
    const found = sources.find((s) => s.id === sourceId);
    if (found) return found;
  }
  if (sourceId === "local") return BUILTIN_LOCAL;
  if (sourceId === "starter") return BUILTIN_STARTER;
  return {
    id: sourceId,
    type: "git",
    name: sourceId,
    builtin: false,
    status: "unknown",
  };
}

/** Convenience: source view for a given skill name in this registry. */
export function sourceForSkill(
  skillName: string,
  registry: Registry | undefined,
): SourceView {
  const sources = deriveSources(registry);
  const skill = registry?.skills?.[skillName];
  return getSourceView(inferSkillSourceId(skill), sources);
}

export function isExternalManaged(skill: Skill | undefined): boolean {
  if (!skill) return false;
  if (skill.managed === "external") return true;
  if (skill.managed === "starter") return true;
  return false;
}
