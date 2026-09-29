// ─── Section registry (rail destination ↔ route ↔ panel contents) ────────────
// ONE table for "which section am I in". The IconRail picks the section, the
// `data-section` chrome hue names it, and the NavPanel renders that section's
// CONTENTS (see COMPONENTS.md §Navigator).
//
// This lives in `lib/` rather than `App.tsx` on purpose: App.tsx imports all 18
// screens, so exporting from there would drag the whole screen graph into every
// consumer (and give NavPanel → App → NavPanel a cycle).

import { readBackTarget } from "./backTarget";

export const SECTION_IDS = [
  "library",
  "projects",
  "snippets",
  "hooks",
  "harnesses",
  "permissions",
  "remotes",
  "sources",
  "usage",
  "backup",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/** Route → section. Every path resolves; unknown paths belong to Library
 *  (which is where the router's wildcard sends them too). A caller may pass a
 *  full location string (e.g. a referrer's `?focus=x` deep link) — strip the
 *  query/hash first so it matches on the path alone. */
export function sectionForPath(rawPath: string): SectionId {
  const path = rawPath.split(/[?#]/)[0];
  if (path.startsWith("/project/")) return "projects";
  if (path === "/sources" || path.startsWith("/sources/")) return "sources";
  if (path === "/snippets" || path.startsWith("/snippet/")) return "snippets";
  if (path === "/hooks" || path.startsWith("/hook/")) return "hooks";
  if (path === "/permissions") return "permissions";
  if (path === "/harnesses" || path.startsWith("/harness/")) return "harnesses";
  // Cloud apps live on the Remotes surface, so they share its chrome hue.
  if (path === "/remotes" || path.startsWith("/remote/")) return "remotes";
  if (path.startsWith("/cloud/")) return "remotes";
  if (path === "/usage" || path.startsWith("/usage/")) return "usage";
  if (path === "/backup") return "backup";
  // "/", "/skill/*", "/bundle/*" and any fallback all belong to Library.
  return "library";
}

/** Route + referrer → section. A detail route (`/skill/:name`, `/bundle/:name`)
 *  has no section of its own worth naming: the same skill is reached from the
 *  library, a project, a source and a remote. When the location carries a
 *  referrer (`lib/backTarget.ts`), the CHROME follows it — rail pill, section
 *  hue, panel contents — so the whole shell agrees with the back arrow about
 *  where you are. Without one it degrades to `sectionForPath`. */
export function sectionForLocation(pathname: string, state: unknown): SectionId {
  const from = readBackTarget(state);
  return sectionForPath(from ? from.path : pathname);
}

/** Which navigator row reads as "you are here".
 *
 *  The current route wins whenever the section can actually hold a row for it
 *  — a skill opened from a bundle still lights its own row in the Library's
 *  sibling list. Only when the current route cannot appear in this section
 *  (a skill under Projects) does the referrer stand in for it, so the project
 *  you came from stays lit while you work inside one of its skills. */
export function navAnchorPath(pathname: string, state: unknown): string {
  const section = sectionForLocation(pathname, state);
  if (sectionForPath(pathname) === section) return pathname;
  return readBackTarget(state)?.path ?? pathname;
}

export interface SectionMeta {
  /** Panel-header label (rendered uppercase mono, tinted `var(--section)`). */
  label: string;
  /** `icons.ts` key — the same glyph the rail uses for this destination. */
  icon: string;
}

export const SECTION_META: Record<SectionId, SectionMeta> = {
  library: { label: "Library", icon: "library" },
  projects: { label: "Projects", icon: "project" },
  snippets: { label: "Snippets", icon: "snippet" },
  hooks: { label: "Hooks", icon: "hook" },
  harnesses: { label: "Harnesses", icon: "harness" },
  permissions: { label: "Permissions", icon: "permissions" },
  remotes: { label: "Remotes", icon: "remote" },
  sources: { label: "Sources", icon: "source" },
  usage: { label: "Usage", icon: "usage" },
  backup: { label: "Backup", icon: "archive" },
};

// ─── Group layer (rail slot ↔ chrome hue) ────────────────────────────────────
// The rail groups its destinations by INTENT, not by artifact type, and the
// chrome hue keys off the GROUP: ten hues at chroma 0.06 read as one grey, five
// are actually tellable apart. Sections stay the layer underneath — one section
// still names exactly one surface, and routes are untouched.

export const GROUP_IDS = [
  "projects",
  "context",
  "guardrails",
  "agents",
  "elsewhere",
] as const;

export type GroupId = (typeof GROUP_IDS)[number];

/** Total by construction: a section with no group would silently fall back to
 *  the default hue, which is the class of bug `--sec-backup` closed (N19). */
export const GROUP_FOR_SECTION: Record<SectionId, GroupId> = {
  projects: "projects",
  library: "context",
  snippets: "context",
  permissions: "guardrails",
  hooks: "guardrails",
  harnesses: "agents",
  usage: "agents",
  sources: "elsewhere",
  remotes: "elsewhere",
  backup: "elsewhere",
};

/** Route + referrer → group. Referrer-aware for the same reason
 *  `sectionForLocation` is: a skill opened from a project keeps the Projects
 *  chrome while you work inside it. */
export function groupForLocation(pathname: string, state: unknown): GroupId {
  return GROUP_FOR_SECTION[sectionForLocation(pathname, state)];
}

/** The route's OWN group, ignoring any referrer — the CONTENT group. A detail
 *  screen shown in place (a skill inside a project, a bundle inside a source)
 *  can disagree with the CHROME group (`groupForLocation`, which follows the
 *  referrer): the rail/hue/navigator read as the surface you're working
 *  FROM, while the screen itself still belongs to its own section. Both
 *  numbers are real; the shell renders the difference instead of picking
 *  one and hiding the other. */
export function contentGroupForPath(pathname: string): GroupId {
  return GROUP_FOR_SECTION[sectionForPath(pathname)];
}

/** True when the chrome group and the content group disagree — the shell is
 *  showing one section's screen inside another section's surroundings. Drives
 *  `data-context-mix` on `.app`, which the header uses to blend a second hue
 *  in instead of hard-cutting from one section's color to another's. */
export function isContextMix(pathname: string, state: unknown): boolean {
  return groupForLocation(pathname, state) !== contentGroupForPath(pathname);
}

/** True when the current route is a detail screen opened IN PLACE inside a
 *  different section's context — a referrer exists AND it names a section
 *  other than the route's own. This is the SECTION-level (not group-level)
 *  check: two sections in the same group (e.g. library/snippets, both
 *  "context") still count once their sections differ, because the back arrow
 *  and crumb trail work in section identities, not the coarser chrome group.
 *  Drives `ScreenHeader`'s automatic back arrow — no referrer, or a referrer
 *  that only restates the route's own section, means there is nothing to
 *  "go back" to that the screen doesn't already show.
 *
 *  Today every call site that sets a referrer also crosses GROUPS (project →
 *  skill, source ↔ bundle), so `isContextMix` (group-level) is always true
 *  whenever `isInPlace` (section-level) is — the finer split exists but is
 *  unexercised. The gap it leaves room for — a referrer that crosses
 *  sections within the SAME group (library ↔ snippets, permissions ↔ hooks,
 *  harnesses ↔ usage, sources ↔ remotes ↔ backup) — has no call site yet. */
export function isInPlace(pathname: string, state: unknown): boolean {
  const from = readBackTarget(state);
  return !!from && sectionForPath(pathname) !== sectionForLocation(pathname, state);
}

export interface GroupMeta {
  /** Panel-header label (rendered uppercase mono, tinted `var(--section)`). */
  label: string;
  /** `icons.ts` key — the glyph of the group's primary destination. */
  icon: string;
}

export const GROUP_META: Record<GroupId, GroupMeta> = {
  projects: { label: "Projects", icon: "project" },
  context: { label: "Context", icon: "library" },
  guardrails: { label: "Guardrails", icon: "permissions" },
  agents: { label: "Agents", icon: "harness" },
  elsewhere: { label: "Elsewhere", icon: "remote" },
};
