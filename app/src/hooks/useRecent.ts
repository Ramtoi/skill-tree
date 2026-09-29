import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "@/store";
import { RECENT_TYPES, type RecentItem, type RecentType } from "@/types";

/**
 * The route segment IS the recorded kind: App.tsx mounts `/<type>/:name` for
 * every `RecentType`, and recent.test pins each kind's href to a real route.
 * Explicit membership, not a regex over "whatever looks like a detail route":
 * the Recent strip may only hold kinds that have a per-item route to go back
 * to. `/permissions` used to be recorded here as a fake `source` chip — a chip
 * whose href pointed nowhere.
 */
const RECENT_TYPE_SET: ReadonlySet<string> = new Set(RECENT_TYPES);

/**
 * Ids that are VERBS, not entity names. `/hook/new` is the hook editor's create
 * route; recording it leaves a persistent chip called "new" that navigates back
 * into a blank form for a hook that was never saved. Scoped per segment rather
 * than globally so a skill legitimately named `new` stays recordable on any
 * route that does not spend that word on a verb.
 */
const RESERVED_IDS: Record<string, ReadonlySet<string>> = {
  skill: new Set(["new"]),
  project: new Set(["new"]),
  bundle: new Set(["new"]),
  hook: new Set(["new"]),
  snippet: new Set(["new"]),
};

/**
 * `/<segment>/<id>` → item. Only the FIRST id segment counts, so a sub-route
 * (`/harness/claude-code/doc`) records the harness rather than a chip named
 * "claude-code/doc". Validation (sentinels, unknown kinds) lives in the store.
 */
export function parsePath(pathname: string): RecentItem | null {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  if (!RECENT_TYPE_SET.has(m[1])) return null;
  const type = m[1] as RecentType;
  let name: string;
  try {
    name = decodeURIComponent(m[2]);
  } catch {
    name = m[2];
  }
  if (name === "" || RESERVED_IDS[m[1]]?.has(name)) return null;
  return { type, name };
}

export function useTrackRecent() {
  const location = useLocation();
  const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);

  useEffect(() => {
    const item = parsePath(location.pathname);
    if (item) addRecentlyVisited(item);
  }, [location.pathname, addRecentlyVisited]);
}
