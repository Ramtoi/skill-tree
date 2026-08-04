import type { ViewChip } from "@/components/SubheaderViewChips";

export type ProjectView =
  | "loadout"
  | "tree"
  | "agent-docs"
  | "permissions"
  | "subagents";

/**
 * Canonical project views shared by the Project workspace, the Agent Docs view,
 * the Project Permissions tab, and the project Sub-Agents tab. Each delegated
 * sub-view renders its own header but reuses this set so switching is consistent
 * and never drifts.
 */
export const PROJECT_VIEWS: Array<ViewChip<ProjectView>> = [
  { id: "loadout", label: "Loadout", icon: "loadout" },
  { id: "tree", label: "Tree", icon: "view.tree" },
  { id: "agent-docs", label: "Agent Docs", icon: "view.docs" },
  { id: "permissions", label: "Permissions", icon: "cog" },
  { id: "subagents", label: "Sub-Agents", icon: "agent" },
];
