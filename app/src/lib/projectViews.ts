import type { ViewChip } from "@/components/SubheaderViewChips";

/**
 * The project's AREAS — the destinations the project area strip navigates
 * between. Each is a domain of the project (what it equips, what its agents
 * read, what they may run, who they can delegate to), never a rendering of
 * another area's data.
 */
export type ProjectArea = "loadout" | "agent-docs" | "permissions" | "subagents" | "usage";

export const PROJECT_AREAS: Array<ViewChip<ProjectArea>> = [
  { id: "loadout", label: "Loadout", icon: "loadout" },
  { id: "agent-docs", label: "Agent Docs", icon: "view.docs" },
  { id: "permissions", label: "Permissions", icon: "permissions" },
  { id: "subagents", label: "Sub-Agents", icon: "agent" },
  { id: "usage", label: "Usage", icon: "usage" },
];

const AREA_IDS = new Set<string>(PROJECT_AREAS.map((a) => a.id));

/**
 * Resolve a `?tab=` value. Unknown values resolve to nothing so the caller
 * keeps its current state. `tree` is an old deep link to a view that no
 * longer exists; it lands on the loadout.
 */
export function parseProjectTab(raw: string | null): ProjectArea | null {
  if (!raw) return null;
  if (raw === "tree") return "loadout";
  if (AREA_IDS.has(raw)) return raw as ProjectArea;
  return null;
}
