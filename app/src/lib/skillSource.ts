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

// ---------------------------------------------------------------------------
// Source-id derivation & collision helpers (mirror hub.py)
// ---------------------------------------------------------------------------

/** Ids owned by the built-in sources; a git source may never reuse them.
 *  Mirrors ``hub.py`` ``BUILT_IN_SOURCE_IDS``. */
export const RESERVED_SOURCE_IDS: ReadonlySet<string> = new Set(["local", "starter"]);

/** Slug shape accepted by ``hub.py`` ``SLUG_RE`` (`^[a-z0-9-]+$`). */
const SOURCE_SLUG_RE = /^[a-z0-9-]+$/;

export function isValidSourceId(id: string): boolean {
  return SOURCE_SLUG_RE.test(id);
}

/** Best-effort live mirror of ``hub.py`` ``derive_source_id_from_url``. Used only
 *  to pre-fill/preview the id field; the backend remains authoritative. Handles
 *  the common SSH (`git@host:owner/repo.git`), HTTPS, and GitHub `tree/<branch>`
 *  forms; returns "" for an empty/unparseable URL so the caller can hold off. */
export function deriveSourceIdFromUrl(url: string): string {
  let base = (url ?? "").trim();
  if (!base) return "";
  // Strip a GitHub-style `/tree/<branch>[/<path>]` suffix off an HTTPS url.
  const tree = base.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/tree\/.+$/);
  if (tree) base = tree[1];
  base = base.replace(/\/+$/, "");
  if (base.toLowerCase().endsWith(".git")) base = base.slice(0, -4);
  // Last path segment, then last `:`-segment (SSH `git@host:owner/repo`).
  let name = base.split("/").pop() ?? "";
  name = name.split(":").pop() ?? "";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/** The set of source ids already in use (reserved built-ins ∪ configured
 *  sources). A git source-add collides with any member of this set. */
export function takenSourceIds(registry: Registry | undefined): Set<string> {
  const taken = new Set<string>(RESERVED_SOURCE_IDS);
  for (const id of Object.keys(registry?.sources ?? {})) taken.add(id);
  return taken;
}

/** Return ``base`` if free, else the first free ``base-2`` / ``base-3`` … so the
 *  id field can pre-fill a value that actually applies. */
export function suggestFreeSourceId(base: string, taken: ReadonlySet<string>): string {
  if (!base) return base;
  // Unbounded like the backend allocator — `taken` is finite so this always
  // terminates on a free `base-n`; never fall back to the colliding base.
  let n = 2;
  let cand = base;
  while (taken.has(cand)) {
    cand = `${base}-${n}`;
    n++;
  }
  return cand;
}

/** Why a source id can't be used, or null when it's usable. */
export function sourceIdError(
  id: string,
  taken: ReadonlySet<string>,
): "invalid" | "reserved" | "taken" | null {
  if (!id) return null;
  if (!isValidSourceId(id)) return "invalid";
  if (RESERVED_SOURCE_IDS.has(id)) return "reserved";
  if (taken.has(id)) return "taken";
  return null;
}
