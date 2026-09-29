// ─── Referrer-aware back navigation ──────────────────────────────────────────
// A detail route (`/skill/:name`, `/bundle/:name`) is reachable from several
// surfaces — the library, a project, a bundle, a source, a remote. A back arrow
// hard-wired to the library drops the user out of the context they were working
// in, so the surface that navigates says where it came from and the detail
// screen returns there.
//
// The referrer travels in react-router history state, so it survives back/
// forward and in-place renames, and it is absent (→ fallback) on a deep link,
// a reload, or a palette jump. History state is user-reachable data, not a
// trusted channel: `readBackTarget` validates the shape and rejects anything
// that is not an in-app path.

import { useMemo } from "react";
import { useLocation, type NavigateOptions } from "react-router-dom";
import type { ProjectArea } from "@/lib/projectViews";

export interface BackTarget {
  /** Display name for "Back to X" — a section ("Library") or an identifier
   *  ("notes-vault"). */
  label: string;
  /** In-app route to return to. */
  path: string;
  /** Crumb tokens that replace the detail screen's default trail prefix.
   *  The screen still appends its own identity token. */
  crumbs?: string[];
  /** Opaque payload the destination hands back UNCHANGED when it returns via
   *  this target (H1) — the WHOLE history-state object the originating
   *  screen wants restored (e.g. the Library's `{ libReturn: LibReturn }`,
   *  `libraryReturn.ts`). Never read or shaped here; only carried and
   *  validated as "some plain object or absent" — `backReturnOptions` writes
   *  it straight onto `navigate`'s `state`, unwrapped. */
  restore?: unknown;
}

/** `navigate(path, fromNav(target))` — records `target` as the referrer of the
 *  screen being opened. */
export function fromNav(target: BackTarget): NavigateOptions {
  return { state: { from: target } };
}

function isCrumbList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((c) => typeof c === "string" && !!c)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a referrer out of raw history state. Returns null for anything that
 *  is not a complete, in-app back target. */
export function readBackTarget(state: unknown): BackTarget | null {
  if (!state || typeof state !== "object") return null;
  const from = (state as { from?: unknown }).from;
  if (!from || typeof from !== "object") return null;
  const { label, path, crumbs, restore } = from as Record<string, unknown>;
  if (typeof label !== "string" || !label) return null;
  // Relative or absolute-URL paths would let history state steer navigation
  // off-app; only in-app routes are honoured. `//host` and `/\host` are the
  // protocol-relative spellings.
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  if (crumbs !== undefined && !isCrumbList(crumbs)) return null;
  // H10: `restore` is accepted only as a plain object — any other shape
  // (array, string, function…) invalidates the whole target, same as a
  // malformed `crumbs` does above.
  if (restore !== undefined && !isPlainObject(restore)) return null;
  return {
    label,
    path,
    ...(crumbs ? { crumbs } : {}),
    ...(restore !== undefined ? { restore } : {}),
  };
}

/** `navigate(back.path, backReturnOptions(back))` — carries a referrer's own
 *  restore payload (H1) forward when a screen explicitly navigates back to
 *  it, so the destination sees the same state it would from a real history
 *  pop. `restore` is opaque here (finding 9): whatever whole state object
 *  the ORIGINATING screen wants restored on return travels through
 *  unmodified — `backTarget.ts` never knows it happens to be
 *  `{ libReturn: … }` for the Library. `undefined` (not `{}`) when there is
 *  nothing to carry, so a plain `navigate(back.path)` and
 *  `navigate(back.path, backReturnOptions(back))` behave identically for a
 *  fallback (non-referrer) back target. */
export function backReturnOptions(back: BackTarget): NavigateOptions | undefined {
  return back.restore !== undefined ? { state: back.restore } : undefined;
}

/** The referrer for the current route, or `fallback` when it was opened
 *  without one (deep link, reload, command palette). */
export function useBackTarget(fallback: BackTarget): BackTarget {
  const { state } = useLocation();
  const { label, path, crumbs } = fallback;
  // Callers pass the fallback as an inline literal, so identity is memoized on
  // its VALUES — a back target that re-created itself every render would churn
  // every `useCallback` that closes over it.
  return useMemo(
    () => readBackTarget(state) ?? { label, path, crumbs },
    [state, label, path, crumbs?.join(" ")],
  );
}

