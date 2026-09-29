import { useMemo, type ReactNode } from "react";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { useSubagentList } from "@/hooks/useSubagents";
import { useLocalAgentUsage } from "@/features/usage/useLocalAgentUsage";
import { agentsInsights, harnessRowMark } from "@/lib/navInsights";
import type { SubagentListItem } from "@/lib/subagents";
import { SideStats } from "./SideStat";
import { SideAttention } from "./SideAttention";
import { SideDetail, type DetailLine, type DetailRow } from "./SideDetail";
import { SideRow, SideStatic, selfRow, type NavBodyProps, type NavHeadInfo } from "./SidePrimitives";

/** No count on the Agents head (spec §2.4) — the HARNESSES tile beneath it
 *  already carries `installed/total`, and a head count would duplicate it. */
export function agentsHead(): NavHeadInfo {
  return {};
}

/** Which harnesses this release fetches a sub-agent list for, and only when
 *  installed + enabled globally or by a project + agent support (mirrors
 *  `screens/Harnesses.tsx`'s `ConfigureAffordance` gate). */
function useAgentsSubagentLists(harnesses: NavBodyProps["harnesses"]) {
  const claude = harnesses.find((h) => h.id === "claude-code");
  const codex = harnesses.find((h) => h.id === "codex");
  const claudeReady = !!claude?.installed && (!!claude?.on_globally || !!claude?.used_by_projects.length) && !!claude?.agents?.supported;
  const codexReady = !!codex?.installed && (!!codex?.on_globally || !!codex?.used_by_projects.length) && !!codex?.agents?.supported;
  const claudeQuery = useSubagentList("user", null, claudeReady, "claude-code", {
    refetchOnWindowFocus: false,
  });
  const codexQuery = useSubagentList("user", null, codexReady, "codex", {
    refetchOnWindowFocus: false,
  });
  return useMemo<Partial<Record<string, SubagentListItem[] | undefined>>>(
    () => ({
      "claude-code": claudeQuery.data?.agents,
      codex: codexQuery.data?.agents,
    }),
    [claudeQuery.data, codexQuery.data],
  );
}

export function AgentsGlance({ harnesses }: NavBodyProps) {
  const { latest, snapshot } = useLocalAgentUsage();
  const subagentsByHarness = useAgentsSubagentLists(harnesses);
  const insights = useMemo(
    () =>
      agentsInsights(harnesses, { snapshot, isError: latest.isError }, subagentsByHarness),
    [harnesses, snapshot, latest.isError, subagentsByHarness],
  );
  return (
    <>
      <SideAttention lines={insights.lines} groupLabel="Agents" />
      <SideStats tiles={insights.tiles} />
    </>
  );
}

export function AgentsRows({ harnesses, anchorPath, currentPath, navigate }: NavBodyProps) {
  const subagentsByHarness = useAgentsSubagentLists(harnesses);

  return (
    <>
      {/* Never collapsible (no `agents.harnesses` collapse key) — same
          reasoning as guardrails' Permissions block. */}
      <SideStatic title="Harnesses">
        {selfRow(currentPath, navigate, "harness", "Harnesses", "/harnesses")}
        {harnesses.length === 0 && <div className="side-empty">No harnesses detected.</div>}
        {harnesses.map((h) => {
          const href = `/harness/${encodeURIComponent(h.id)}`;
          const active = anchorPath === href || anchorPath.startsWith(href + "/");
          const list = subagentsByHarness[h.id];
          const mark = harnessRowMark(h, list?.length);
          const state = !h.installed
            ? h.on_globally
              ? "error"
              : "never"
            : h.on_globally
              ? "ok"
              : "stale";

          let detail: ReactNode = null;
          if (active) {
            const rows: DetailRow[] = [];
            if (h.global_doc) {
              rows.push({
                key: "doc",
                name: h.global_doc.split("/").pop() ?? h.global_doc,
                hint: h.global_doc_exists ? undefined : "not created",
                hintTone: h.global_doc_exists ? undefined : "warn",
                href: `/harness/${encodeURIComponent(h.id)}/doc`,
              });
            }
            const lines: DetailLine[] = (list ?? [])
              .filter((a) => !a.valid || a.link?.twin_lost)
              .map((a) => ({
                key: a.name,
                tone: "error",
                text: `${a.name} — ${!a.valid ? "invalid" : "twin lost"}`,
              }));
            if (rows.length > 0 || lines.length > 0) {
              detail = <SideDetail rows={rows} lines={lines} currentPath={currentPath} />;
            }
          }

          return (
            <SideRow
              key={h.id}
              name={h.label}
              title={mark.title}
              hint={mark.hint}
              leading={<HarnessGlyph id={h.id} label={h.label} size={14} decorative />}
              trailing={<span className="health" data-state={state} />}
              dim={!h.installed}
              count={h.used_by_projects.length}
              countTitle="projects using this harness"
              active={active}
              onClick={() => navigate(href)}
              detail={detail}
            />
          );
        })}
      </SideStatic>

      {selfRow(currentPath, navigate, "usage", "Usage", "/usage")}
    </>
  );
}
