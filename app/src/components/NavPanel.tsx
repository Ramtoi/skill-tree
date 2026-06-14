import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRegistry } from "@/hooks/useRegistry";
import { useAppStore } from "@/store";
import { Icon } from "@/components/Icon";
import { Kbd } from "@/components/Kbd";
import { bundleColor } from "@/components/bundleColors";
import { projectHealth } from "@/lib/projectHealth";
import { syncMinutes } from "@/lib/syncMinutes";
import type { RecentItem, Registry, SourceStatus } from "@/types";

// ── Persistence helpers ────────────────────────────────────────────────
const SB_KEY_PIN = "st:sb:pinned";
const SB_KEY_COLLAPSED = "st:sb:collapsed";

function loadSet(key: string, fallback: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return new Set(fallback);
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : fallback);
  } catch {
    return new Set(fallback);
  }
}
function saveSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* localStorage unavailable */
  }
}
function usePersistedSet(
  key: string,
  defaults: string[],
): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [set, setSet] = useState<Set<string>>(() => loadSet(key, defaults));
  useEffect(() => {
    saveSet(key, set);
  }, [key, set]);
  return [set, (updater) => setSet((prev) => updater(prev))];
}

const pinKey = (kind: string, id: string) => `${kind}:${id}`;

// ── Row primitive (colocated per design D3) ────────────────────────────
interface SideRowProps {
  leading?: ReactNode;
  name: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  onPin?: () => void;
  pinned?: boolean;
  showPin?: boolean;
  compact?: boolean;
  muted?: boolean;
  hint?: ReactNode;
  title?: string;
}

