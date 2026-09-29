import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";

/** Everything a registry WRITE stales. Every `hub …` write runs `_auto_sync()`,
 *  which rewrites state/sync-report.json — so the freshness badge is stale too.
 *  A sync also re-bakes every hook's command, so hook health can change too —
 *  `qk.hooks.doctor()` is invalidated alongside the registry itself. A source
 *  sync can also flip a skill's `source_missing` flag either way, so the
 *  dropped-skills list is staled alongside it. `save_skill_full` rewrites a
 *  SKILL.md body, so the Library's content-search corpus (`useSearchCorpus`)
 *  is staled here too — every `hub …` write reaches this same call. An adopt
 *  (or Keep native) changes what `hub mcp reconcile` reports as detectable,
 *  so the Library's "Detected MCP servers" band is staled alongside it. */
export const REGISTRY_WRITE_KEYS: QueryKey[] = [
  qk.registry(),
  qk.skillRefsGraph(),
  qk.syncReport(),
  qk.hooks.doctor(),
  qk.droppedSkills(),
  qk.searchCorpus(),
  qk.mcpCandidates(),
];

/** Usage composition reads are registry-derived, but kept outside the
 * registry-only list because their payloads have their own family prefixes. */
export const USAGE_COMPOSITION_KEYS: QueryKey[] = [
  qk.usageProjectAll(),
  qk.usageFootprintAll(),
];

export async function invalidateUsageComposition(qc: QueryClient = appQueryClient): Promise<void> {
  await Promise.all(USAGE_COMPOSITION_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Shared tail for `invalidateRegistry` and `invalidateRegistryDerived`:
 *  invalidate every key in `keys` in parallel, then the usage-composition
 *  and companion/invocation families that ride along with any registry
 *  write. */
async function invalidateWriteKeys(qc: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
  await invalidateUsageComposition(qc);
  // A provision/removal changes a skill+project pair's companion verdicts
  // (`ships_with`), but the writer doesn't always know which pair in advance —
  // `skillCompanionsAll()` is the family prefix, so this one call stales every
  // `qk.skillCompanions(...)` combination via React Query's default prefix
  // match. Kept OUT of REGISTRY_WRITE_KEYS itself (that array is pinned
  // verbatim by `test/queryKeys.test.ts`).
  await qc.invalidateQueries({ queryKey: qk.skillCompanionsAll() });
  await qc.invalidateQueries({ queryKey: qk.invocationAll() });
}

/** Everything `invalidateRegistry` invalidates EXCEPT `qk.registry()` itself.
 *  For a caller that just awaited its own `invalidateQueries({ queryKey:
 *  qk.registry() })` — `NewSkillSheet`'s two submit paths, right after `hub
 *  new` / `mcp add` — the registry key was just awaited and is already
 *  fresh. Refetching it again un-awaited would only start a second registry
 *  refetch that `useBundleMembership` then has to `cancelQueries` away, for
 *  no gain. `REGISTRY_WRITE_KEYS` stays untouched (pinned verbatim by
 *  `test/queryKeys.test.ts`) — this filters it instead of slicing a fixed
 *  position, so a future reordering of that array can't silently drop or
 *  duplicate a key here. */
export async function invalidateRegistryDerived(qc: QueryClient = appQueryClient): Promise<void> {
  // `qk.registry()` builds a fresh `["registry"]` array on every call, so a
  // reference-equality `!==` would never match — compare by value instead.
  const registryKey = JSON.stringify(qk.registry());
  const derivedKeys = REGISTRY_WRITE_KEYS.filter((queryKey) => JSON.stringify(queryKey) !== registryKey);
  await invalidateWriteKeys(qc, derivedKeys);
}

export async function invalidateRegistry(qc: QueryClient = appQueryClient): Promise<void> {
  await invalidateWriteKeys(qc, REGISTRY_WRITE_KEYS);
}
