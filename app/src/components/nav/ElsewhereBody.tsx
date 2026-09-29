import { useMemo, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { useBackupStatus } from "@/hooks/useBackup";
import { deriveSources } from "@/lib/skillSource";
import { getBundleScope, resolveTargetSkills } from "@/lib/resolveActiveSkills";
import { fromNav } from "@/lib/backTarget";
import { readQueryFocus } from "@/lib/queryFocus";
import { CLOUD_TARGET_CATALOG } from "@/lib/cloud";
import {
  elsewhereInsights,
  sourceRowMark,
  remoteRowMark,
  cloudRowMark,
} from "@/lib/navInsights";
import type { Registry } from "@/types";
import { SideStats } from "./SideStat";
import { SideAttention } from "./SideAttention";
import { SideDetail, type DetailLine, type DetailRow } from "./SideDetail";
import {
  SideRow,
  SideGroup,
  FILTER_THRESHOLD,
  matches,
  selfRow,
  type NavBodyProps,
  type NavHeadInfo,
} from "./SidePrimitives";

const EMPTY_REGISTRY: Registry = { version: "1", skills: {}, projects: {}, bundles: {} };

/** No count on the Elsewhere head (spec §2.5) — the Cloud apps count was a
 *  constant (bug #7); it is gone, not replaced. */
export function elsewhereHead(): NavHeadInfo {
  return {};
}

/** Names requested by a cloud target's equip block, mirroring
 *  `resolveTargetSkills`'s own candidate walk (registry-unknown names + MCP
 *  servers are excluded there; this is the SUPERSET before that filter, so
 *  the difference is exactly what got dropped). */
function cloudRequestedNames(targetId: string, registry: Registry): Set<string> {
  const equip = registry.cloud?.[targetId];
  const requested = new Set<string>();
  if (!equip) return requested;
  if (equip.apply_global_bundles) {
    for (const bundle of Object.values(registry.bundles ?? {})) {
      if (getBundleScope(bundle) === "global") {
        (bundle.skills ?? []).forEach((s) => requested.add(s));
      }
    }
  }
  for (const bName of equip.bundles ?? []) {
    (registry.bundles?.[bName]?.skills ?? []).forEach((s) => requested.add(s));
  }
  (equip.enabled ?? []).forEach((s) => requested.add(s));
  return requested;
}

function cloudDroppedNames(targetId: string, registry: Registry): string[] {
  const requested = cloudRequestedNames(targetId, registry);
  const allowed = new Set(
    resolveTargetSkills(registry.cloud?.[targetId], registry, { excludeMcp: true }),
  );
  return [...requested].filter((n) => !allowed.has(n));
}

export function ElsewhereGlance({ registry, syncEnvelope }: NavBodyProps) {
  // Cache-only: this observer NEVER fetches (`enabled: false`) — it reads
  // whatever the StatusBar's own observer already holds (R6/B1).
  const { data: backupStatus } = useBackupStatus(false);
  const insights = useMemo(
    () => elsewhereInsights(registry ?? EMPTY_REGISTRY, syncEnvelope, backupStatus),
    [registry, syncEnvelope, backupStatus],
  );
  return (
    <>
      <SideAttention lines={insights.lines} groupLabel="Elsewhere" />
      <SideStats tiles={insights.tiles} />
    </>
  );
}

export function ElsewhereRows({
  registry,
  currentPath,
  anchorPath,
  navigate,
  collapsed,
  toggleCollapsed,
  filterFor,
  setFilter,
  searchParams,
  locationState,
}: NavBodyProps) {
  const reg = registry ?? EMPTY_REGISTRY;
  const sources = useMemo(() => deriveSources(reg), [reg]);
  const remotes = useMemo(
    () =>
      Object.entries(reg.remotes ?? {})
        .map(([id, cfg]) => ({
          id,
          connector: cfg.connector ?? "",
          syncEnabled: cfg.sync_enabled !== false,
          count: resolveTargetSkills(cfg, reg).length,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [reg],
  );

  // `?focus=` is stripped by the Sources screen on mount (M-3): once gone,
  // fall back to the durable copy it carries forward in history state.
  const focusedSourceId = searchParams.get("focus") ?? readQueryFocus(locationState);
  const sq = filterFor("sources");
  const rq = filterFor("remotes");
  const cq = filterFor("cloud");
  const shownSources = sources.filter((s) => matches(s.name, sq));
  const shownRemotes = remotes.filter((r) => matches(r.id, rq));
  const shownCloud = CLOUD_TARGET_CATALOG.filter((t) => matches(t.label, cq));

  return (
    <>
      <SideGroup
        title="Sources"
        count={sources.length}
        shown={shownSources.length}
        collapsed={collapsed.has("elsewhere.sources")}
        onToggle={() => toggleCollapsed("elsewhere.sources")}
        search={sources.length > FILTER_THRESHOLD || sq ? { label: "sources", value: sq, onChange: (v) => setFilter("sources", v) } : undefined}
      >
        {sources.length > 0 && shownSources.length === 0 && (
          <div className="side-empty">No matches.</div>
        )}
        {shownSources.map((s) => {
          const active = currentPath === "/sources" && focusedSourceId === s.id;
          const mark = sourceRowMark(s);

          let detail: ReactNode = null;
          if (active) {
            const lines: DetailLine[] = s.error
              ? [{ key: "error", tone: "error", text: s.error }]
              : [];
            const rows: DetailRow[] = Object.entries(reg.bundles ?? {})
              .filter(([, b]) => b.source === s.id)
              .map(([bName]) => ({
                key: bName,
                name: bName,
                renameBundle: bName,
                href: `/bundle/${encodeURIComponent(bName)}`,
                navState: fromNav({ label: s.name, path: "/sources" }),
              }));
            if (rows.length > 0 || lines.length > 0) {
              detail = <SideDetail rows={rows} lines={lines} currentPath={currentPath} />;
            }
          }

          return (
            <SideRow
              key={s.id}
              name={s.name}
              title={mark.title}
              hint={mark.hint}
              hintTone={mark.hintTone}
              dim={mark.dim}
              count={s.skill_count}
              countTitle="skills from this source"
              leading={<span className="health" data-state={mark.dot} />}
              active={active}
              onClick={() => navigate(`/sources?focus=${encodeURIComponent(s.id)}`)}
              detail={detail}
            />
          );
        })}
        <SideRow
          action
          leading={<Icon name="plus" size={12} />}
          name="Add source"
          onClick={() => navigate("/sources?add=1")}
        />
      </SideGroup>

      <SideGroup
        title="Remotes"
        count={remotes.length}
        shown={shownRemotes.length}
        collapsed={collapsed.has("elsewhere.remotes")}
        onToggle={() => toggleCollapsed("elsewhere.remotes")}
        search={remotes.length > FILTER_THRESHOLD || rq ? { label: "remotes", value: rq, onChange: (v) => setFilter("remotes", v) } : undefined}
      >
        {remotes.length === 0 && <div className="side-empty">No remotes configured.</div>}
        {remotes.length > 0 && shownRemotes.length === 0 && (
          <div className="side-empty">No matches.</div>
        )}
        {shownRemotes.map((r) => {
          const href = `/remote/${encodeURIComponent(r.id)}`;
          const mark = remoteRowMark(r.id, r.connector, r.syncEnabled);
          return (
            <SideRow
              key={r.id}
              name={r.id}
              title={mark.title}
              hint={mark.hint}
              dim={mark.dim}
              count={r.count}
              countTitle="skills equipped here"
              active={anchorPath === href}
              onClick={() => navigate(href)}
            />
          );
        })}
        <SideRow
          action
          leading={<Icon name="plus" size={12} />}
          name="Add remote"
          onClick={() => navigate("/remotes?add=1")}
        />
      </SideGroup>

      <SideGroup
        title="Cloud apps"
        collapsed={collapsed.has("elsewhere.cloud")}
        onToggle={() => toggleCollapsed("elsewhere.cloud")}
        search={CLOUD_TARGET_CATALOG.length > FILTER_THRESHOLD || cq ? { label: "cloud apps", value: cq, onChange: (v) => setFilter("cloud", v) } : undefined}
      >
        {shownCloud.map((t) => {
          const href = `/cloud/${encodeURIComponent(t.id)}`;
          const active = anchorPath === href;
          const dropped = cloudDroppedNames(t.id, reg);
          const mark = cloudRowMark(t.id, dropped.length);

          let detail: ReactNode = null;
          if (active && dropped.length > 0) {
            const lines: DetailLine[] = dropped.map((name) => ({
              key: name,
              tone: "error",
              text: `${name} — ${reg.skills?.[name]?.type === "mcp-server" ? "mcp server" : "not in the registry"}`,
            }));
            detail = <SideDetail rows={[]} lines={lines} currentPath={currentPath} />;
          }

          const equipCount = resolveTargetSkills(reg.cloud?.[t.id], reg, {
            excludeMcp: true,
          }).length;

          return (
            <SideRow
              key={t.id}
              name={t.label}
              title={mark.title}
              hint={mark.hint}
              hintTone={mark.hintTone}
              leading={
                <span className="glyph">
                  <Icon name="cloud" size={11} />
                </span>
              }
              count={equipCount}
              countTitle="skills equipped here"
              active={active}
              onClick={() => navigate(href)}
              detail={detail}
            />
          );
        })}
      </SideGroup>

      {selfRow(currentPath, navigate, "archive", "Backup", "/backup")}
    </>
  );
}
