import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useAppStore } from "@/store";
import { Icon } from "@/components/Icon";
import { Kbd } from "@/components/Kbd";
import { resolvableRecent } from "@/lib/recentResolve";
import {
  GROUP_META,
  navAnchorPath,
  groupForLocation,
  type SectionId,
  type GroupId,
} from "@/lib/sections";
import { useSideNav } from "@/hooks/useSideNav";
import {
  PIN_KINDS,
  FILTER_THRESHOLD,
  useSideSearch,
  pinKey,
  type NavBodyProps,
  type NavHeadInfo,
  type PinKind,
} from "@/components/nav/SidePrimitives";
import {
  ProjectsGlance,
  ProjectsRows,
  projectsHead,
} from "@/components/nav/ProjectsBody";
import {
  ContextGlance,
  ContextRows,
  contextHead,
} from "@/components/nav/ContextBody";
import {
  GuardrailsGlance,
  GuardrailsRows,
  guardrailsHead,
} from "@/components/nav/GuardrailsBody";
import {
  AgentsGlance,
  AgentsRows,
  agentsHead,
} from "@/components/nav/AgentsBody";
import {
  ElsewhereGlance,
  ElsewhereRows,
  elsewhereHead,
} from "@/components/nav/ElsewhereBody";
import type { RecentItem, RecentType } from "@/types";

// ─── Contract ────────────────────────────────────────────────────────────────
// The 56px IconRail picks the GROUP (five intent clusters over the ten
// sections — see lib/sections.ts); this 240px panel is a CONTEXTUAL DASHBOARD
// for that group: a glance layer (attention plaque + two steady tiles, always
// visible, does not scroll) above a navigator (the existing row list, now with
// per-item marks and an expanding detail block on the active row). See
// DESIGN-NAV-DASHBOARD/NAV-DASHBOARD-SPEC.md — this file keeps persistence,
// migration, pins/collapse state, the head, glance-layer mounting, roving
// keyboard nav (`useSideNav`), the Recent strip and the footer; everything
// group-specific lives in one `components/nav/*Body.tsx` module per group.
//
// ENUMERATION RULE: a section gets list rows ONLY where every row navigates to
// a real route. Sections whose screen IS the list (Sources, Permissions,
// Usage, Backup) get a compact info block instead — no dead rows. Snippets now
// has a real per-item route (`/snippet/:name`), so its rows navigate there
// directly.
//
// DATA RULE (R6): this file adds NO IPC of its own — only the registry, the
// sync report and the Zustand harness store. Each body module mounts its own
// screen hook (snippets/hooks/subagents/usage/backup) ONLY while its group is
// on screen, by construction (the body component simply is not rendered
// otherwise). See each *Body.tsx file's header comment for the exact keys it
// is allowed to read.

// ─── Persistence ─────────────────────────────────────────────────────────────
const SB_KEY_PIN = "st:sb:pinned";
const SB_KEY_COLLAPSED = "st:sb:collapsed";

export { PIN_KINDS, pinKey, type PinKind };

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Tolerant migration of the stored pin set. A pin key is `kind:id`; ids may
 * themselves contain colons, so only the FIRST colon splits. Keys whose kind is
 * no longer pinnable (`source:` — sources lost their per-item route) are
 * dropped, and the dropped kinds are reported so the panel can say so once
 * instead of silently losing a user's pins.
 */
export function migratePins(raw: unknown): {
  kept: string[];
  droppedKinds: string[];
} {
  const kept: string[] = [];
  const dropped = new Set<string>();
  if (!Array.isArray(raw)) return { kept, droppedKinds: [] };
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const sep = entry.indexOf(":");
    if (sep <= 0 || sep === entry.length - 1) continue;
    const kind = entry.slice(0, sep);
    if ((PIN_KINDS as readonly string[]).includes(kind)) kept.push(entry);
    else dropped.add(kind);
  }
  return { kept, droppedKinds: [...dropped] };
}

/** Every collapse key the contextual panel can write today. The set is closed
 *  on purpose: an unknown key is either a legacy one below or debris, and
 *  re-persisting debris forever is how a preferences blob rots. */
const COLLAPSE_KEYS: ReadonlySet<string> = new Set([
  "context.bundles",
  "context.skills",
  "context.snippets",
  "guardrails.hooks",
  "elsewhere.sources",
  "elsewhere.remotes",
  "elsewhere.cloud",
]);

/** Flat pre-contextual (and pre-GROUP) keys → their namespaced successor, or
 *  `null` where the group no longer exists (Projects is a flat list now;
 *  Sources and Pinned lost their groups entirely). Without this table each
 *  rename silently reset every user's collapse preferences AND kept
 *  re-persisting the dead keys. */
const LEGACY_COLLAPSE_KEYS: Record<string, string | null> = {
  bundles: "context.bundles",
  projects: null,
  sources: null,
  pinned: null,
  "library.bundles": "context.bundles",
  "library.skills": "context.skills",
  "remotes.remotes": "elsewhere.remotes",
  "remotes.cloud": "elsewhere.cloud",
};

