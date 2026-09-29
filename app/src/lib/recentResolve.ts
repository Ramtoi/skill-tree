// ─── Recent chips ↔ live registry ────────────────────────────────────────────
// The Recent strip is PERSISTED (`st:recent`) and nothing ever prunes it, so a
// project you removed, a bundle you deleted, or a skill you archived leaves a
// chip behind forever — and the rail's Projects button and the `g p` chord both
// resolve "most recent project" straight off that list, so they dead-end on a
// screen that says the project does not exist.
//
// The fix is at CONSUMPTION time, not at write time: the store cannot know what
// still exists (it is filled before any registry read), and rewriting the stored
// list would throw away chips that come back when a registry read is merely
// slow or degraded.

import { CLOUD_TARGET_CATALOG } from "@/lib/cloud";
import type { RecentItem, Registry } from "@/types";

/**
 * Does this chip still point at something that exists?
 *
 * `undefined` registry ⇒ **true**: not loaded is not the same as not there, and
 * blanking the strip during a load would make it flicker on every cold start.
 *
 * Kinds the registry does not describe (`hook`, `harness`, `snippet`) pass
 * through — the screens they open own that validation, and a `hook_list` /
 * `snippets_list` round-trip is exactly the IPC the navigator is forbidden to
 * add. `remote` is validated only when the block is present at all, since
 * `remotes:` is legitimately absent from a registry that has never had one.
 */
export function recentResolves(
  item: RecentItem,
  registry: Registry | undefined,
): boolean {
  if (!registry) return true;
  switch (item.type) {
    case "project":
      return item.name in registry.projects;
    case "bundle":
      return item.name in registry.bundles;
    case "skill":
      return item.name in registry.skills;
    case "cloud":
      // A FIXED in-code catalog, so this is free and definitive.
      return CLOUD_TARGET_CATALOG.some((t) => t.id === item.name);
    case "remote":
      return registry.remotes ? item.name in registry.remotes : true;
    case "hook":
    case "harness":
    case "snippet":
      return true;
  }
}

/** The chips worth rendering / navigating to, in recorded order. */
export function resolvableRecent(
  items: RecentItem[],
  registry: Registry | undefined,
): RecentItem[] {
  return items.filter((item) => recentResolves(item, registry));
}
