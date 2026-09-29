import { useMemo, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { bundleColor } from "@/components/bundleColors";
import { useSnippets } from "@/hooks/useSnippets";
import { deriveSources } from "@/lib/skillSource";
import {
  contextInsights,
  bundleRowMark,
  snippetRowMark,
  skillRowMark,
} from "@/lib/navInsights";
import type { Registry } from "@/types";
import { SideStats } from "./SideStat";
import { SideAttention } from "./SideAttention";
import { SideDetail, type DetailRow, type DetailLine } from "./SideDetail";
import {
  SideRow,
  bundleRenameMenu,
  SideGroup,
  FILTER_THRESHOLD,
  matches,
  pinKey,
  type NavBodyProps,
  type NavHeadInfo,
} from "./SidePrimitives";

const EMPTY_REGISTRY: Registry = { version: "1", skills: {}, projects: {}, bundles: {} };

/** No count on the Context head (spec §2.2) — several sub-lists share the
 *  group, and a summed total would contradict the group's own tile. */
export function contextHead(): NavHeadInfo {
  return {};
}

export function ContextGlance({ registry }: NavBodyProps) {
  // Mounted ONLY while the context group is on screen — the guardrail R6 the
  // no-fetch tests pin.
  const { data: snippets } = useSnippets({ enabled: true });
  const insights = useMemo(
    () => contextInsights(registry ?? EMPTY_REGISTRY, snippets),
    [registry, snippets],
  );
  return (
    <>
      <SideAttention lines={insights.lines} groupLabel="Context" />
      <SideStats tiles={insights.tiles} />
    </>
  );
}

export function ContextRows({
  registry,
  currentPath,
  anchorPath,
  navigate,
  collapsed,
  toggleCollapsed,
  filterFor,
  setFilter,
  pinned,
  togglePin,
}: NavBodyProps) {
  const reg = registry ?? EMPTY_REGISTRY;
  const { data: snippets } = useSnippets({ enabled: true });
  const sources = useMemo(() => deriveSources(reg), [reg]);

  const bundles = useMemo(() => {
    const rows = Object.entries(reg.bundles ?? {}).map(([name, b]) => ({
      name,
      bundle: b,
      pinned: pinned.has(pinKey("bundle", name)),
    }));
    rows.sort((a, b) =>
      a.pinned === b.pinned ? a.name.localeCompare(b.name) : a.pinned ? -1 : 1,
    );
    return rows;
  }, [reg, pinned]);

  const skills = useMemo(
    () =>
      Object.entries(reg.skills ?? {})
        .map(([name, s]) => ({ name, skill: s }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [reg],
  );

  const onSkillRoute = currentPath.startsWith("/skill/");
  const bq = filterFor("bundles");
  const sq = filterFor("skills");
  const shownBundles = bundles.filter((b) => matches(b.name, bq));
  const shownSkills = skills.filter((s) => matches(s.name, sq));
  const snippetRows = [...(snippets ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const snippetQ = filterFor("snippets");
  const shownSnippets = snippetRows.filter((s) => matches(s.name, snippetQ));

  return (
    <>
      <SideGroup
        title="Bundles"
        count={bundles.length}
        shown={shownBundles.length}
        collapsed={collapsed.has("context.bundles")}
        onToggle={() => toggleCollapsed("context.bundles")}
        onAdd={() => navigate("/?addBundle=1")}
        addTitle="New bundle"
        search={bundles.length > FILTER_THRESHOLD || bq ? { label: "bundles", value: bq, onChange: (v) => setFilter("bundles", v) } : undefined}
      >
        {bundles.length === 0 && (
          <>
            <div className="side-empty">No bundles yet.</div>
            <SideRow
              action
              leading={<Icon name="plus" size={12} />}
              name="New bundle"
              onClick={() => navigate("/?addBundle=1")}
            />
          </>
        )}
        {bundles.length > 0 && shownBundles.length === 0 && (
          <div className="side-empty">No matches.</div>
        )}
        {shownBundles.map(({ name, bundle, pinned: isPinned }) => {
          const href = `/bundle/${encodeURIComponent(name)}`;
          const active = anchorPath === href;
          const mark = bundleRowMark(name, bundle, reg);

          let detail: ReactNode = null;
          if (active) {
            const missing = (bundle.skills ?? []).filter((s) => !reg.skills?.[s]);
            const lines: DetailLine[] = missing.map((m) => ({
              key: `missing-${m}`,
              tone: "error",
              text: `${m} — not in the registry`,
            }));
            const rows: DetailRow[] = [];
            if (bundle.source) {
              const sourceName = sources.find((s) => s.id === bundle.source)?.name ?? bundle.source;
              // Sources is a SECTION ROOT, not an entity detail — a bare jump,
              // no referrer (see DESIGN-CONTEXT-CHROME/CONTRACT.md). The focus
              // id still travels via the `?focus=` query param that Sources
              // itself consumes and carries forward through `withQueryFocus`.
              rows.push({
                key: "source",
                name: `follows ${sourceName}`,
                href: `/sources?focus=${encodeURIComponent(bundle.source)}`,
              });
            }
            if (rows.length > 0 || lines.length > 0) {
              detail = <SideDetail rows={rows} lines={lines} currentPath={currentPath} />;
            }
          }

          return (
            <SideRow
              key={name}
              name={name}
              title={mark.title}
              hint={mark.hint}
              hintTone={mark.hintTone}
              leading={
                <span className="glyph" style={{ color: bundleColor(name) }}>
                  {bundle.icon}
                </span>
              }
              count={bundle.skills?.length}
              countTitle="skills in this bundle"
              active={active}
              // The active row is a toggle: clicking the bundle you are already
              // looking at leaves bundle mode and returns to the plain library.
              onClick={() => navigate(active ? "/" : href)}
              pin={{ pinned: isPinned, onToggle: () => togglePin("bundle", name) }}
              menu={bundleRenameMenu(name, navigate)}
              detail={detail}
            />
          );
        })}
      </SideGroup>

      <SideGroup
        title="Snippets"
        count={snippets?.length}
        shown={snippets ? shownSnippets.length : undefined}
        collapsed={collapsed.has("context.snippets")}
        onToggle={() => toggleCollapsed("context.snippets")}
        onAdd={() => navigate("/snippet/new")}
        addTitle="New snippet"
        search={snippetRows.length > FILTER_THRESHOLD || snippetQ ? { label: "snippets", value: snippetQ, onChange: (v) => setFilter("snippets", v) } : undefined}
      >
        {snippets && snippets.length === 0 && (
          <div className="side-empty">No snippets yet.</div>
        )}
        {snippetRows.length > 0 && shownSnippets.length === 0 && (
          <div className="side-empty">No matches.</div>
        )}
        {shownSnippets.map((s) => {
          const href = `/snippet/${encodeURIComponent(s.name)}`;
          const mark = snippetRowMark(s);
          return (
            <SideRow
              key={s.name}
              name={s.name}
              title={mark.title}
              hint={mark.hint}
              hintTone={mark.hintTone}
              dim={mark.dim}
              active={anchorPath === href}
              onClick={() => navigate(href)}
            />
          );
        })}
      </SideGroup>

      {onSkillRoute && (
        <SideGroup
          title="Skills"
          count={skills.length}
          shown={shownSkills.length}
          collapsed={collapsed.has("context.skills")}
          onToggle={() => toggleCollapsed("context.skills")}
          search={skills.length > FILTER_THRESHOLD || sq ? { label: "skills", value: sq, onChange: (v) => setFilter("skills", v) } : undefined}
        >
          {shownSkills.length === 0 && <div className="side-empty">No matches.</div>}
          {shownSkills.map(({ name, skill }) => {
            const href = `/skill/${encodeURIComponent(name)}`;
            const active = anchorPath === href;
            const mark = skillRowMark(name, skill);

            let detail: ReactNode = null;
            if (active) {
              const rows: DetailRow[] = Object.entries(reg.bundles ?? {})
                .filter(([, b]) => (b.skills ?? []).includes(name))
                .map(([bName, b]) => ({
                  key: bName,
                  leading: (
                    <span className="glyph" style={{ color: bundleColor(bName) }}>
                      {b.icon}
                    </span>
                  ),
                  name: bName,
                  renameBundle: bName,
                  href: `/bundle/${encodeURIComponent(bName)}`,
                }));
              if (rows.length > 0) {
                detail = <SideDetail rows={rows} lines={[]} currentPath={currentPath} />;
              }
            }

            return (
              <SideRow
                key={name}
                name={name}
                title={mark.title}
                hint={mark.hint}
                hintTone={mark.hintTone}
                leading={
                  <span className="glyph">
                    <Icon name={skill.type === "mcp-server" ? "mcp" : "skill"} size={11} />
                  </span>
                }
                active={active}
                onClick={() => navigate(href)}
                detail={detail}
              />
            );
          })}
        </SideGroup>
      )}
    </>
  );
}