export function migrateCollapsed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kept = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (COLLAPSE_KEYS.has(entry)) {
      kept.add(entry);
      continue;
    }
    const mapped = LEGACY_COLLAPSE_KEYS[entry];
    if (mapped) kept.add(mapped);
  }
  return [...kept];
}

function usePersistedSet(
  key: string,
  initial: string[],
): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [set, setSet] = useState<Set<string>>(() => new Set(initial));
  useEffect(() => {
    saveSet(key, set);
  }, [key, set]);
  return [set, (updater) => setSet((prev) => updater(prev))];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** `icons.ts` key per kind — the same glyph the section rail uses, so a chip
 *  reads as "that thing over there" rather than a generic document. */
const RECENT_ICON: Record<RecentType, string> = {
  skill: "skill",
  project: "folder",
  bundle: "bundle",
  hook: "hook",
  harness: "harness",
  remote: "remote",
  cloud: "cloud",
  snippet: "snippet",
};

/** The route segment IS the recorded kind: App.tsx mounts `/<type>/:name` for
 *  every `RecentType` (recent.test pins each one against a real route). */
export function recentHref(item: RecentItem): string {
  return `/${item.type}/${encodeURIComponent(item.name)}`;
}
export function recentIcon(item: RecentItem): string {
  return RECENT_ICON[item.type];
}
function recentActive(item: RecentItem, pathname: string): boolean {
  return pathname === recentHref(item);
}

// ─── Body registry (spec §5.7 — one module per group) ────────────────────────

// `headFor` is a PLAIN function, not a hook (m-8): the old `useXHead` naming
// invited exactly the bug it happened not to trigger — a per-group hook
// function picked at runtime and called unconditionally from ONE component
// instance violates the Rules of Hooks the moment any implementation adds a
// real hook call, and the linter cannot see through the `BODIES[group]`
// indirection to catch it. None of the five need a hook (verified: they read
// only their own `props`), so there is nothing to lose by making that
// structural.
const BODIES: Record<
  GroupId,
  {
    Glance: (props: NavBodyProps) => ReactNode;
    Rows: (props: NavBodyProps) => ReactNode;
    headFor: (props: NavBodyProps) => NavHeadInfo;
  }
> = {
  projects: { Glance: ProjectsGlance, Rows: ProjectsRows, headFor: projectsHead },
  context: { Glance: ContextGlance, Rows: ContextRows, headFor: contextHead },
  guardrails: { Glance: GuardrailsGlance, Rows: GuardrailsRows, headFor: guardrailsHead },
  agents: { Glance: AgentsGlance, Rows: AgentsRows, headFor: agentsHead },
  elsewhere: { Glance: ElsewhereGlance, Rows: ElsewhereRows, headFor: elsewhereHead },
};

// ─── NavPanel ────────────────────────────────────────────────────────────────

interface NavPanelProps {
  /** True while the panel is parked off-canvas (narrow window, drawer closed).
   *  CSS hides it, but a translated-away element still takes Tab focus and is
   *  still announced — `inert` is what actually removes it. */
  inert?: boolean;
  /** True at narrow widths, where the panel is an off-canvas drawer floating
   *  over page content rather than a column under the title bar. The head then
   *  drops its drag region: Tauri reads the ATTRIBUTE, so CSS alone would still
   *  let a press-drag move (and a double-click zoom) the window from y=56. */
  narrow?: boolean;
}