/** Referrer describing a project workspace. */
export function projectBackTarget(name: string): BackTarget {
  return {
    label: name,
    path: `/project/${encodeURIComponent(name)}`,
    crumbs: ["project", name],
  };
}

/** Referrer describing a project area. */
export function projectAreaBackTarget(name: string, area: ProjectArea): BackTarget {
	return {
		label: name,
		path: `/project/${encodeURIComponent(name)}?tab=${area}`,
		crumbs: ["project", name, area],
	};
}

/** Referrer describing a bundle editor. */
export function bundleBackTarget(name: string): BackTarget {
  return {
    label: name,
    path: `/bundle/${encodeURIComponent(name)}`,
    crumbs: ["bundle", name],
  };
}

/** Referrer describing a skill editor. */
export function skillBackTarget(name: string): BackTarget {
  return {
    label: name,
    path: `/skill/${encodeURIComponent(name)}`,
    crumbs: ["skill", name],
  };
}

/** Referrer describing a harness's user-global instruction doc. `label` is
 *  the harness's display label ("Claude Code") — this module never looks up
 *  harness identity. */
export function harnessDocBackTarget(harnessId: string, label: string): BackTarget {
  return {
    label,
    path: `/harness/${encodeURIComponent(harnessId)}/doc`,
    crumbs: ["harness", harnessId],
  };
}

/** The snippet create form's in-memory draft, carried home in `restore` so a
 *  reference click is lossless (F11). */
export interface SnippetDraft {
  name: string;
  desc: string;
  tags: string[];
  body: string;
}

/** Referrer describing a snippet editor. An empty (or "new") name is the
 *  create form, which has no identity yet — it carries its draft instead. */
export function snippetBackTarget(name: string, draft?: SnippetDraft): BackTarget {
  if (!name || name === "new") {
    return {
      label: "New snippet",
      path: "/snippet/new",
      crumbs: ["snippet", "new"],
      ...(draft ? { restore: { snippetDraft: draft } } : {}),
    };
  }
  return {
    label: name,
    path: `/snippet/${encodeURIComponent(name)}`,
    crumbs: ["snippet", name],
  };
}

/** Referrer describing a project's Agent Docs area. `rel` — the file open in
 *  the editor pane — rides in `restore`, because the pane's selection is
 *  component state and the route cannot carry it. */
export function projectAgentDocsBackTarget(
  project: string,
  rel?: string | null,
): BackTarget {
  return {
    label: project,
    path: `/project/${encodeURIComponent(project)}?tab=agent-docs`,
    crumbs: ["project", project, "agent docs"],
    ...(rel ? { restore: { adSelected: rel } } : {}),
  };
}

/** Referrer describing a sub-agent editor (F5). The editor is component state
 *  inside `SubagentManager`, so the honest reach differs by scope:
 *    user    → `/harness/<h>?agent=<name>`; the manager's existing `?agent=`
 *              consumer re-opens that agent.
 *    project → `/project/<p>?tab=subagents`, the LIST. The `?agent=`
 *              consumer resolves user-scope agents only this wave, so a
 *              project-scoped param would silently open the wrong thing —
 *              better to land on the list than on a lie. */
export function subagentBackTarget(args: {
  harness: string;
  name: string;
  scope: "user" | "project";
  project?: string | null;
}): BackTarget {
  const { harness, name, scope, project } = args;
  if (scope === "project" && project) {
    return {
      label: project,
      path: `/project/${encodeURIComponent(project)}?tab=subagents`,
      crumbs: ["project", project, "sub-agents"],
    };
  }
  return {
    label: name,
    path: `/harness/${encodeURIComponent(harness)}?agent=${encodeURIComponent(name)}`,
    crumbs: ["harnesses", harness, "sub-agents", name],
  };
}

/** Referrer describing the Usage screen. Both usage drill-down routes fall
 *  back to this on a deep link (design D14.1) — the session route falls back
 *  here too, never to the project route, because a session reached by URL
 *  has no project context to claim. */
export function usageBackTarget(): BackTarget {
  return { label: "Usage", path: "/usage", crumbs: ["usage"] };
}

/** Referrer describing a Usage project drill-down. */
export function usageProjectBackTarget(name: string): BackTarget {
  return {
    label: name,
    path: `/usage/project/${encodeURIComponent(name)}`,
    crumbs: ["usage", name],
  };
}
