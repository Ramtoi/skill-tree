import type { BackTarget } from "./backTarget";
import { projectBackTarget } from "./backTarget";
export interface ProjectLoadoutReturn {
  project: string;
  query: string;
  exact: string | null;
  source: string;
  collapsed: string[];
  disclosed: string[];
  panel: "overview" | "library";
  /** Filter text for the Available skills panel. Older history entries omit it. */
  availableQuery: string;
  hooks: boolean;
  scroll: number;
  anchor?: string;
  offset?: number;
  focus: string | null;
}
export function initialLoadoutReturn(project: string): ProjectLoadoutReturn {
  return {
    project,
    query: "",
    exact: null,
    source: "",
    collapsed: [],
    disclosed: [],
    panel: "overview",
    availableQuery: "",
    hooks: false,
    scroll: 0,
    focus: null,
  };
}
export function readLoadoutReturn(
  state: unknown,
  project: string,
): ProjectLoadoutReturn {
  const fallback = initialLoadoutReturn(project);
  if (!state || typeof state !== "object" || !("projectLoadout" in state))
    return fallback;
  const value = state.projectLoadout;
  if (!value || typeof value !== "object") return fallback;
  const v = value as Record<string, unknown>;
  if (
    v.project !== project ||
    typeof v.query !== "string" ||
    typeof v.source !== "string" ||
    !(v.exact === null || typeof v.exact === "string") ||
    !["overview", "library"].includes(String(v.panel)) ||
    typeof v.hooks !== "boolean" ||
    typeof v.scroll !== "number" ||
    !Number.isFinite(v.scroll) ||
    v.scroll < 0 ||
    !(v.focus === null || typeof v.focus === "string")
  )
    return fallback;
  if (
    ![v.collapsed, v.disclosed].every(
      (list) =>
        Array.isArray(list) && list.every((item) => typeof item === "string"),
    )
  )
    return fallback;
  if (v.anchor !== undefined && typeof v.anchor !== "string") return fallback;
  if (
    v.offset !== undefined &&
    (typeof v.offset !== "number" || !Number.isFinite(v.offset))
  )
    return fallback;
  return {
    ...v,
    // The available-skills filter was added after this return payload first
    // shipped. Keep valid old entries restorable instead of rejecting all of
    // their overview state for one absent, optional-at-read field.
    availableQuery: typeof v.availableQuery === "string" ? v.availableQuery : "",
  } as ProjectLoadoutReturn;
}
export function loadoutBackTarget(
  project: string,
  state: ProjectLoadoutReturn,
): BackTarget {
  return { ...projectBackTarget(project), restore: { projectLoadout: state } };
}
