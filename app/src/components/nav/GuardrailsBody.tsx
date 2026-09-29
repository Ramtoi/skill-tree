import { useMemo, type ReactNode } from "react";
import { useHookList } from "@/hooks/useHooks";
import { fromNav } from "@/lib/backTarget";
import {
  guardrailsInsights,
  hookRowMark,
  projectPermissionsRowMark,
} from "@/lib/navInsights";
import { companionsIndex, isHookRef } from "@/lib/companions";
import type { Registry } from "@/types";
import { SideStats } from "./SideStat";
import { SideAttention } from "./SideAttention";
import { SideDetail, type DetailRow } from "./SideDetail";
import {
  SideRow,
  SideGroup,
  SideStatic,
  FILTER_THRESHOLD,
  matches,
  selfRow,
  type NavBodyProps,
  type NavHeadInfo,
} from "./SidePrimitives";

const EMPTY_REGISTRY: Registry = { version: "1", skills: {}, projects: {}, bundles: {} };

/** No count on the Guardrails head (spec §2.3). */
export function guardrailsHead(): NavHeadInfo {
  return {};
}

export function GuardrailsGlance({ registry, syncEnvelope }: NavBodyProps) {
  // Mounted ONLY while the guardrails group is on screen — through the SAME
  // key the Hooks screen mounts (react-query dedupes).
  const { data: hookList } = useHookList();
  const insights = useMemo(
    () => guardrailsInsights(registry ?? EMPTY_REGISTRY, syncEnvelope, hookList?.hooks),
    [registry, syncEnvelope, hookList],
  );
  return (
    <>
      <SideAttention lines={insights.lines} groupLabel="Guardrails" />
      <SideStats tiles={insights.tiles} />
    </>
  );
}

export function GuardrailsRows({
  registry,
  currentPath,
  anchorPath,
  navigate,
  collapsed,
  toggleCollapsed,
  filterFor,
  setFilter,
  searchParams,
}: NavBodyProps) {
  const reg = registry ?? EMPTY_REGISTRY;
  const { data: hookList } = useHookList();
  const hooks = useMemo(
    () => [...(hookList?.hooks ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [hookList],
  );
  // A11: the mirror lookup for "shipped by <skill>" — project-independent,
  // same as the Hooks library's own read of `skills.<n>.ships_with`.
  const companions = useMemo(() => companionsIndex(reg), [reg]);

  const q = filterFor("hooks");
  const shown = hooks.filter((h) => matches(h.name, q));

  const projectRows = Object.entries(reg.projects ?? {})
    .filter(([, p]) => p.permissions)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      {/* Never collapsible (no `guardrails.permissions` collapse key): a
          chevron nothing persists would be a dead affordance on content this
          critical. */}
      <SideStatic title="Permissions">
        {selfRow(currentPath, navigate, "permissions", "Permissions", "/permissions")}
        {projectRows.map(([name, project]) => {
          const mark = projectPermissionsRowMark(project);
          const href = `/project/${encodeURIComponent(name)}?tab=permissions`;
          const active =
            currentPath === `/project/${encodeURIComponent(name)}` &&
            searchParams.get("tab") === "permissions";
          return (
            <SideRow
              key={name}
              name={name}
              title={mark.title}
              hint={mark.hint}
              hintTone={mark.hintTone}
              count={mark.count}
              countTitle={mark.countTitle}
              active={active}
              onClick={() =>
                navigate(href, fromNav({ label: "Permissions", path: "/permissions" }))
              }
            />
          );
        })}
      </SideStatic>

      <SideGroup
        title="Hooks"
        count={hookList ? hooks.length : undefined}
        shown={hookList ? shown.length : undefined}
        collapsed={collapsed.has("guardrails.hooks")}
        onToggle={() => toggleCollapsed("guardrails.hooks")}
        onAdd={() => navigate("/hook/new")}
        addTitle="New hook"
        search={hooks.length > FILTER_THRESHOLD || q ? { label: "hooks", value: q, onChange: (v) => setFilter("hooks", v) } : undefined}
      >
        {hookList && hooks.length === 0 && (
          <div className="side-empty">No hooks defined yet.</div>
        )}
        {hooks.length > 0 && shown.length === 0 && (
          <div className="side-empty">No matches.</div>
        )}
        {shown.map((h) => {
          const href = `/hook/${encodeURIComponent(h.name)}`;
          const active = anchorPath === href;
          const shipped = companions.shippedBy("hook", h.name);
          // A18/C5: a ref hook carries no inline `activation` — the mirror
          // only has one to read for an inline declaration.
          const shippedHook = shipped
            ? reg.skills?.[shipped.skill]?.ships_with?.hooks?.find((x) => x.name === h.name)
            : undefined;
          const mark = hookRowMark(
            h,
            shipped
              ? {
                  skill: shipped.skill,
                  activation:
                    shippedHook && !isHookRef(shippedHook) ? shippedHook.activation : undefined,
                }
              : null,
          );

          let detail: ReactNode = null;
          if (active) {
            const rows: DetailRow[] = h.attached_projects.map((pName) => ({
              key: pName,
              name: pName,
              href: `/project/${encodeURIComponent(pName)}`,
              navState: fromNav({ label: h.name, path: `/hook/${encodeURIComponent(h.name)}` }),
            }));
            if (rows.length > 0) {
              detail = <SideDetail rows={rows} lines={[]} currentPath={currentPath} />;
            }
          }

          return (
            <SideRow
              key={h.name}
              name={h.name}
              title={mark.title}
              hint={mark.hint}
              dim={mark.dim}
              leading={<span className="health" data-state={mark.dot} />}
              active={active}
              onClick={() => navigate(href)}
              detail={detail}
            />
          );
        })}
      </SideGroup>
    </>
  );
}