export function NavPanel({
  inert = false,
  narrow = false,
}: NavPanelProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: registry } = useRegistry();
  const { data: syncEnvelope } = useSyncReport();
  const openPalette = useAppStore((s) => s.openPalette);
  const storedRecent = useAppStore((s) => s.recentlyVisited);
  const pushToast = useAppStore((s) => s.pushToast);
  // Read-only: the store is filled by the Harnesses screen / shell rescan. The
  // panel never triggers `harness_list` itself.
  const harnesses = useAppStore((s) => s.harnesses);

  const currentPath = location.pathname;
  const group = groupForLocation(currentPath, location.state);
  // The row that reads as "you are here". On a detail route opened from another
  // section it is the REFERRER's row — a skill opened from a project keeps that
  // project lit — while `currentPath` still gates route-shape checks below.
  const anchorPath = navAnchorPath(currentPath, location.state);
  const meta = GROUP_META[group];
  // `?focus=` deep-links (Sources) live in the query string, not the path — a
  // source has no route of its own. Snippets moved off this pattern once
  // `/snippet/:name` existed.
  const searchParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );

  // Pins: read once, migrated tolerantly, then re-persisted (so a dropped kind
  // never comes back on the next load).
  const [pinMigration] = useState(() => migratePins(readJson(SB_KEY_PIN)));
  const migrationToldRef = useRef(false);
  const [pinned, setPinned] = usePersistedSet(SB_KEY_PIN, pinMigration.kept);
  const [collapsedInitial] = useState(() =>
    migrateCollapsed(readJson(SB_KEY_COLLAPSED)),
  );
  const [collapsed, setCollapsed] = usePersistedSet(
    SB_KEY_COLLAPSED,
    collapsedInitial,
  );
  const [filters, setFilters] = useState<Record<string, string>>({});

  useEffect(() => {
    if (pinMigration.droppedKinds.length === 0) return;
    // StrictMode double-invokes mount effects; the notice must still be ONE.
    if (migrationToldRef.current) return;
    migrationToldRef.current = true;
    const hadSources = pinMigration.droppedKinds.includes("source");
    pushToast({
      kind: "info",
      title: hadSources ? "Source pins were removed" : "Some pins were removed",
      body: hadSources
        ? "Sources are managed on the Sources screen."
        : "Pinning is available for projects and bundles.",
    });
    // Fires once per mount-with-legacy-keys; the set is rewritten by the
    // persistence effect in the same tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePin = (kind: PinKind, id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      const k = pinKey(kind, id);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggleCollapsed = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const filterFor = (key: string) => filters[key] ?? "";
  const setFilter = (key: string, v: string) =>
    setFilters((f) => ({ ...f, [key]: v }));

  // Persisted chips are reconciled against the LIVE registry at render time —
  // a chip for a deleted project must not survive as a link to "not found".
  const recent = useMemo(
    () => resolvableRecent(storedRecent, registry),
    [storedRecent, registry],
  );

  const bodyProps: NavBodyProps = {
    registry,
    syncEnvelope,
    harnesses,
    anchorPath,
    currentPath,
    searchParams,
    locationState: location.state,
    navigate,
    collapsed,
    toggleCollapsed,
    filterFor,
    setFilter,
    pinned,
    togglePin,
  };

  const { Glance, Rows, headFor } = BODIES[group];
  const head = headFor(bodyProps);

  const projectsSearch = useSideSearch(
    group === "projects" && ((head.count ?? 0) > FILTER_THRESHOLD || filterFor("projects"))
      ? { label: "projects", value: filterFor("projects"), onChange: (v) => setFilter("projects", v) }
      : undefined,
    false,
    undefined,
    "side-head-add",
  );

  const { scrollRef, onKeyDown } = useSideNav({
    narrow,
    locationKey: currentPath + location.search,
  });

  return (
    <aside className="app-side" inert={inert}>
      {/* Docked, the head sits in the window's header band over part of the
          title bar, so it is a drag region like the strip beside it (the `+`
          button opts back out in CSS). As a narrow drawer it floats over page
          content instead — no drag region there. It lives OUTSIDE the plate:
          the head is chrome (band), the plate is content. */}
      <div
        className="side-head"
        data-tauri-drag-region={narrow ? undefined : true}
      >
        <span className="side-head-glyph">
          <Icon name={meta.icon} size={13} />
        </span>
        <span className="side-head-name">{meta.label}</span>
        {head.count != null && (
          <span className="side-head-count" title={head.countTitle}>
            {head.count}
          </span>
        )}
        {projectsSearch.trigger}
        {head.add && (
          <button
            type="button"
            className="side-head-add"
            title={head.add.title}
            aria-label={head.add.title}
            onClick={head.add.onClick}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {/* The raised content plate: glance layer + nav + recent + quick-jump
          share one surface (rounded top-left into the chrome frame's corner —
          see shell-nav.css §.side-plate). The glance layer sits OUTSIDE the
          `nav` landmark and does NOT scroll — it is the "read this" layer, not
          part of the navigator (spec §1). */}
      <div className="side-plate">
        <section className="side-dash" aria-label={`${meta.label} overview`}>
          <Glance {...bodyProps} />
        </section>
        <nav className="side-nav" aria-label="Navigator">
          <div
            className="side-scroll"
            role="listbox"
            tabIndex={-1}
            data-section-content={group}
            ref={scrollRef}
            onKeyDown={onKeyDown}
          >
            {projectsSearch.field}
            <Rows {...bodyProps} />
          </div>
        </nav>

        {/* Sticky Recent strip */}
        <div className="side-recent" title="Recently viewed">
          <span className="side-recent-label">Recent</span>
          <div className="side-recent-track">
            <div className="side-recent-chips">
              {recent.length === 0 && (
                <span className="side-recent-empty">nothing yet</span>
              )}
              {recent.map((r) => (
                <button
                  key={r.type + ":" + r.name}
                  type="button"
                  className="side-recent-chip"
                  aria-current={recentActive(r, currentPath) || undefined}
                  onClick={() => navigate(recentHref(r))}
                  title={`${r.type}: ${r.name}`}
                >
                  <Icon name={recentIcon(r)} size={10} />
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Quick-jump */}
        <button
          type="button"
          className="side-foot-btn"
          onClick={() => openPalette()}
          title="Open command palette"
        >
          <Icon name="command" size={12} />
          <span className="lbl">Quick jump</span>
          <span className="kb">
            <Kbd>⌘K</Kbd>
          </span>
        </button>
      </div>
    </aside>
  );
}

export type { SectionId };
