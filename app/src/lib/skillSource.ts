import type { Registry, Skill, SourceView } from "@/types";

/** Built-in source views surfaced even when no Git source is configured. */
export const BUILTIN_LOCAL: SourceView = {
  id: "local",
  type: "local",
  name: "Local",
  builtin: true,
  status: "local",
  enabled: true,
};

export const BUILTIN_STARTER: SourceView = {
  id: "starter",
  type: "starter",
  name: "Starter Pack",
  builtin: true,
  status: "bundled",
  enabled: true,
};

/** R1: a source chip is a DEVIATION — local + starter are the silent default,
 *  so only a synced/imported source (git, litellm) earns a chip. The single
 *  definition; `SourceChip` imports it rather than re-deriving the check. */
export function isExternalSource(s: Pick<SourceView, "type">): boolean {
  return s.type === "git" || s.type === "litellm";
}

/** A source syncs unless it was explicitly disabled. The flag is absent on
 *  built-ins and on registries written before `hub source disable` existed. */
export function isSourceEnabled(source: Pick<SourceView, "enabled">): boolean {
  return source.enabled !== false;
}

/** Names of every registry skill owned by `sourceId`, in registry order. */
export function skillNamesForSource(
  registry: Registry | undefined,
  sourceId: string,
): string[] {
  return Object.entries(registry?.skills ?? {})
    .filter(([, skill]) => inferSkillSourceId(skill) === sourceId)
    .map(([name]) => name);
}

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

// ---------------------------------------------------------------------------
// Source identity accent
// ---------------------------------------------------------------------------
// A source's color is IDENTITY, never status or provenance (COMPONENTS.md
// §Accents: "identity = shape/logo/emoji + the muted --id-* ramp"). So it draws
// from the same low-chroma ramp bundles use (components/bundleColors.ts) and
// may never resolve to a semantic accent (--violet/--amber/--green/…), which
// would collide with the status vocabulary the Sources screen paints on badges.

const ID_RAMP_SIZE = 8;

/** Fixed ramp slots for the two built-ins, so `local` and `starter` keep one
 *  stable, mutually distinct identity instead of hashing into the same slot. */
const BUILTIN_ID_SLOT: Record<string, number> = { local: 4, starter: 1 };

/** djb2 — same stable string hash bundleColors.ts uses, so both identity
 *  channels distribute across the ramp the same way. */
function rampHash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = (h * 33) ^ name.charCodeAt(i);
  }
  return h >>> 0;
}

/** Stable identity-ramp token per source id (`var(--id-0)` … `var(--id-7)`).
 *  The `unknown` sentinel is not an identity — it stays neutral. */
export function sourceAccent(sourceId: string): string {
  if (sourceId === "unknown") return "var(--fg-mute)";
  const fixed = BUILTIN_ID_SLOT[sourceId];
  const slot = fixed ?? rampHash(sourceId) % ID_RAMP_SIZE;
  return `var(--id-${slot})`;
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
    { ...BUILTIN_LOCAL, skill_count: counts.local ?? 0, enabled: true },
    { ...BUILTIN_STARTER, skill_count: counts.starter ?? 0, enabled: true },
  ];

  for (const [id, cfg] of Object.entries(registry.sources ?? {})) {
    if (cfg.type === "git") {
      out.push({
        id,
        type: "git",
        name: cfg.name ?? id,
        builtin: false,
        // Absent `enabled:` means enabled — see GitSourceConfig.enabled.
        enabled: cfg.enabled ?? true,
        status: cfg.status ?? "unknown",
        skill_count: counts[id] ?? 0,
        url: cfg.url,
        branch: cfg.branch ?? null,
        path: cfg.path,
        // Absent means "follow upstream fully" — keep it absent, never [].
        ...(cfg.include ? { include: cfg.include } : {}),
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
        enabled: cfg.enabled ?? true,
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
    enabled: true,
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

/** What a pasted repository URL actually names. A GitHub "deep link" carries
 *  three things at once — the repo, the branch, and the directory you were
 *  looking at — so the wizard can honor what you pasted instead of silently
 *  registering the whole repo. Mirrors hub.py ``parse_git_url``. */
export interface ParsedGitSourceUrl {
  /** Clone-able repo URL: any `/tree|/blob/<ref>/<path>` suffix removed. */
  cloneUrl: string;
  /** Branch/ref named by a `/tree|/blob/` URL, when present. */
  branch?: string;
  /** Repo-relative directory named by the URL — no leading/trailing slash, a
   *  trailing `SKILL.md` filename dropped (a `/blob/` link points AT a file;
   *  the scan base is the directory that holds it). */
  subpath?: string;
}

/** `https://host/owner/repo[.git]/tree|blob/<rest>` — non-greedy on the repo
 *  segment so `<rest>` keeps the whole ref + path tail. */
const DEEP_URL_RE =
  /^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/(?:tree|blob)\/(.+)$/i;

export function parseGitSourceUrl(url: string): ParsedGitSourceUrl {
  const raw = (url ?? "").trim();
  if (!raw) return { cloneUrl: "" };
  const m = raw.match(DEEP_URL_RE);
  if (!m) return { cloneUrl: raw.replace(/\/+$/, "") };
  const segments = m[2].split("/").filter(Boolean);
  const branch = segments.shift() ?? "";
  if (segments.length && segments[segments.length - 1].toLowerCase() === "skill.md") {
    segments.pop();
  }
  const subpath = segments.join("/");
  return {
    cloneUrl: m[1],
    ...(branch ? { branch } : {}),
    ...(subpath ? { subpath } : {}),
  };
}

/** Lowercase hyphen slug — the shape ``SLUG_RE`` accepts. */
function slugifySourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Best-effort live mirror of ``hub.py`` ``derive_source_id_from_url``. Used only
 *  to pre-fill/preview the id field; the backend remains authoritative. Handles
 *  the common SSH (`git@host:owner/repo.git`), HTTPS, and GitHub
 *  `tree|blob/<branch>` forms; returns "" for an empty/unparseable URL so the
 *  caller can hold off. */
export function deriveSourceIdFromUrl(url: string): string {
  let base = parseGitSourceUrl(url).cloneUrl;
  if (!base) return "";
  if (base.toLowerCase().endsWith(".git")) base = base.slice(0, -4);
  // Last path segment, then last `:`-segment (SSH `git@host:owner/repo`).
  let name = base.split("/").pop() ?? "";
  name = name.split(":").pop() ?? "";
  return slugifySourceName(name);
}

/** Id to pre-fill for a pasted URL. A deep link names ONE directory, so the
 *  source is that thing ("unslop"), not the monorepo it happens to live in
 *  ("plugins") — what you pasted is what you get. Falls back to the repo name
 *  when the URL names no subpath. */
export function suggestSourceIdForUrl(url: string): string {
  const { subpath } = parseGitSourceUrl(url);
  if (subpath) {
    const last = subpath.split("/").filter(Boolean).pop() ?? "";
    const slug = slugifySourceName(last);
    if (slug) return slug;
  }
  return deriveSourceIdFromUrl(url);
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
