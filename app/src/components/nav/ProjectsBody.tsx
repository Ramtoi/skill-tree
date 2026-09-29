import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/Icon";
import { FreshnessDot } from "@/components/FreshnessBadge";
import { bundleColor } from "@/components/bundleColors";
import { projectFreshness } from "@/lib/syncFreshness";
import { fromNav } from "@/lib/backTarget";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { qk } from "@/lib/queryKeys";
import { projectsInsights, projectRowMark } from "@/lib/navInsights";
import type { Registry } from "@/types";
import { SideStats } from "./SideStat";
import { SideAttention } from "./SideAttention";
import { SideDetail, type DetailRow, type DetailLine } from "./SideDetail";
import {
  SideRow,
  matches,
  pinKey,
  type NavBodyProps,
  type NavHeadInfo,
} from "./SidePrimitives";

const EMPTY_REGISTRY: Registry = { version: "1", skills: {}, projects: {}, bundles: {} };
type CachedFindings = {
  findings: Array<{ id: string; project: string; observation?: string; moves?: Array<{ label: string }>; review: { project: string; area: string } }>;
  last_scan_at: string | null;
};

export function projectsHead({
  registry,
  navigate,
}: Pick<NavBodyProps, "registry" | "navigate">): NavHeadInfo {
  return {
    count: Object.keys(registry?.projects ?? {}).length,
    countTitle: "registered projects",
    add: { onClick: () => navigate("/?addProject=1"), title: "Add project" },
  };
}

export function ProjectsGlance({ registry, syncEnvelope, harnesses }: NavBodyProps) {
	const findingsCache = useQuery<CachedFindings | undefined>({
		queryKey: qk.usageFindings(null),
		enabled: false,
		queryFn: async () => undefined,
	});
	const insights = useMemo(
		() => projectsInsights(registry ?? EMPTY_REGISTRY, syncEnvelope, harnesses, findingsCache.data),
		[registry, syncEnvelope, harnesses, findingsCache.data],
	);
  return (
    <>
      <SideAttention lines={insights.lines} groupLabel="Projects" />
      <SideStats tiles={insights.tiles} />
    </>
  );
}

export function ProjectsRows({
  registry,
  syncEnvelope,
  harnesses,
  anchorPath,
  currentPath,
  navigate,
  filterFor,
  pinned,
  togglePin,
}: NavBodyProps) {
  const reg = registry ?? EMPTY_REGISTRY;
  const projects = useMemo(() => {
    const rows = Object.entries(reg.projects ?? {}).map(([name, proj]) => ({
      name,
      proj,
      count: resolveActiveSkills(proj, reg).length,
      pinned: pinned.has(pinKey("project", name)),
    }));
    rows.sort((a, b) =>
      a.pinned === b.pinned ? a.name.localeCompare(b.name) : a.pinned ? -1 : 1,
    );
    return rows;
  }, [reg, pinned]);

  const q = filterFor("projects");
  const shown = projects.filter((p) => matches(p.name, q));

  return (
    <>
      {projects.length === 0 && (
        <>
          <div className="side-empty">No projects registered yet.</div>
          <SideRow
            action
            leading={<Icon name="plus" size={12} />}
            name="Add a project"
            onClick={() => navigate("/?addProject=1")}
          />
        </>
      )}
      {projects.length > 0 && shown.length === 0 && (
        <div className="side-empty">No matches.</div>
      )}
      {shown.map(({ name, proj, count, pinned: isPinned }) => {
        const href = `/project/${encodeURIComponent(name)}`;
        const active = anchorPath === href;
        const mark = projectRowMark(name, proj, reg, syncEnvelope, harnesses);

        let detail: ReactNode = null;
        if (active) {
          const record = syncEnvelope?.report?.projects?.[name];
          const bundleNames = (proj.bundles ?? []).filter((b) => reg.bundles?.[b]);
          const rows: DetailRow[] = bundleNames.map((bName) => {
            const bundle = reg.bundles![bName];
            return {
              key: bName,
              leading: (
                <span className="glyph" style={{ color: bundleColor(bName) }}>
                  {bundle.icon}
                </span>
              ),
              name: bName,
              renameBundle: bName,
              count: bundle.skills?.length,
              countTitle: "skills in this bundle",
              href: `/bundle/${encodeURIComponent(bName)}`,
              navState: fromNav({ label: name, path: href }),
            };
          });
          const lines: DetailLine[] = [];
          for (const err of record?.errors ?? []) {
            lines.push({
              key: `err-${err.stage}-${err.message}`,
              tone: "error",
              text: `${err.stage}: ${err.message}`,
            });
          }
          const skipped = record?.skipped_unowned ?? 0;
          if (skipped > 0) {
            lines.push({
              key: "skipped",
              tone: "warn",
              text: `${skipped} link${skipped === 1 ? "" : "s"} owned by another install`,
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
            leading={<FreshnessDot state={projectFreshness(name, syncEnvelope, proj)} size={6} />}
            count={count}
            countTitle="active skills"
            active={active}
            onClick={() => navigate(href)}
            pin={{ pinned: isPinned, onToggle: () => togglePin("project", name) }}
            detail={detail}
          />
        );
      })}
    </>
  );
}