function SideRow({
  leading,
  name,
  count,
  active,
  onClick,
  onPin,
  pinned,
  showPin = true,
  compact,
  muted,
  hint,
  title,
}: SideRowProps) {
  const cls =
    "side-item" +
    (compact ? " is-compact" : "") +
    (muted ? " is-muted" : "") +
    (pinned ? " is-pinned" : "");
  return (
    <button
      type="button"
      className={cls}
      aria-current={active || undefined}
      onClick={onClick}
      title={title}
    >
      {leading}
      <span className="name">{name}</span>
      {hint && <span className="row-hint">{hint}</span>}
      {showPin && onPin && (
        <span
          role="button"
          tabIndex={-1}
          className="pin"
          data-pinned={!!pinned}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          title={pinned ? "Unpin" : "Pin to top"}
          aria-label={pinned ? "Unpin" : "Pin to top"}
        >
          <Icon name="pin" size={11} />
        </span>
      )}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

// ── Group section primitive ────────────────────────────────────────────
interface SideSectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  variant?: "featured";
  quiet?: boolean;
  summary?: string;
  summaryTone?: "ok" | "warn" | "error";
  filter?: string;
  filterOpen?: boolean;
  onToggleFilter?: () => void;
  onChangeFilter?: (v: string) => void;
  showFilter?: boolean;
  children: ReactNode;
}

function SideSection({
  title,
  count,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  variant,
  quiet,
  summary,
  summaryTone,
  filter,
  filterOpen,
  onToggleFilter,
  onChangeFilter,
  showFilter,
  children,
}: SideSectionProps) {
  const cls =
    "side-group" +
    (quiet ? " is-quiet" : "") +
    (variant === "featured" ? " is-featured" : "");
  return (
    <div className={cls} data-collapsed={collapsed || undefined}>
      <div className="side-group-title" onClick={onToggle}>
        <button
          type="button"
          className="chev-btn"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
        >
          <Icon name="chevronDown" size={10} />
        </button>
        <span className="t-name">{title}</span>
        <span className="t-count">{count}</span>
        {collapsed && summary && (
          <span className={`t-summary tone-${summaryTone || "ok"}`}>{summary}</span>
        )}
        <span className="stretch" />
        {!collapsed && showFilter && (
          <button
            type="button"
            className="g-icon"
            title="Filter"
            data-active={filterOpen || undefined}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFilter?.();
            }}
          >
            <Icon name="search" size={11} />
          </button>
        )}
        {!collapsed && onAdd && (
          <button
            type="button"
            className="g-icon"
            title={addTitle}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <Icon name="plus" size={11} />
          </button>
        )}
      </div>

      {!collapsed && filterOpen && (
        <div className="side-filter" onClick={(e) => e.stopPropagation()}>
          <Icon name="search" size={11} />
          <input
            autoFocus
            placeholder={`Filter ${title.toLowerCase()}…`}
            value={filter || ""}
            onChange={(e) => onChangeFilter?.(e.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="clear"
              onClick={() => onChangeFilter?.("")}
              aria-label="Clear filter"
            >
              <Icon name="x" size={9} />
            </button>
          )}
        </div>
      )}

      {!collapsed && <div className="side-group-items">{children}</div>}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────
const LIMIT = 6;

interface NamedItem {
  name: string;
}
function slice<T extends NamedItem>(
  items: T[],
  filterText: string,
  showAll: boolean,
  isActive?: (item: T) => boolean,
): { filtered: T[]; visible: T[]; hidden: number } {
  const q = filterText.toLowerCase().trim();
  const filtered = q ? items.filter((x) => x.name.toLowerCase().includes(q)) : items;
  if (showAll || filtered.length <= LIMIT) {
    return { filtered, visible: filtered, hidden: 0 };
  }
  let visible = filtered.slice(0, LIMIT);
  if (isActive && !visible.some(isActive)) {
    const activeItem = filtered.find(isActive);
    if (activeItem) {
      visible = [...visible.slice(0, LIMIT - 1), activeItem];
    }
  }
  return { filtered, visible, hidden: filtered.length - visible.length };
}

function recentHref(item: RecentItem): string {
  if (item.type === "skill") return `/skill/${encodeURIComponent(item.name)}`;
  return `/${item.type}/${encodeURIComponent(item.name)}`;
}
function recentIcon(item: RecentItem): string {
  if (item.type === "project") return "folder";
  if (item.type === "bundle") return "bundle";
  if (item.type === "source") return "source";
  return "doc";
}
function recentActive(item: RecentItem, pathname: string): boolean {
  return pathname === recentHref(item);
}

function sourceHealthState(status: SourceStatus): "ok" | "stale" | "never" | "error" {
  if (status === "error") return "error";
  if (status === "update-available") return "stale";
  if (status === "syncing" || status === "unknown") return "never";
  return "ok";
}

export type SummaryTone = "ok" | "warn" | "error";

export function computeSourceSummary(
  sources: ReadonlyArray<{ status: SourceStatus }>,
): { tone: SummaryTone; label: string } {
  const err = sources.filter((s) => s.status === "error").length;
  const upd = sources.filter((s) => s.status === "update-available").length;
  if (err > 0) return { tone: "error", label: `${err} error` };
  if (upd > 0) return { tone: "warn", label: `${upd} update` };
  return { tone: "ok", label: "all ok" };
}

interface ResolvedPin {
  kind: "project" | "bundle" | "source";
  id: string;
  name: string;
  count?: number;
  leading: ReactNode;
}

function resolvePinned(
  pinned: Set<string>,
  registry: Registry | undefined,
  sources: Array<{ id: string; name: string; status: SourceStatus; skill_count?: number }>,
): ResolvedPin[] {
  if (!registry) return [];
  const out: ResolvedPin[] = [];
  for (const k of pinned) {
    const sep = k.indexOf(":");
    if (sep <= 0) continue;
    const kind = k.slice(0, sep);
    const id = k.slice(sep + 1);
    if (kind === "project") {
      const proj = registry.projects[id];
      if (!proj) continue;
      out.push({
        kind: "project",
        id,
        name: id,
        count: proj.enabled.length + proj.bundles.length,
        leading: <span className="health" data-state={projectHealth(undefined)} />,
      });
    } else if (kind === "bundle") {
      const b = registry.bundles[id];
      if (!b) continue;
      out.push({
        kind: "bundle",
        id,
        name: id,
        count: b.skills.length,
        leading: (
          <span className="glyph" style={{ color: bundleColor(id) }}>
            {b.icon}
          </span>
        ),
      });
    } else if (kind === "source") {
      const src = sources.find((s) => s.id === id);
      if (!src) continue;
      out.push({
        kind: "source",
        id,
        name: src.name,
        count: src.skill_count,
        leading: <span className="health" data-state={sourceHealthState(src.status)} />,
      });
    }
  }
  return out;
}

// ── NavPanel ───────────────────────────────────────────────────────────
export function NavPanel() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: registry } = useRegistry();
  const openPalette = useAppStore((s) => s.openPalette);
  const recent = useAppStore((s) => s.recentlyVisited);

  const [pinned, setPinned] = usePersistedSet(SB_KEY_PIN, []);
  const [collapsed, setCollapsed] = usePersistedSet(SB_KEY_COLLAPSED, ["sources"]);
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filterOpen, setFilterOpen] = useState<Set<string>>(() => new Set());

  const togglePin = (kind: string, id: string) =>
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
  const toggleShowAll = (g: string) =>
    setShowAll((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const toggleFilter = (g: string) =>
    setFilterOpen((prev) => {
      const next = new Set(prev);
      if (next.has(g)) {
        next.delete(g);
        setFilters((f) => ({ ...f, [g]: "" }));
      } else {
        next.add(g);
      }
      return next;
    });

  const currentPath = location.pathname;

  const projects = useMemo(
    () =>
      registry
        ? Object.entries(registry.projects).map(([name, proj]) => ({ name, ...proj }))
        : [],
    [registry],
  );
  const bundles = useMemo(
    () =>
      registry
        ? Object.entries(registry.bundles).map(([name, b]) => ({ name, ...b }))
        : [],
    [registry],
  );
  // No structured `sources` view wired yet — until external-skill-sources lands,
  // render an empty group with the "+" affordance routing to /sources.
  const sources: Array<{
    id: string;
    name: string;
    status: SourceStatus;
    skill_count?: number;
  }> = useMemo(() => [], []);

  const sortedProjects = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          syncMinutes((a as { lastSync?: string }).lastSync) -
          syncMinutes((b as { lastSync?: string }).lastSync),
      ),
    [projects],
  );

  const pinnedItems = useMemo(
    () => resolvePinned(pinned, registry, sources),
    [pinned, registry, sources],
  );

  const sourceSummary = useMemo(() => computeSourceSummary(sources), [sources]);

  const projSlice = slice(
    sortedProjects,
    filters.projects || "",
    showAll.has("projects"),
    (p) => currentPath === `/project/${encodeURIComponent(p.name)}`,
  );
  const bundleSlice = slice(
    bundles,
    filters.bundles || "",
    showAll.has("bundles"),
    (b) => currentPath === `/bundle/${encodeURIComponent(b.name)}`,
  );
  const sourceSlice = slice(
    sources,
    filters.sources || "",
    showAll.has("sources"),
    (s) => currentPath === `/sources/${encodeURIComponent(s.id)}`,
  );

  const renderPinnedRow = (p: ResolvedPin) => {
    const screen = p.kind === "source" ? "sources" : p.kind;
    const href =
      p.kind === "source"
        ? `/sources/${encodeURIComponent(p.id)}`
        : `/${screen}/${encodeURIComponent(p.id)}`;
    return (
      <SideRow
        key={p.kind + ":" + p.id}
        active={currentPath === href}
        onClick={() => navigate(href)}
        leading={p.leading}
        name={p.name}
        count={p.count}
        hint={<span className="pin-kind">{p.kind}</span>}
        pinned={true}
        onPin={() => togglePin(p.kind, p.id)}
      />
    );
  };

  return (
    <aside className="app-side">
      <div className="side-scroll">
        {/* Pinned */}
        {pinnedItems.length > 0 && (
          <SideSection
            title="Pinned"
            count={pinnedItems.length}
            collapsed={collapsed.has("pinned")}
            onToggle={() => toggleCollapsed("pinned")}
            variant="featured"
          >
            {pinnedItems.map(renderPinnedRow)}
          </SideSection>
        )}

        {/* Projects */}
        <SideSection
          title="Projects"
          count={projects.length}
          collapsed={collapsed.has("projects")}
          onToggle={() => toggleCollapsed("projects")}
          onAdd={() => navigate("/?addProject=1")}
          addTitle="Add project"
          showFilter={projects.length > 6}
          filter={filters.projects}
          filterOpen={filterOpen.has("projects")}
          onToggleFilter={() => toggleFilter("projects")}
          onChangeFilter={(v) => setFilters((f) => ({ ...f, projects: v }))}
        >
          {projSlice.visible.map((p) => {
            const k = pinKey("project", p.name);
            const active = currentPath === `/project/${encodeURIComponent(p.name)}`;
            const eqCount = p.enabled.length + p.bundles.length;
            return (
              <SideRow
                key={p.name}
                active={active}
                onClick={() => navigate(`/project/${encodeURIComponent(p.name)}`)}
                leading={
                  <span
                    className="health"
                    data-state={projectHealth((p as { lastSync?: string }).lastSync)}
                  />
                }
                name={p.name}
                count={eqCount}
                pinned={pinned.has(k)}
                onPin={() => togglePin("project", p.name)}
                title={p.path}
              />
            );
          })}
          {projSlice.hidden > 0 && (
            <button
              type="button"
              className="side-show-more"
              onClick={() => toggleShowAll("projects")}
            >
              <Icon name="chevronDown" size={10} />
              <span>Show {projSlice.hidden} more</span>
            </button>
          )}
          {showAll.has("projects") &&
            projSlice.filtered.length > 6 &&
            projSlice.hidden === 0 && (
              <button
                type="button"
                className="side-show-more"
                onClick={() => toggleShowAll("projects")}
              >
                <Icon name="chevronUp" size={10} />
                <span>Show less</span>
              </button>
            )}
          {projSlice.filtered.length === 0 && filters.projects && (
            <div className="side-empty">No matches.</div>
          )}
        </SideSection>

        {/* Bundles */}
        <SideSection
          title="Bundles"
          count={bundles.length}
          collapsed={collapsed.has("bundles")}
          onToggle={() => toggleCollapsed("bundles")}
          onAdd={() => navigate("/?addBundle=1")}
          addTitle="New bundle"
          showFilter={bundles.length > 6}
          filter={filters.bundles}
          filterOpen={filterOpen.has("bundles")}
          onToggleFilter={() => toggleFilter("bundles")}
          onChangeFilter={(v) => setFilters((f) => ({ ...f, bundles: v }))}
        >
          {bundleSlice.visible.map((b) => {
            const k = pinKey("bundle", b.name);
            const active = currentPath === `/bundle/${encodeURIComponent(b.name)}`;
            return (
              <SideRow
                key={b.name}
                active={active}
                onClick={() => navigate(`/bundle/${encodeURIComponent(b.name)}`)}
                leading={
                  <span className="glyph" style={{ color: bundleColor(b.name) }}>
                    {b.icon}
                  </span>
                }
                name={b.name}
                count={b.skills.length}
                pinned={pinned.has(k)}
                onPin={() => togglePin("bundle", b.name)}
                title={b.description}
              />
            );
          })}
          {bundleSlice.hidden > 0 && (
            <button
              type="button"
              className="side-show-more"
              onClick={() => toggleShowAll("bundles")}
            >
              <Icon name="chevronDown" size={10} />
              <span>Show {bundleSlice.hidden} more</span>
            </button>
          )}
          {bundleSlice.filtered.length === 0 && filters.bundles && (
            <div className="side-empty">No matches.</div>
          )}
        </SideSection>

        {/* Sources */}
        <SideSection
          title="Sources"
          count={sources.length}
          collapsed={collapsed.has("sources")}
          onToggle={() => toggleCollapsed("sources")}
          onAdd={() => navigate("/sources?add=1")}
          addTitle="Add source"
          quiet
          summary={sourceSummary.label}
          summaryTone={sourceSummary.tone}
          showFilter={sources.length > 6}
          filter={filters.sources}
          filterOpen={filterOpen.has("sources")}
          onToggleFilter={() => toggleFilter("sources")}
          onChangeFilter={(v) => setFilters((f) => ({ ...f, sources: v }))}
        >
          <SideRow
            key="all-sources"
            onClick={() => navigate("/sources")}
            active={currentPath === "/sources"}
            leading={
              <span className="glyph">
                <Icon name="source" size={11} />
              </span>
            }
            name="All sources"
            count={sources.length}
            showPin={false}
            muted
          />
          {sourceSlice.visible.map((src) => {
            const k = pinKey("source", src.id);
            return (
              <SideRow
                key={src.id}
                active={currentPath === `/sources/${encodeURIComponent(src.id)}`}
                onClick={() => navigate(`/sources/${encodeURIComponent(src.id)}`)}
                leading={<span className="health" data-state={sourceHealthState(src.status)} />}
                name={src.name}
                count={src.skill_count}
                pinned={pinned.has(k)}
                onPin={() => togglePin("source", src.id)}
                compact
              />
            );
          })}
          {sourceSlice.hidden > 0 && (
            <button
              type="button"
              className="side-show-more"
              onClick={() => toggleShowAll("sources")}
            >
              <Icon name="chevronDown" size={10} />
              <span>Show {sourceSlice.hidden} more</span>
            </button>
          )}
        </SideSection>

        <div style={{ height: 16 }} />
      </div>

      {/* Sticky Recent strip */}
      <div className="side-recent" title="Recently viewed">
        <span className="side-recent-label">Recent</span>
        <div className="side-recent-track">
          <div className="side-recent-chips">
            {recent.length === 0 && (
              <span className="side-recent-empty">— nothing yet —</span>
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
    </aside>
  );
}
